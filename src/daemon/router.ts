import type { Config } from "../shared/config"
import { errorResponse } from "../shared/errors"
import type { BreakerRegistry } from "./breaker"
import { type Catalog, resolveModel } from "./catalog"
import type { KeyPool } from "./keypool"
import { type Stats, costUsd } from "./stats"
import type { Transport } from "./transport"
import { type UpstreamResult, callUpstream } from "./upstream"
import type { SlidingWindow } from "./window"

export type RouterDeps = {
  config: Config
  catalog: () => Catalog
  keys: KeyPool
  pool: SlidingWindow
  breakers: BreakerRegistry
  stats: Stats
  transport: Transport
  now: () => number
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  onUpstream?: (ok: boolean, message: string) => void
}

type Usage = { prompt: number; completion: number }
type LoopOk = { ok: true; response: Response; model: string; keyAlias: string; attempts: number; upstreamAbort?: AbortController }
type LoopFail = { ok: false; response: Response; model: string; keyAlias: string | null; attempts: number; errorType: string }

export function usageOf(json: unknown): Usage | null {
  const u = (json as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | null)?.usage
  return u ? { prompt: u.prompt_tokens ?? 0, completion: u.completion_tokens ?? 0 } : null
}

function addUsage(a: Usage | null, b: Usage | null): Usage | null {
  if (!a) return b
  if (!b) return a
  return { prompt: a.prompt + b.prompt, completion: a.completion + b.completion }
}

/** Sums two per-call costs; null only when neither call's model had a known price. */
function addCost(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null
  return (a ?? 0) + (b ?? 0)
}

type Choice = { finish_reason?: string; message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null } }

/** glm-5.2 can spend its whole budget thinking and return no text (observed 2026-09-08). */
export function isReasoningStarved(json: unknown): boolean {
  const c = (json as { choices?: Choice[] } | null)?.choices?.[0]
  if (!c || c.finish_reason !== "length") return false
  const content = (c.message?.content ?? "").trim()
  const reasoning = (c.message?.reasoning_content ?? c.message?.reasoning ?? "").trim()
  return content === "" && reasoning !== ""
}

export class Router {
  private active = 0

  constructor(private readonly d: RouterDeps) {}

  /** Client requests being answered right now (streams count until they end). */
  get inFlight(): number {
    return this.active
  }

  async handleChat(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    this.active++
    try {
      return await this.handle(body, signal)
    } finally {
      this.active--
    }
  }

  private async handle(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const t0 = this.d.now()
    const requested = typeof body.model === "string" ? body.model.trim() : ""
    if (!requested) return errorResponse(400, "invalid_request", "body.model is required")
    const cat = this.d.catalog()
    const group = resolveModel(cat, requested)
    const chain = [group, ...(cat.chains.get(group) ?? [])]

    const target = this.d.breakers.firstAvailable(chain)
    if (!target) {
      return this.fail(t0, group, null, 0, false, "upstream_circuit_open",
        errorResponse(429, "upstream_circuit_open",
          `UFR is refusing ${group} and every fallback right now; the gateway waits instead of hammering it`,
          this.d.breakers.minRetryAfterMs(chain)))
    }

    const slot = this.d.pool.reserve()
    if (slot.verdict === "reject") {
      // target's half-open probe (if any) was consumed by firstAvailable above but
      // never gets an outcome — resolve it so the ladder doesn't escalate on a probe timeout.
      this.d.breakers.get(target).onOtherFailure()
      return this.fail(t0, group, null, 0, false, "upstream_pool_cap",
        errorResponse(429, "upstream_pool_cap", `hourly cap of ${this.d.config.limits.poolPerHour} requests reached`, slot.waitMs))
    }
    if (slot.waitMs > 0) {
      try {
        await this.d.sleep(slot.waitMs, signal)
      } catch {
        this.d.pool.release(slot.at)
        this.d.breakers.get(target).onOtherFailure()
        return this.fail(t0, group, null, 0, false, "client_closed",
          errorResponse(499, "client_closed", "client went away while waiting for a slot"))
      }
    }

    const stream = body.stream === true
    const max = this.d.config.limits.maxUpstreamAttempts
    const res = await this.loop(body, group, target, stream, max, signal)
    if (!res.ok) return this.fail(slot.at, res.model, res.keyAlias, res.attempts, true, res.errorType, res.response)
    if (stream) return this.streamOut(slot.at, res)
    return this.jsonOut(slot.at, body, group, res, max, signal)
  }

