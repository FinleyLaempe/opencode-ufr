import { describe, expect, test } from "bun:test"
import { ThroughputMeter } from "../../src/daemon/meter"
import { FakeClock } from "../support/clock"

describe("ThroughputMeter", () => {
  test("sums only the events inside the window", () => {
    const c = new FakeClock(1_000_000)
    const m = new ThroughputMeter({ now: c.now, horizonMs: 60_000 })
    m.add({ requests: 1, tokensIn: 100, tokensOut: 10 })
    c.advance(15_000)
    m.add({ tokensOut: 30 })
    expect(m.sum(10_000)).toEqual({ requests: 0, tokensIn: 0, tokensOut: 30 })
    expect(m.sum(60_000)).toEqual({ requests: 1, tokensIn: 100, tokensOut: 40 })
  })

  test("events older than the horizon are dropped", () => {
    const c = new FakeClock(1_000_000)
    const m = new ThroughputMeter({ now: c.now, horizonMs: 60_000 })
    m.add({ requests: 1, tokensOut: 5 })
    c.advance(60_001)
    m.add({ tokensOut: 1 })
    expect(m.sum(60_000)).toEqual({ requests: 0, tokensIn: 0, tokensOut: 1 })
  })

  test("a correction may be negative, but a window sum never is", () => {
    const c = new FakeClock(1_000_000)
    const m = new ThroughputMeter({ now: c.now, horizonMs: 60_000 })
    m.add({ tokensOut: 50 }) // live estimate
    c.advance(20_000)
    m.add({ tokensOut: -10 }) // the real usage came in lower
    expect(m.sum(10_000).tokensOut).toBe(0)
    expect(m.sum(60_000).tokensOut).toBe(40)
  })
})
