import { afterEach, describe, expect, test } from "bun:test"
import type { Transport } from "../../src/daemon/transport"
import { errorOf, routerEnv } from "../support/router-env"

type Env = ReturnType<typeof routerEnv>
let env: Env | null = null
const setup = (o?: Parameters<typeof routerEnv>[0]) => (env = routerEnv(o))
afterEach(() => {
  env?.stop()
  env = null
})

const GLM = "glm-5.2-llmlb"
const GEMMA = "gemma-4-31b-llmlb"
const MISTRAL = "mistral-small-4-llmlb"

describe("Router, non-streaming", () => {
  test("answers a request and records its cost", async () => {
    const e = setup()
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).choices[0].message.content).toBe("Hello")
    const row = e.stats.summary(0).byModel[0]!
    expect(row).toMatchObject({ name: GLM, requests: 1, promptTokens: 10, completionTokens: 2 })
    expect(row.costUsd).toBeCloseTo(4.8e-6, 12)
  })

  test("resolves alias spellings before calling UFR", async () => {
    const e = setup()
    await e.chat({ model: "gpt-5.6-llmlb" })
    expect(e.ufr.calls[0]!.model).toBe("openai/gpt-5.6-llmlb")
  })

  test("forwards unknown models unchanged", async () => {
    const e = setup()
    const res = await e.chat({ model: "someones-custom-model" })
    expect(res.status).toBe(200)
    expect(e.ufr.calls[0]!.model).toBe("someones-custom-model")
  })

  test("a request without a model is rejected locally", async () => {
    const e = setup()
    const res = await e.router.handleChat({ messages: [] })
    expect(res.status).toBe(400)
    expect(e.ufr.calls).toHaveLength(0)
  })

  test("a rate-limited key is retried once on another key", async () => {
    const e = setup()
    e.ufr.rateLimitedKeys.add("key-a")
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.ufr.calls.map((c) => c.key)[0]).toBe("key-a")
    expect(e.ufr.calls[1]!.key).not.toBe("key-a")
  })

  test("a walled model falls back down its chain", async () => {
    const e = setup()
    e.ufr.walled.add(GLM)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM, GLM, GEMMA])
    expect(e.breakers.get(GLM).consecutive).toBe(1)
  })

  test("never more than four upstream calls per client request", async () => {
    const e = setup()
    for (const m of [GLM, GEMMA, MISTRAL]) e.ufr.walled.add(m)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).type).toBe("upstream_rate_limited")
    expect(e.ufr.calls).toHaveLength(4)
  })

  test("the breaker opens after three walled client requests, then UFR is left alone", async () => {
    const e = setup()
    e.ufr.walled.add(MISTRAL)
    for (let i = 0; i < 3; i++) expect((await e.chat({ model: MISTRAL })).status).toBe(429)
    const before = e.ufr.calls.length
    const res = await e.chat({ model: MISTRAL })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).type).toBe("upstream_circuit_open")
    expect(res.headers.get("retry-after")).toBe("30")
    expect(e.ufr.calls.length).toBe(before)
  })

  test("the pool cap rejects locally with Retry-After and no upstream call", async () => {
    const e = setup({ config: { limits: { poolPerHour: 2, poolMaxWaitS: 0 } } })
    await e.chat({ model: GLM })
    await e.chat({ model: GLM })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).type).toBe("upstream_pool_cap")
    expect(res.headers.get("retry-after")).toBe("3600")
    expect(e.ufr.calls).toHaveLength(2)
  })

  test("over the pool cap a request waits for its slot instead of failing", async () => {
    const e = setup({ config: { limits: { poolPerHour: 1, poolMaxWaitS: 3600 } } })
    await e.chat({ model: GLM })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.sleeps).toContain(3_600_000)
  })

  test("releases the pool slot when the client goes away while held", async () => {
    const e = setup({ config: { limits: { poolPerHour: 1, poolMaxWaitS: 3600 } } })
    await e.chat({ model: GLM })
    const ac = new AbortController()
    ac.abort()
    const res = await e.chat({ model: GLM }, ac.signal)
    expect(res.status).toBe(499)
    expect(e.ufr.calls).toHaveLength(1)
    expect(e.pool.inWindow()).toBe(1)
  })

  test("with every key at its limit, a request waits up to keyMaxWait", async () => {
    const e = setup({ keys: ["key-a"], config: { limits: { keyRpm: 1 } } })
    await e.chat({ model: GLM })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.sleeps).toContain(60_000)
  })

  test("beyond keyMaxWait the pool of keys reports exhausted", async () => {
    const e = setup({ keys: ["key-a"], config: { limits: { keyRpm: 1, keyMaxWaitS: 0 } } })
    await e.chat({ model: GLM })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).type).toBe("key_pool_exhausted")
    expect(res.headers.get("retry-after")).toBe("60")
  })

  test("an invalid key is marked and the next key is used", async () => {
    const e = setup({ keys: ["wrong", "key-b"] })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.keys.snapshot()[0]!.invalid).toBe(true)
  })

  test("no valid key at all is a 401 no_keys", async () => {
    const e = setup({ keys: ["wrong"] })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(401)
    expect((await errorOf(res)).type).toBe("no_keys")
  })

  test("context overflow returns UFR's own error unless allowPaid", async () => {
    const e = setup()
    e.ufr.contextLimitChars.set(GLM, 5)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("maximum context length")
    expect(e.ufr.calls).toHaveLength(1)
  })

  test("with allowPaid a context overflow hops once to the hub", async () => {
    const e = setup({ config: { allowPaid: true } })
    e.ufr.contextLimitChars.set(GLM, 5)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM, "openai/gpt-5.6-llmlb"])
  })

  test("with allowPaid a context overflow does not hop to a hub whose breaker is open", async () => {
    const e = setup({ config: { allowPaid: true } })
    const HUB = "openai/gpt-5.6-llmlb"
    for (let i = 0; i < 3; i++) e.breakers.get(HUB).onRateLimited()
    expect(e.breakers.get(HUB).state()).toBe("open")
    e.ufr.contextLimitChars.set(GLM, 5)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("maximum context length")
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM])
  })

  test("a context overflow on the last allowed attempt does not take the hub's probe", async () => {
    const e = setup({ config: { allowPaid: true, limits: { maxUpstreamAttempts: 1 } } })
    const HUB = "openai/gpt-5.6-llmlb"
    for (let i = 0; i < 3; i++) e.breakers.get(HUB).onRateLimited()
    e.clock.advance(30_000)
    expect(e.breakers.get(HUB).state()).toBe("half_open")
    e.ufr.contextLimitChars.set(GLM, 5)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("maximum context length")
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM])
    expect(e.breakers.get(HUB).allow().allowed).toBe(true)
  })

  test("off the VPN the client gets 503 transport_unreachable naming the VPN", async () => {
    const e = setup()
    e.ufr.vpnPage = true
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(503)
    const err = await errorOf(res)
    expect(err.type).toBe("transport_unreachable")
    expect(err.message).toContain("VPN")
    expect(e.reach.at(-1)).toMatchObject({ ok: false })
  })

  test("a client that disconnects mid-call gets 499 and is recorded", async () => {
    const e = setup()
    e.ufr.delayMs = 300
    const ac = new AbortController()
    const pending = e.chat({ model: GLM }, ac.signal)
    while (e.ufr.calls.length === 0) await Bun.sleep(1) // the upstream call is in flight
    ac.abort()
    const res = await pending
    expect(res.status).toBe(499)
    expect(e.stats.summary(0).byModel[0]!.errors).toBe(1)
  })

  test("a client abort mid-call resolves the half-open probe instead of wedging it", async () => {
    const e = setup()
    for (let i = 0; i < 3; i++) e.breakers.get(GLM).onRateLimited()
    e.clock.advance(30_000)
    expect(e.breakers.get(GLM).state()).toBe("half_open")
    e.ufr.delayMs = 300
    const ac = new AbortController()
    const pending = e.chat({ model: GLM }, ac.signal)
    while (e.ufr.calls.length === 0) await Bun.sleep(1) // the upstream call is in flight
    ac.abort()
    const res = await pending
    expect(res.status).toBe(499)
    expect(e.ufr.calls).toHaveLength(1)
    expect(e.breakers.get(GLM).state()).toBe("half_open")
    expect(e.breakers.get(GLM).level).toBe(0)
    expect(e.breakers.get(GLM).allow().allowed).toBe(true)
  })

  test("a client gone before the first call resolves the half-open probe", async () => {
    const e = setup()
    for (let i = 0; i < 3; i++) e.breakers.get(GLM).onRateLimited()
    e.clock.advance(30_000)
    const ac = new AbortController()
    ac.abort()
    const res = await e.chat({ model: GLM }, ac.signal)
    expect(res.status).toBe(499)
    expect(e.ufr.calls).toHaveLength(0)
    expect(e.breakers.get(GLM).state()).toBe("half_open")
    expect(e.breakers.get(GLM).allow().allowed).toBe(true)
  })

  test("a call that fails without a client abort is a 503, not client_closed", async () => {
    const broken: Transport = {
      name: "broken",
      fetch: async () =>
        new Response(new ReadableStream({ start: (c) => c.error(new Error("connection reset mid-body")) }), {
          status: 500,
          headers: { "content-type": "application/json" },
        }),
    }
    const e = setup({ transport: broken })
    for (let i = 0; i < 3; i++) e.breakers.get(GLM).onRateLimited()
    e.clock.advance(30_000)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(503)
    const err = await errorOf(res)
    expect(err.type).toBe("transport_unreachable")
    expect(err.message).toContain("connection reset mid-body")
    expect(e.breakers.get(GLM).allow().allowed).toBe(true)
  })

  test("a local rejection does not escalate a half-open breaker", async () => {
    const e = setup({ config: { limits: { poolPerHour: 1, poolMaxWaitS: 0 } } })
    e.breakers.get(GLM).onRateLimited()
    e.breakers.get(GLM).onRateLimited()
    e.breakers.get(GLM).onRateLimited()
    e.clock.advance(30_000)
    await e.chat({ model: GEMMA })
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(429)
    expect((await errorOf(res)).type).toBe("upstream_pool_cap")
    expect(e.breakers.get(GLM).state()).toBe("half_open")
    expect(e.breakers.get(GLM).level).toBe(0)
    expect(e.breakers.get(GLM).allow().allowed).toBe(true)
  })

  test("at the attempt cap the failure is recorded under the last model called", async () => {
    const e = setup()
    for (const m of [GLM, GEMMA, MISTRAL]) e.ufr.walled.add(m)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(429)
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM, GLM, GEMMA, GEMMA])
    const byModel = e.stats.summary(0).byModel
    expect(byModel.find((r) => r.name === GEMMA)).toBeDefined()
    expect(byModel.find((r) => r.name === MISTRAL)).toBeUndefined()
    expect(e.breakers.get(MISTRAL).state()).toBe("closed")
  })
})
