/**
 * Probe the context limit of every model UFR serves, reusing probe.ts's
 * oversized-request trick: one request above a model's known context makes
 * the server name the exact limit ("maximum context length is N tokens").
 *
 * Cost profile matters here: a REJECTED request is refused before any tokens
 * are priced (measured 2026-10-05: 740 ms, x-process-time 0), so probing a
 * model whose recorded context is still right costs nothing and does not
 * count against the 20/min key bucket. Money is only spent when a probe rung
 * is ACCEPTED (context grew since the last measurement) or a paid model is
 * probed on an accepted rung — which is why paid models are skipped unless
 * asked for.
 */

import type { ModelsFile } from "../shared/models-file"
import type { FetchLike } from "./catalog-source"
import { parseUfrModels } from "./catalog"
import { fillerForTokens, parseLimitFromBody } from "./probe"

/** No UFR model is known to exceed this; probing higher only risks an accepted (paid) rung. */
export const PROBE_CEILING = 1_600_000

export type ProbeHow =
  | "error-named" // the server named the exact limit — the trustworthy result
  | "accepted-floor" // every rung up to `probed` was accepted — `probed` is a lower bound only
  | "rejected-unnamed" // rejected, but the body named no limit
  | "http-error" // something other than 400/413/429 — not a context answer
  | "skipped-paid" // external model, probing costs money
  | "skipped-hidden" // on models.json's exclude list (not user-facing)

export type ProbeRow = {
  id: string
  tier: "free" | "paid"
  known: number | null // value in models.json, null = no entry
  probed: number | null
  how: ProbeHow
  detail?: string
}

