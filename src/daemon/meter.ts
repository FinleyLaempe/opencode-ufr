/**
 * Live throughput for the sidebar. The stats db only learns about a request
 * once it has finished (and files it under its start time), so a running
 * stream is invisible there and one longer than the rate window never shows
 * at all. This in-memory meter takes events the moment they happen: streamed
 * output as it passes through (estimated), the real usage when UFR reports it
 * (as a correction to the estimate), and a request count at completion.
 */
export type MeterSum = { requests: number; tokensIn: number; tokensOut: number }

type MeterEvent = { at: number; requests: number; tokensIn: number; tokensOut: number }

export class ThroughputMeter {
  private events: MeterEvent[] = []

  constructor(private readonly o: { now: () => number; horizonMs: number }) {}

  add(e: { requests?: number; tokensIn?: number; tokensOut?: number }): void {
    const now = this.o.now()
    this.events.push({ at: now, requests: e.requests ?? 0, tokensIn: e.tokensIn ?? 0, tokensOut: e.tokensOut ?? 0 })
    const cutoff = now - this.o.horizonMs
    let drop = 0
    while (drop < this.events.length && this.events[drop]!.at <= cutoff) drop++
    if (drop > 0) this.events.splice(0, drop)
  }

  /** Totals over the last `windowMs`. A correction can be negative; a window sum never is. */
  sum(windowMs: number): MeterSum {
    const since = this.o.now() - windowMs
    const s: MeterSum = { requests: 0, tokensIn: 0, tokensOut: 0 }
    for (const e of this.events) {
      if (e.at <= since) continue
      s.requests += e.requests
      s.tokensIn += e.tokensIn
      s.tokensOut += e.tokensOut
    }
    return { requests: Math.max(0, s.requests), tokensIn: Math.max(0, s.tokensIn), tokensOut: Math.max(0, s.tokensOut) }
  }
}
