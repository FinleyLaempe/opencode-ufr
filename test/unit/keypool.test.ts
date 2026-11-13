import { describe, expect, test } from "bun:test"
import { INVALID_KEY_TTL_MS, KeyPool } from "../../src/daemon/keypool"
import { FakeClock } from "../support/clock"

const mk = (c: FakeClock, n = 3, cap = 18, maxWaitMs = 60_000) =>
  new KeyPool(
    Array.from({ length: n }, (_, i) => ({ alias: `k${i + 1}`, secret: `s${i + 1}` })),
    { cap, windowMs: 60_000, maxWaitMs, now: c.now },
  )

const alias = (r: ReturnType<KeyPool["acquire"]>) => (r.kind === "ok" ? r.alias : `none:${r.reason}`)

describe("KeyPool", () => {
  test("requests drain key 1 before touching key 2", () => {
    const c = new FakeClock()
    const p = mk(c)
    expect(alias(p.acquire())).toBe("k1")
    expect(alias(p.acquire())).toBe("k1")
    expect(alias(p.acquire())).toBe("k1")
  })

  test("a drained key hands over to the next, and takes over again after the reset", () => {
    const c = new FakeClock()
    const p = mk(c, 2)
    p.onBudgetExhausted("k1")
    expect(alias(p.acquire())).toBe("k2")
    expect(alias(p.acquire())).toBe("k2")
    c.advance(24 * 3_600_000) // the 02:00 reset has passed
    expect(alias(p.acquire())).toBe("k1")
  })

  test("a full key hands over to the next key", () => {
    const c = new FakeClock()
    const p = mk(c, 2, 2)
    p.acquire() // k1: 1/2
    p.acquire() // k1: 2/2
    expect(alias(p.acquire())).toBe("k2") // k1's window is full → next key
  })

  test("a full key queues until its oldest request is one window old", () => {
    const c = new FakeClock()
    const p = mk(c, 1, 2)
    const t0 = c.now()
    p.acquire()
    c.advance(10_000)
    p.acquire()
    expect(p.acquire()).toEqual({ kind: "ok", alias: "k1", secret: "s1", waitMs: 50_000, at: t0 + 60_000 })
  })

  test("beyond keyMaxWait the pool is exhausted, with the time to wait", () => {
    const c = new FakeClock()
    const p = mk(c, 1, 1, 0)
    p.acquire()
    expect(p.acquire()).toEqual({ kind: "none", reason: "exhausted", retryAfterMs: 60_000 })
  })

  test("a 429 on a single model does not block the key (that is the breaker's job)", () => {
    const c = new FakeClock()
    const p = mk(c, 1)
    p.acquire()
    p.onRateLimited("k1", "glm-5.2-llmlb")
    expect(p.acquire()).toMatchObject({ kind: "ok", alias: "k1", waitMs: 0 })
  })

  test("429s on two different models block the key until its window frees", () => {
    const c = new FakeClock()
    const p = mk(c, 2)
    p.acquire(new Set(["k2"]))
    p.onRateLimited("k1", "glm-5.2-llmlb")
    c.advance(1_000)
    p.acquire(new Set(["k2"]))
    p.onRateLimited("k1", "gemma-4-31b-llmlb")
    expect(p.snapshot().find((s) => s.alias === "k1")?.blockedForMs).toBe(59_000)
    expect(alias(p.acquire())).toBe("k2")
  })

  test("a 429 after using half of our own budget blocks the key", () => {
    const c = new FakeClock()
    const p = mk(c, 1, 4)
    p.acquire()
    p.acquire()
    p.onRateLimited("k1", "glm-5.2-llmlb")
    expect(p.snapshot()[0]!.blockedForMs).toBe(60_000)
  })

  test("a budget block lasts until the next 02:00, then the key is usable again", () => {
    const c = new FakeClock()
    c.t = new Date(2026, 9, 7, 14, 30).getTime() // mid-day local
    const p = mk(c, 1)
    p.onBudgetExhausted("k1")
    const reset = new Date(2026, 9, 8, 2).getTime() // next 02:00 local
    expect(p.snapshot()[0]!.blockedForMs).toBe(reset - c.t)
    expect(p.snapshot()[0]!.blockedBy).toBe("budget")
    expect(alias(p.acquire())).toBe("none:exhausted")
    c.advance(reset - c.t)
    expect(p.snapshot()[0]!.blockedForMs).toBe(0)
    expect(p.snapshot()[0]!.blockedBy).toBeNull()
    expect(alias(p.acquire())).toBe("k1")
  })

  test("a budget block set exactly at the reset time runs to the following reset", () => {
    const c = new FakeClock()
    c.t = new Date(2026, 9, 8, 2).getTime() // 02:00 local
    const p = mk(c, 1)
    p.onBudgetExhausted("k1")
    expect(p.snapshot()[0]!.blockedForMs).toBe(24 * 3_600_000)
  })

  test("a budget block with parsed spend exposes it on the snapshot, only while blocked", () => {
    const c = new FakeClock()
    c.t = new Date(2026, 9, 7, 14, 30).getTime()
    const p = mk(c, 1)
    p.onBudgetExhausted("k1", 24.0425389, 20.0)
    expect(p.snapshot()[0]).toMatchObject({ blockedBy: "budget", budgetSpend: 24.0425389, budgetLimit: 20.0 })
    // Stale display values must not outlive the block (same rule as blockedBy).
    const reset = new Date(2026, 9, 8, 2).getTime()
    c.advance(reset - c.t)
    const s = p.snapshot()[0]!
    expect(s.blockedBy).toBeNull()
    expect(s.budgetSpend).toBeUndefined()
    expect(s.budgetLimit).toBeUndefined()
  })

  test("a marker-based budget block without parsed spend exposes no spend", () => {
    const c = new FakeClock()
    const p = mk(c, 1)
    p.onBudgetExhausted("k1")
    const s = p.snapshot()[0]!
    expect(s.blockedBy).toBe("budget")
    expect(s.budgetSpend).toBeUndefined()
    expect(s.budgetLimit).toBeUndefined()
  })

  test("a later 429 neither shortens a budget block nor changes its cause", () => {
    const c = new FakeClock()
    c.t = new Date(2026, 9, 7, 10, 0).getTime()
    const p = mk(c, 1, 4)
    p.acquire()
    p.acquire() // half the cap used, so a 429 would block for a window
    p.onBudgetExhausted("k1")
    const blockedForMs = p.snapshot()[0]!.blockedForMs
    p.onRateLimited("k1", "glm-5.2-llmlb")
    p.onRateLimited("k1", "gemma-4-31b-llmlb")
    expect(p.snapshot()[0]!.blockedForMs).toBe(blockedForMs)
    expect(p.snapshot()[0]!.blockedBy).toBe("budget")
  })

  test("blockedBy reports the blocking cause and clears when the block passes", () => {
    const c = new FakeClock()
    const p = mk(c, 1, 4)
    expect(p.snapshot()[0]!.blockedBy).toBeNull()
    p.acquire()
    p.acquire()
    p.onRateLimited("k1", "glm-5.2-llmlb")
    expect(p.snapshot()[0]!.blockedBy).toBe("rate")
    expect(p.snapshot()[0]!.blockedForMs).toBeGreaterThan(0)
    c.advance(60_000)
    expect(p.snapshot()[0]!.blockedForMs).toBe(0)
    expect(p.snapshot()[0]!.blockedBy).toBeNull()
  })

  test("invalid keys are skipped; no valid key at all means no_keys", () => {
    const c = new FakeClock()
    const p = mk(c, 2)
    p.onInvalid("k1")
    expect(p.size).toBe(1)
    expect(alias(p.acquire())).toBe("k2")
    p.onInvalid("k2")
    expect(p.acquire()).toEqual({ kind: "none", reason: "no_keys", retryAfterMs: 0 })
    expect(mk(c, 0).acquire()).toEqual({ kind: "none", reason: "no_keys", retryAfterMs: 0 })
  })

  test("a transient 401 invalidates a key only until the revalidation window passes", () => {
    const c = new FakeClock()
    const p = mk(c, 1)
    p.onInvalid("k1")
    expect(p.size).toBe(0)
    expect(p.snapshot()[0]!.invalid).toBe(true)
    expect(p.acquire()).toEqual({ kind: "none", reason: "no_keys", retryAfterMs: 0 })
    c.advance(INVALID_KEY_TTL_MS - 1)
    expect(p.acquire()).toEqual({ kind: "none", reason: "no_keys", retryAfterMs: 0 })
    c.advance(1)
    expect(p.size).toBe(1)
    expect(p.snapshot()[0]!.invalid).toBe(false)
    expect(alias(p.acquire())).toBe("k1")
  })

  test("excluding every valid key means all_tried", () => {
    const c = new FakeClock()
    expect(mk(c, 2).acquire(new Set(["k1", "k2"]))).toEqual({ kind: "none", reason: "all_tried", retryAfterMs: 0 })
  })

  test("release gives a queued slot back", () => {
    const c = new FakeClock()
    const p = mk(c, 1, 1)
    p.acquire()
    const q = p.acquire()
    expect(q.kind).toBe("ok")
    if (q.kind === "ok") p.release("k1", q.at)
    expect(p.snapshot()[0]!.used).toBe(1)
  })

  test("snapshot never contains secrets", () => {
    const c = new FakeClock()
    const p = mk(c)
    p.acquire()
    expect(JSON.stringify(p.snapshot())).not.toContain("s1")
  })
})
