import { describe, expect, test } from "bun:test"
import { SlidingWindow } from "../../src/daemon/window"
import { FakeClock } from "../support/clock"

const mk = (c: FakeClock, cap = 3, windowMs = 60_000, maxWaitMs = 20_000) =>
  new SlidingWindow({ cap, windowMs, maxWaitMs, now: c.now })

describe("SlidingWindow", () => {
  test("admits up to cap", () => {
    const c = new FakeClock()
    const w = mk(c)
    for (let i = 0; i < 3; i++) expect(w.reserve()).toEqual({ verdict: "admit", waitMs: 0, at: c.now() })
    expect(w.inWindow()).toBe(3)
    expect(w.headroom()).toBe(0)
  })

  test("queues when the cap-th most recent admission leaves within maxWait", () => {
    const c = new FakeClock()
    const w = mk(c, 3, 60_000, 60_000)
    const t0 = c.now()
    w.reserve()
    c.advance(10_000)
    w.reserve()
    w.reserve()
    expect(w.reserve()).toEqual({ verdict: "queue", waitMs: 50_000, at: t0 + 60_000 })
    expect(w.inWindow()).toBe(4) // the reservation is booked
  })

  test("rejects when the next slot is beyond maxWait, without booking", () => {
    const c = new FakeClock()
    const w = mk(c, 1, 60_000, 20_000)
    w.reserve()
    const r = w.reserve()
    expect(r.verdict).toBe("reject")
    expect(r.waitMs).toBe(60_000)
    expect(w.inWindow()).toBe(1)
  })

  test("an admission exactly one window old has left", () => {
    const c = new FakeClock()
    const w = mk(c, 1)
    w.reserve()
    c.advance(60_000)
    expect(w.reserve().verdict).toBe("admit")
  })

  test("stays exact under sustained overload (the 2026-09-20 shape, 1354 req/h)", () => {
    const c = new FakeClock()
    const w = new SlidingWindow({ cap: 800, windowMs: 3_600_000, maxWaitMs: 20_000, now: c.now })
    const booked: number[] = []
    const gap = 3_600_000 / 1354
    for (let i = 0; i < 1354 * 3; i++) {
      const r = w.reserve()
      if (r.verdict !== "reject") booked.push(r.at)
      c.advance(gap)
    }
    booked.sort((a, b) => a - b)
    for (let i = 800; i < booked.length; i++) expect(booked[i]! - booked[i - 800]!).toBeGreaterThanOrEqual(3_600_000)
  })

  test("normal load (the 2026-09-11 shape, 538 req/h) is never held", () => {
    const c = new FakeClock()
    const w = new SlidingWindow({ cap: 800, windowMs: 3_600_000, maxWaitMs: 20_000, now: c.now })
    for (let i = 0; i < 538 * 3; i++) {
      expect(w.reserve().verdict).toBe("admit")
      c.advance(3_600_000 / 538)
    }
  })

  test("cap 0 disables the window", () => {
    const c = new FakeClock()
    const w = mk(c, 0)
    for (let i = 0; i < 100; i++) expect(w.reserve().verdict).toBe("admit")
    expect(w.nextFreeInMs()).toBe(0)
  })

  test("release frees a booked slot", () => {
    const c = new FakeClock()
    const w = mk(c, 1, 60_000, 60_000)
    w.reserve()
    const q = w.reserve()
    expect(q.verdict).toBe("queue")
    expect(w.release(q.at)).toBe(true)
    expect(w.inWindow()).toBe(1)
    expect(w.release(123)).toBe(false)
  })

  test("seed restores admissions after a restart and drops expired ones", () => {
    const c = new FakeClock()
    const w = mk(c, 2)
    w.seed([c.now() - 30_000, c.now() - 70_000])
    expect(w.inWindow()).toBe(1)
    expect(w.oldest()).toBe(c.now() - 30_000)
  })

  test("nextFreeInMs reports the wait for a full window", () => {
    const c = new FakeClock()
    const w = mk(c, 1)
    w.reserve()
    c.advance(15_000)
    expect(w.nextFreeInMs()).toBe(45_000)
  })
})
