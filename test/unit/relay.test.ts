import { describe, expect, test } from "bun:test"
import { BUDGET_BODY } from "../support/fake-ufr"
import { errorOf, routerEnv } from "../support/router-env"

/** The router's relay route: one raw upstream call with central key pacing. */
const relay = (env: ReturnType<typeof routerEnv>, body: Record<string, unknown>, signal?: AbortSignal) =>
  env.router.handleRelay({ messages: [{ role: "user", content: "Hi" }], ...body }, signal)

describe("handleRelay", () => {
  test("ok: exactly the requested model, usage recorded, raw JSON back", async () => {
    const env = routerEnv()
    const res = await relay(env, { model: "nuextract3-llmlb" })
    expect(res.status).toBe(200)
    const j = (await res.json()) as { model: string; choices: { message: { content: string } }[] }
    expect(j.model).toBe("nuextract3-llmlb")
    expect(j.choices[0]!.message.content).toBe("Hello")
    expect(env.ufr.calls).toHaveLength(1) // one upstream call, no fallbacks
  })

  test("walled model: raw 429 pass-through, no fallback chain, breaker counts it", async () => {
    const env = routerEnv()
    env.ufr.walled.add("nuextract3-llmlb")
    const res = await relay(env, { model: "nuextract3-llmlb" })
    expect(res.status).toBe(429)
    expect(await res.text()).toBe(BUDGET_BODY)
    // The relay must NOT fall back: the caller asked for exactly this model.
    expect(env.ufr.calls).toHaveLength(1)
    expect(env.ufr.calls[0]!.model).toBe("nuextract3-llmlb")
    // Three rate-limited relays trip the breaker (tripThreshold 3).
    await relay(env, { model: "nuextract3-llmlb" })
    await relay(env, { model: "nuextract3-llmlb" })
    const next = await relay(env, { model: "nuextract3-llmlb" })
    expect((await errorOf(next)).type).toBe("upstream_circuit_open")
    expect(env.ufr.calls).toHaveLength(3) // the circuit-open relay never reached UFR
  })

  test("context overflow: UFR's 400 body passes through verbatim, no context-hub hop", async () => {
    const env = routerEnv()
    env.ufr.contextLimitChars.set("nuextract3-llmlb", 100)
    const res = await relay(env, { model: "nuextract3-llmlb", messages: [{ role: "user", content: "x".repeat(5000) }] })
    expect(res.status).toBe(400)
    const body = await res.text()
    expect(body).toContain("maximum context length")
    // The chat path would hop to the context hub (openai/gpt-5.6) here — the relay must not.
    expect(env.ufr.callsFor("openai/gpt-5.6-llmlb")).toHaveLength(0)
    expect(env.ufr.calls).toHaveLength(1)
  })

  test("paced, not failed: a second call inside the key window waits for its slot", async () => {
    const env = routerEnv({ keys: ["key-a"], config: { limits: { keyRpm: 1, keyWindowS: 60, keyMaxWaitS: 60 } } })
    const first = await relay(env, { model: "nuextract3-llmlb" })
    expect(first.status).toBe(200)
    const second = await relay(env, { model: "nuextract3-llmlb" })
    expect(second.status).toBe(200) // waited, not 429
    expect(env.sleeps.length).toBeGreaterThan(0) // the wait went through the gateway's sleep
    expect(env.ufr.calls).toHaveLength(2)
  })

  test("hourly pool cap: reject with 429 and no upstream call", async () => {
    const env = routerEnv({ config: { limits: { poolPerHour: 1, poolWindowS: 3600, poolMaxWaitS: 0 } } })
    await relay(env, { model: "nuextract3-llmlb" })
    const res = await relay(env, { model: "nuextract3-llmlb" })
    expect((await errorOf(res)).type).toBe("upstream_pool_cap")
    expect(env.ufr.calls).toHaveLength(1)
  })

  test("a budget 429 budget-blocks the key for the relay route too", async () => {
    const env = routerEnv({ keys: ["key-a"] })
    env.ufr.rateLimitedKeys.add("key-a")
    await relay(env, { model: "nuextract3-llmlb" })
    expect(env.keys.snapshot()[0]).toMatchObject({ blockedBy: "budget" })
    expect(env.keys.snapshot()[0]!.blockedForMs).toBeGreaterThan(0)
  })

  test("a 400 ExceededBudget body budget-blocks the key and passes the 400 through", async () => {
    const env = routerEnv({ keys: ["key-a"] })
    env.ufr.budgetDeadKeys.add("key-a")
    const res = await relay(env, { model: "nuextract3-llmlb" })
    // The relay is a raw pipe: UFR's own 400 goes back untouched.
    expect(res.status).toBe(400)
    expect(await res.text()).toContain("ExceededBudget")
    expect(env.keys.snapshot()[0]).toMatchObject({ blockedBy: "budget", budgetSpend: 24.0425389, budgetLimit: 20.0 })
  })

  test("streaming is rejected", async () => {
    const env = routerEnv()
    const res = await relay(env, { model: "nuextract3-llmlb", stream: true })
    expect(res.status).toBe(400)
    expect(env.ufr.calls).toHaveLength(0)
  })

  test("unknown model is passed through for UFR to judge", async () => {
    const env = routerEnv()
    const res = await relay(env, { model: "not-a-model-llmlb" })
    // The relay is a raw pipe: no local model validation, UFR's answer verbatim.
    expect(res.status).toBe(200)
    expect(env.ufr.calls[0]!.model).toBe("not-a-model-llmlb")
  })
})
