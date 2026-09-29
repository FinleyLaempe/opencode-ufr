import { describe, expect, test } from "bun:test"
import { Breaker, BreakerRegistry } from "../../src/daemon/breaker"
import { FakeClock } from "../support/clock"

const LADDER = [30_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000]
const opts = (c: FakeClock) => ({ tripThreshold: 3, ladderMs: LADDER, probeTimeoutMs: 120_000, now: c.now })
const trip = (b: Breaker) => { b.onRateLimited(); b.onRateLimited(); b.onRateLimited() }

describe("Breaker", () => {
  test("closed allows; trips on the third consecutive rate-limited request", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    expect(b.allow()).toEqual({ allowed: true, retryAfterMs: 0 })
    b.onRateLimited()
    b.onRateLimited()
    expect(b.state()).toBe("closed")
    b.onRateLimited()
    expect(b.state()).toBe("open")
    expect(b.allow()).toEqual({ allowed: false, retryAfterMs: 30_000 })
  })

  test("a success in between resets the count", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    b.onRateLimited()
    b.onRateLimited()
    b.onSuccess()
    b.onRateLimited()
    expect(b.state()).toBe("closed")
  })

  test("half-open admits exactly one probe", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    trip(b)
    c.advance(30_000)
    expect(b.state()).toBe("half_open")
    expect(b.allow().allowed).toBe(true)
    expect(b.allow()).toEqual({ allowed: false, retryAfterMs: 5_000 })
  })

  test("a failed probe escalates one rung; a successful one closes and resets", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    trip(b)
    c.advance(30_000)
    b.allow()
    b.onRateLimited()
    expect(b.level).toBe(1)
    expect(b.retryAfterMs()).toBe(120_000)
    c.advance(120_000)
    b.allow()
    b.onSuccess()
    expect(b.state()).toBe("closed")
    expect(b.level).toBe(0)
  })

  test("regression 2026-09-21: re-tripping from half-open escalates instead of re-opening at rung 1", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    trip(b)
    c.advance(30_000) // half-open, no probe issued
    trip(b) // requests that were already in flight
    expect(b.level).toBe(1)
  })

  test("regression 2026-09-21: a probe that never reports back is retired as a failure", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    trip(b)
    c.advance(30_000)
    expect(b.allow().allowed).toBe(true) // probe out, outcome never arrives
    c.advance(120_001)
    expect(b.allow().allowed).toBe(false)
    expect(b.level).toBe(1)
  })

  test("non-429 failures never count toward the threshold, but clear a probe", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    for (let i = 0; i < 10; i++) b.onOtherFailure()
    expect(b.state()).toBe("closed")
    trip(b)
    c.advance(30_000)
    b.allow()
    b.onOtherFailure()
    expect(b.allow().allowed).toBe(true) // probe slot free again
  })

  test("the ladder stops at the top rung", () => {
    const c = new FakeClock()
    const b = new Breaker(opts(c))
    trip(b)
    for (let i = 0; i < 10; i++) {
      c.advance(b.retryAfterMs())
      b.allow()
      b.onRateLimited()
    }
    expect(b.level).toBe(5)
    expect(b.retryAfterMs()).toBe(3_600_000)
  })

  test("snapshot and restore round-trip", () => {
    const c = new FakeClock()
    const a = new Breaker(opts(c))
    trip(a)
    const b = new Breaker(opts(c))
    b.restore(a.snapshot())
    expect(b.state()).toBe("open")
    expect(b.retryAfterMs()).toBe(30_000)
  })
})

describe("BreakerRegistry", () => {
  test("firstAvailable skips open groups and returns null when all are open", () => {
    const c = new FakeClock()
    const r = new BreakerRegistry(opts(c))
    trip(r.get("glm"))
    expect(r.firstAvailable(["glm", "gemma"])).toBe("gemma")
    trip(r.get("gemma"))
    expect(r.firstAvailable(["glm", "gemma"])).toBeNull()
    expect(r.minRetryAfterMs(["glm", "gemma"])).toBe(30_000)
    expect(r.openGroups()).toEqual(["gemma", "glm"])
  })

  test("snapshot keeps only groups with state worth keeping", () => {
    const c = new FakeClock()
    const r = new BreakerRegistry(opts(c))
    r.get("idle")
    trip(r.get("glm"))
    expect(Object.keys(r.snapshot())).toEqual(["glm"])
    const r2 = new BreakerRegistry(opts(c))
    r2.restore(r.snapshot())
    expect(r2.states().glm).toEqual({ state: "open", level: 0, retryAfterMs: 30_000 })
  })
})