export type ProbeAllDeps = {
  baseUrl: string
  key: string
  fetch: FetchLike
  file: ModelsFile // known values + exclude list
  includePaid?: boolean
  /** Pause between models — the per-key bucket is 20/min across ALL models. */
  paceMs?: number
  log: (m: string) => void
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Rungs for one model. Known context → just above it (cheapest reject, minimal
 *  server tokenization). Unknown → one oversized rung: a rejection is free and
 *  names the exact limit, and acceptance only happens for contexts above 1.5M,
 *  which no UFR model has — so a ladder would only ever spend money on accepted
 *  rungs without adding information. */
export function sizesFor(known: number | null): number[] {
  if (known !== null) {
    const out = [known + 64]
    for (let s = 2 * known + 64; s <= PROBE_CEILING && out.length < 3; s *= 2) out.push(s)
    return out
  }
  return [1_500_000]
}

async function probeOne(o: ProbeAllDeps, id: string, known: number | null): Promise<ProbeRow> {
  const doSleep = o.sleep ?? sleep
  const floor = { value: 0 }
  let last = { status: 0, body: "" }
  for (const size of sizesFor(known)) {
    for (let tries = 0; ; tries++) {
      let res: Response
      try {
        res = await o.fetch(`${o.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            model: id,
            max_tokens: 1,
            messages: [{ role: "user", content: fillerForTokens(size) + "\n\nReply with exactly: OK" }],
          }),
          signal: AbortSignal.timeout(180_000),
          redirect: "manual",
        })
      } catch (e) {
        return { id, tier: "free", known, probed: floor.value || null,
          how: floor.value ? "accepted-floor" : "http-error", detail: `transport: ${(e as Error).message}` }
      }
      if (res.ok) {
        const j = (await res.json().catch(() => null)) as { usage?: { prompt_tokens?: number } } | null
        floor.value = j?.usage?.prompt_tokens ?? size
        break // accepted — try the next rung
      }
      const text = await res.text().catch(() => "")
      if (res.status === 429 && tries < 2) {
        o.log(`  ${id}: 429 at ${size} tokens — backing off 20 s`)
        await doSleep(20_000)
        continue // bucket, not a context answer — retry the same rung
      }
      last = { status: res.status, body: text }
      if (res.status === 400 || res.status === 413) {
        const named = parseLimitFromBody(text)
        if (named) return { id, tier: "free", known, probed: named, how: "error-named" }
        return { id, tier: "free", known, probed: floor.value || null,
          how: floor.value ? "accepted-floor" : "rejected-unnamed", detail: text.slice(0, 200) }
      }
      return { id, tier: "free", known, probed: floor.value || null,
        how: floor.value ? "accepted-floor" : "http-error", detail: `HTTP ${res.status}: ${text.slice(0, 200)}` }
    }
  }
  return { id, tier: "free", known, probed: floor.value || null, how: "accepted-floor",
    detail: last.status ? `last: HTTP ${last.status}` : undefined }
}

export async function probeAllContexts(o: ProbeAllDeps): Promise<ProbeRow[]> {
  const res = await o.fetch(`${o.baseUrl}/models`, {
    headers: { Authorization: `Bearer ${o.key}` },
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
  })
  if (!res.ok) throw new Error(`UFR /api/models: HTTP ${res.status}`)
  const ufr = parseUfrModels(await res.json())
  const excluded = new Set(o.file.exclude)
  const rows: ProbeRow[] = []
  for (const m of ufr) {
    if (excluded.has(m.id)) {
      rows.push({ id: m.id, tier: m.tier, known: o.file.models[m.id]?.context ?? null, probed: null, how: "skipped-hidden" })
      continue
    }
    if (m.tier === "paid" && !o.includePaid) {
      rows.push({ id: m.id, tier: "paid", known: o.file.models[m.id]?.context ?? null, probed: null, how: "skipped-paid" })
      continue
    }
    rows.push(await probeOne(o, m.id, o.file.models[m.id]?.context ?? null))
    await (o.sleep ?? sleep)(o.paceMs ?? 3_000) // stay under the 20/min key bucket
  }
  return rows
}

/** Human-readable report; `status` flags what a models.json update would change. */
export function formatProbeReport(rows: ProbeRow[]): string {
  const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length))
  const lines = [
    pad("model", 38) + pad("context", 12) + pad("how", 17) + pad("models.json", 12) + "status",
    "-".repeat(94),
  ]
  let mismatches = 0
  for (const r of rows) {
    const context = r.probed === null ? "—" : r.probed.toLocaleString("en-US")
    const status =
      r.how === "error-named" && r.probed !== null
        ? r.known === null ? "NEW — needs models.json entry" : r.probed === r.known ? "ok" : `MISMATCH (was ${r.known.toLocaleString("en-US")})`
        : r.how
    if (status.startsWith("NEW") || status.startsWith("MISMATCH")) mismatches++
    lines.push(pad(r.id, 38) + pad(context, 12) + pad(r.how, 17) + pad(r.known === null ? "—" : r.known.toLocaleString("en-US"), 12) + status)
  }
  lines.push("-".repeat(94))
  lines.push(`${rows.length} models, ${mismatches} needing a models.json update`)
  return lines.join("\n")
}

/**
 * Applies error-named results to a ModelsFile copy. Only `error-named` is
 * exact; accepted floors are bounds and must not overwrite curated values.
 * Existing notes are kept — a context measurement is appended, a previous
 * context-probe note is replaced.
 */
export function applyProbeResults(
  file: ModelsFile,
  rows: ProbeRow[],
  date: string,
): { file: ModelsFile; changed: { id: string; from: number | null; to: number }[] } {
  const out: ModelsFile = JSON.parse(JSON.stringify(file))
  out.updated = date
  const changed: { id: string; from: number | null; to: number }[] = []
  for (const r of rows) {
    if (r.how !== "error-named" || r.probed === null) continue
    const e = (out.models[r.id] ??= {})
    const from = e.context ?? null
    if (from === r.probed) continue
    e.context = r.probed
    const probeNote = `context ${r.probed} probed live ${date} (probe-all-contexts)`
    e.note = e.note?.includes("probed live") ? probeNote : e.note ? `${e.note} | ${probeNote}` : probeNote
    changed.push({ id: r.id, from, to: r.probed })
  }
  return { file: out, changed }
}