  /**
   * One raw upstream call for local scripts (context probes, pdf2md): the same
   * central key rotation and soft rate limiting as chat — the caller waits for
   * a key slot instead of being told to back off — but no fallback chain, no
   * context-hub hop and no reasoning retry. The caller gets exactly the model
   * it asked for, with UFR's status and body passed through verbatim: a context
   * probe needs the 400 body that names the limit, and a transcription needs
   * the model it chose, not a fallback. Non-streaming by design.
   */
  async handleRelay(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    this.active++
    try {
      return await this.relayOnce(body, signal)
    } finally {
      this.active--
    }
  }

  private async relayOnce(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    this.active++ // a long-lived relay must be visible in the status inFlight count
    try {
      return await this.relay(body, signal)
    } finally {
      this.active--
    }
  }

  private async relay(body: Record<string, unknown>, signal?: AbortSignal): Promise<Response> {
    const t0 = this.d.now()
    if (body.stream === true) {
      return errorResponse(400, "invalid_request", "/v1/_relay is non-streaming — use /v1/chat/completions for streams")
    }
    const requested = typeof body.model === "string" ? body.model.trim() : ""
    if (!requested) return errorResponse(400, "invalid_request", "body.model is required")
    const cat = this.d.catalog()
    const group = resolveModel(cat, requested)

    if (!this.d.breakers.get(group).allow().allowed) {
      return this.fail(t0, group, null, 0, false, "upstream_circuit_open",
        errorResponse(429, "upstream_circuit_open",
          `UFR is refusing ${group} right now; the gateway waits instead of hammering it`,
          this.d.breakers.get(group).retryAfterMs()))
    }

    const slot = this.d.pool.reserve()
    if (slot.verdict === "reject") {
      // allow() above may have consumed a half-open probe that now never gets
      // an outcome — resolve it so the ladder doesn't escalate on a probe timeout.
      this.d.breakers.get(group).onOtherFailure()
      return this.fail(t0, group, null, 0, false, "upstream_pool_cap",
        errorResponse(429, "upstream_pool_cap", `hourly cap of ${this.d.config.limits.poolPerHour} requests reached`, slot.waitMs))
    }
    if (slot.waitMs > 0) {
      try {
        await this.d.sleep(slot.waitMs, signal)
      } catch {
        this.d.pool.release(slot.at)
        this.d.breakers.get(group).onOtherFailure()
        return this.fail(t0, group, null, 0, false, "client_closed",
          errorResponse(499, "client_closed", "client went away while waiting for a slot"))
      }
    }

    const k = this.d.keys.acquire()
    if (k.kind === "none") {
      this.d.breakers.get(group).onOtherFailure()
      if (k.reason === "no_keys") {
        return this.fail(t0, group, null, 0, true, "no_keys",
          errorResponse(401, "no_keys", "no valid UFR API key configured — reconnect the Uni Freiburg integration in opencode's /connect"))
      }
      // exhausted or all_tried (relay excludes nothing, so all_tried cannot happen — belt and braces)
      return this.fail(t0, group, null, 0, true, "key_pool_exhausted",
        errorResponse(429, "key_pool_exhausted",
          `every UFR key is at its limit of ${this.d.config.limits.keyRpm} requests per ${this.d.config.limits.keyWindowS} s`, k.retryAfterMs))
    }
    if (k.waitMs > 0) {
      try {
        await this.d.sleep(k.waitMs, signal)
      } catch {
        this.d.keys.release(k.alias, k.at)
        this.d.breakers.get(group).onOtherFailure()
        return this.fail(t0, group, null, 0, true, "client_closed",
          errorResponse(499, "client_closed", "client went away while waiting for a key"))
      }
    }

    let r: UpstreamResult
    try {
      r = await callUpstream({
        transport: this.d.transport,
        baseUrl: this.d.config.upstream.baseUrl,
        key: k.secret,
        body: { ...body, model: group },
        timeoutMs: this.d.config.upstream.requestTimeoutS * 1000,
        signal,
        stream: false,
      })
    } catch (e) {
      this.d.breakers.get(group).onOtherFailure() // the call's outcome never came back
      if (signal?.aborted) {
        return this.fail(t0, group, k.alias, 1, true, "client_closed",
          errorResponse(499, "client_closed", "client went away"))
      }
      return this.fail(t0, group, k.alias, 1, true, "transport_unreachable",
        errorResponse(503, "transport_unreachable", `UFR call failed (${e instanceof Error ? e.message : String(e)})`))
    }
    switch (r.kind) {
      case "ok": {
        this.d.breakers.get(group).onSuccess()
        this.d.onUpstream?.(true, "")
        const text = await r.response.text()
        let json: unknown
        try {
          json = JSON.parse(text)
        } catch {
          // Not JSON — pass it through untouched rather than failing a call UFR answered.
          this.record(t0, group, k.alias, 200, null, 1, null, true)
          return new Response(text, { status: 200, headers: { "content-type": r.response.headers.get("content-type") ?? "application/json" } })
        }
        this.record(t0, group, k.alias, 200, usageOf(json), 1, null, true)
        return Response.json(json)
      }
      case "rate_limited":
        // Same body as a bucket 429 — the `budget_exceeded` marker is the only
        // tell (text/plain, 2026-09-28); a merely rate-limited key that carries
        // it is budget-blocked until midnight, which is safe.
        if (r.body.includes("budget_exceeded")) this.d.keys.onBudgetExhausted(k.alias)
        else this.d.keys.onRateLimited(k.alias, group)
        // A wall on the exact model the script asked for — honest breaker signal.
        this.d.breakers.get(group).onRateLimited()
        this.record(t0, group, k.alias, 429, null, 1, "upstream_rate_limited", true)
        return new Response(r.body, { status: 429, headers: { "content-type": "application/json" } })
      case "auth_invalid":
        this.d.keys.onInvalid(k.alias)
        this.d.breakers.get(group).onOtherFailure()
        this.record(t0, group, k.alias, r.status, null, 1, "upstream_auth_invalid", true)
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } })
      case "context_overflow":
        // UFR's own 400 naming the limit — the reason scripts use the relay. Not a wall.
        this.d.breakers.get(group).onOtherFailure()
        this.record(t0, group, k.alias, r.status, null, 1, "context_overflow", true)
        return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } })
      case "unreachable":
        this.d.breakers.get(group).onOtherFailure()
        this.d.onUpstream?.(false, r.message)
        return this.fail(t0, group, k.alias, 1, true, "transport_unreachable", errorResponse(503, "transport_unreachable", r.message))
      case "error":
        this.d.breakers.get(group).onOtherFailure()
        this.record(t0, group, k.alias, r.status, null, 1, `upstream_${r.status}`, true)
        return new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } })
    }
  }

  /** Upstream calls for one client request: other key, next model, context hub. */
  private async loop(
    body: Record<string, unknown>,
    group: string,
    start: string,
    stream: boolean,
    maxAttempts: number,
    signal?: AbortSignal,
  ): Promise<LoopOk | LoopFail> {
    const { config, keys, breakers } = this.d
    const cat = this.d.catalog()
    let model = start
    let attempts = 0
    let lastKey: string | null = null
    let rateLimitedHere = false
    let contextHopped = false
    const tried = new Set<string>()
    const counted = new Set<string>()
    const giveUp = (m: string) => {
      if (counted.has(m)) return
      counted.add(m)
      breakers.get(m).onRateLimited() // once per client request per group
    }
    const moveOn = (): boolean => {
      const next = this.nextModel(model, group)
      if (!next) return false
      model = next
      tried.clear()
      rateLimitedHere = false
      return true
    }
    const fail = (status: number, type: string, message: string, retryAfterMs?: number): LoopFail => ({
      ok: false,
      response: errorResponse(status, type, message, retryAfterMs),
      model,
      keyAlias: lastKey,
      attempts,
      errorType: type,
    })

    while (attempts < maxAttempts) {
      if (signal?.aborted) {
        breakers.get(model).onOtherFailure() // model's probe (if any) got no outcome
        return fail(499, "client_closed", "client went away")
      }
      const k = keys.acquire(tried)
      if (k.kind === "none") {
        if (k.reason === "no_keys") {
          breakers.get(model).onOtherFailure() // model's probe (if any) got no outcome
          return fail(401, "no_keys", "no valid UFR API key configured — reconnect the Uni Freiburg integration in opencode's /connect")
        }
        if (k.reason === "exhausted") {
          breakers.get(model).onOtherFailure() // model's probe (if any) got no outcome
          if (rateLimitedHere) giveUp(model) // the wall counts toward the breaker threshold even here
          // The two messages tell the user very different remedies: wait a minute
          // vs. wait for midnight. The pool alone cannot tell why a key is
          // blocked, so read it off the snapshot's budget marker.
          const budgeted = keys.snapshot().some((s) => s.blockedBy === "budget")
          return fail(429, "key_pool_exhausted",
            budgeted
              ? "a UFR key has exhausted its daily budget (resets at local midnight)"
              : `every UFR key is at its limit of ${config.limits.keyRpm} requests per ${config.limits.keyWindowS} s`,
            k.retryAfterMs)
        }
        // all_tried: every usable key already failed on this model
        if (rateLimitedHere) giveUp(model)
        if (!moveOn()) break
        continue
      }
      if (k.waitMs > 0) {
        try {
          await this.d.sleep(k.waitMs, signal)
        } catch {
          keys.release(k.alias, k.at)
          breakers.get(model).onOtherFailure() // model's probe (if any) got no outcome
          return fail(499, "client_closed", "client went away while waiting for a key")
        }
      }
      attempts++
      tried.add(k.alias)
      lastKey = k.alias
      const upstreamBody: Record<string, unknown> = { ...body, model }
      if (stream) {
        // Only spread a real object — a client sending stream_options as a
        // string (or array) would otherwise be spread into garbage upstream.
        const so = body.stream_options
        const opts =
          typeof so === "object" && so !== null && !Array.isArray(so) ? (so as Record<string, unknown>) : {}
        upstreamBody.stream_options = { ...opts, include_usage: true }
      }
      // Bun's fetch does not propagate a body reader's cancel() into aborting the
      // underlying request — give streaming attempts their own controller so
      // streamOut can actually cancel UFR when the client goes away.
      const upstreamAbort = stream ? new AbortController() : null
      const attemptSignal = upstreamAbort ? (signal ? AbortSignal.any([signal, upstreamAbort.signal]) : upstreamAbort.signal) : signal
      let r: UpstreamResult
      try {
        r = await callUpstream({
          transport: this.d.transport,
          baseUrl: config.upstream.baseUrl,
          key: k.secret,
          body: upstreamBody,
          timeoutMs: config.upstream.requestTimeoutS * 1000,
          signal: attemptSignal,
          stream,
        })
      } catch (e) {
        breakers.get(model).onOtherFailure() // model's probe (if any) got no outcome
        if (signal?.aborted) return fail(499, "client_closed", "client went away")
        // Not the client: something else escaped callUpstream (e.g. the connection
        // dropped while the error body was read) — an upstream failure.
        return fail(503, "transport_unreachable", `UFR call failed (${e instanceof Error ? e.message : String(e)})`)
      }
      switch (r.kind) {
        case "ok":
          breakers.get(model).onSuccess()
          this.d.onUpstream?.(true, "")
          return { ok: true, response: r.response, model, keyAlias: k.alias, attempts, upstreamAbort: upstreamAbort ?? undefined }
        case "rate_limited":
          // UFR's daily-budget 429 and its bucket 429 share one body — the
          // `budget_exceeded` marker is the only tell (text/plain, 2026-09-28).
          // A bucket 429 carrying it budget-blocks a merely rate-limited key:
          // acceptable, that clears at midnight too.
          if (r.body.includes("budget_exceeded")) keys.onBudgetExhausted(k.alias)
          else keys.onRateLimited(k.alias, model)
          rateLimitedHere = true
          if (tried.size >= Math.min(2, keys.size)) {
            giveUp(model)
            // At the attempt cap, don't advance to (and consume the probe of) a model
            // that will never actually be called — let the while-condition end the loop
            // and report the failure under the model that was really tried.
            if (attempts < maxAttempts && !moveOn()) {
              return fail(429, "upstream_rate_limited", `UFR rate-limited ${group} on every key and fallback tried`)
            }
          }
          continue
        case "auth_invalid":
          keys.onInvalid(k.alias)
          continue
        case "context_overflow": {
          // UFR answered this model with its own 400 — not a wall, so this resolves
          // its probe (if any) as evidence rather than leaving it to time out.
          breakers.get(model).onOtherFailure()
          const hub = cat.contextChains.get(model)?.[0]
          // The hub has its own breaker; at the attempt cap it would never be called,
          // so don't take (and wedge) its half-open probe.
          if (hub && !contextHopped && attempts < maxAttempts && breakers.get(hub).allow().allowed) {
            contextHopped = true
            model = hub
            tried.clear()
            rateLimitedHere = false
            continue
          }
          return { ok: false, response: new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } }),
            model, keyAlias: k.alias, attempts, errorType: "context_overflow" }
        }
        case "unreachable":
          breakers.get(model).onOtherFailure()
          this.d.onUpstream?.(false, r.message)
          return fail(503, "transport_unreachable", r.message)
        case "error":
          breakers.get(model).onOtherFailure()
          return { ok: false, response: new Response(r.body, { status: r.status, headers: { "content-type": r.contentType } }),
            model, keyAlias: k.alias, attempts, errorType: `upstream_${r.status}` }
      }
    }
    if (rateLimitedHere) giveUp(model)
    return fail(429, "upstream_rate_limited", `UFR rate-limited ${group}; gave up after ${attempts} upstream calls`)
  }

  private nextModel(current: string, group: string): string | null {
    const cat = this.d.catalog()
    const chain = [group, ...(cat.chains.get(group) ?? [])]
    const i = chain.indexOf(current)
    if (i < 0) return null
    for (const m of chain.slice(i + 1)) if (this.d.breakers.get(m).allow().allowed) return m
    return null
  }

  private async jsonOut(ts: number, body: Record<string, unknown>, group: string, res: LoopOk, max: number, signal?: AbortSignal): Promise<Response> {
    let json: unknown
    try {
      json = await res.response.json()
    } catch {
      // A malformed 200 must not escape handleChat as Bun's default 500 with the
      // pool slot never released — turn it into an honest error and give the slot
      // back (poolAdmitted false: the released slot must not seed a phantom
      // admission in the window rebuilt from stats after a restart).
      this.d.pool.release(ts)
      if (signal?.aborted) {
        // A client abort during the body transfer also rejects json() — that is
        // not bad upstream JSON: the call really happened, so record it as the
        // client's doing, in the same shape as the other client-abort paths.
        return this.fail(ts, res.model, res.keyAlias, res.attempts, false, "client_closed",
          errorResponse(499, "client_closed", "client went away while the response body was transferred"))
      }
      return this.fail(ts, res.model, res.keyAlias, res.attempts, false, "upstream_bad_json",
        errorResponse(502, "upstream_bad_json", "UFR answered 200 with a body that is not valid JSON"))
    }
    let usage = usageOf(json)
    let cost = usage ? costUsd(this.priceOf(res.model), usage.prompt, usage.completion) : null
    let attempts = res.attempts
    let model = res.model
    let keyAlias = res.keyAlias
    let retryErrorType: string | null = null
    if (isReasoningStarved(json) && attempts < max) {
      // The retry is a real upstream call, so it takes a pool slot under the same
      // acquire/wait/abort semantics as the main path — it must not evade the
      // poolPerHour cap. When the pool cannot give one (rejected, or the client
      // went away while waiting), keep the starved answer instead of failing.
      const slot = this.d.pool.reserve()
      let mayRetry = slot.verdict !== "reject"
      if (mayRetry && slot.waitMs > 0) {
        try {
          await this.d.sleep(slot.waitMs, signal)
        } catch {
          this.d.pool.release(slot.at)
          mayRetry = false
        }
      }
      if (mayRetry) {
        const retry = await this.loop({ ...body, reasoning_effort: "none" }, group, res.model, false, max - attempts, signal)
        attempts += retry.attempts
        if (retry.ok) {
          try {
            const again: unknown = await retry.response.json()
            const u2 = usageOf(again)
            // Price each call at the model it was actually answered by — a retry that
            // falls back must not price the first call at the fallback's rate.
            cost = addCost(cost, u2 ? costUsd(this.priceOf(retry.model), u2.prompt, u2.completion) : null)
            usage = addUsage(usage, u2)
            if (!isReasoningStarved(again)) {
              json = again
              model = retry.model
              keyAlias = retry.keyAlias
            }
          } catch {
            retryErrorType = "reasoning_retry_failed"
          }
        } else {
          // The client still gets the starved 200 (intended graceful degradation),
          // but the failed retry must show in stats instead of a clean errorType null.
          retryErrorType = "reasoning_retry_failed"
        }
      }
    }
    this.record(ts, model, keyAlias, 200, usage, attempts, retryErrorType, true, cost)
    return Response.json(json)
  }

  private priceOf(model: string) {
    return this.d.catalog().models.get(model)?.price ?? null
  }

  /** Byte-for-byte pass-through; records the usage chunk; cancelling cancels UFR. */
  private streamOut(ts: number, res: LoopOk): Response {
    const reader = res.response.body!.getReader()
    const decoder = new TextDecoder()
    let buf = ""
    let usage: Usage | null = null
    let finished = false
    this.active++ // handleChat's own count ends when it returns; the stream keeps one until it is done
    const finish = (errorType: string | null) => {
      if (finished) return
      finished = true
      this.active--
      this.record(ts, res.model, res.keyAlias, 200, usage, res.attempts, errorType, true)
    }
    const scan = (chunk: Uint8Array) => {
      buf += decoder.decode(chunk, { stream: true })
      let nl: number
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith("data:")) continue
        const data = line.slice(5).trim()
        if (!data || data === "[DONE]") continue
        try {
          const u = usageOf(JSON.parse(data))
          if (u) usage = u
        } catch {
          // not JSON: pass it through untouched
        }
      }
    }
    const out = new ReadableStream<Uint8Array>({
      pull: async (ctl) => {
        try {
          const { value, done } = await reader.read()
          if (done) {
            finish(null)
            ctl.close()
            return
          }
          scan(value)
          ctl.enqueue(value)
        } catch (e) {
          finish("stream_error")
          ctl.error(e)
        }
      },
      cancel: async (reason) => {
        finish("client_closed")
        res.upstreamAbort?.abort() // reader.cancel() alone does not abort the upstream fetch on Bun
        await reader.cancel(reason).catch(() => {})
      },
    })
    return new Response(out, { status: 200, headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } })
  }

  /** costOverride, when passed, is used as-is (e.g. a reasoning retry's own per-call sum);
   *  otherwise cost is derived from `model`'s price, as for every other single-call outcome. */
  private record(ts: number, model: string, keyAlias: string | null, status: number, usage: Usage | null,
    attempts: number, errorType: string | null, poolAdmitted: boolean, costOverride?: number | null): void {
    const cost = costOverride !== undefined ? costOverride : (usage ? costUsd(this.priceOf(model), usage.prompt, usage.completion) : null)
    this.d.stats.record({
      ts,
      model,
      keyAlias,
      status,
      promptTokens: usage?.prompt ?? 0,
      completionTokens: usage?.completion ?? 0,
      costUsd: cost,
      latencyMs: Math.max(0, this.d.now() - ts),
      attempts,
      errorType,
      poolAdmitted,
    })
  }

  private fail(ts: number, model: string, keyAlias: string | null, attempts: number, poolAdmitted: boolean,
    errorType: string, response: Response): Response {
    this.record(ts, model, keyAlias, response.status, null, attempts, errorType, poolAdmitted)
    return response
  }
}
