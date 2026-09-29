export type Reservation = { verdict: "admit" | "queue" | "reject"; waitMs: number; at: number }

/**
 * Exact sliding-window admission control (port of the author's former
 * self-hosted LiteLLM proxy's PoolLimiterCore).
 *
 * `times` is a sorted list of admission times. It may hold times in the future:
 * reservations of queued requests. Keeping them in the same list is what keeps
 * the window exact under load — a queued request already owns the slot it waits
 * for. Not a token bucket: capacity + refill would allow up to 2× cap per window.
 */
export class SlidingWindow {
  private times: number[] = []
  readonly cap: number
  readonly windowMs: number
  readonly maxWaitMs: number
  private readonly now: () => number
  admitted = 0
  queued = 0
  rejected = 0

  constructor(o: { cap: number; windowMs: number; maxWaitMs: number; now: () => number }) {
    if (o.windowMs <= 0) throw new Error("windowMs must be > 0")
    this.cap = Math.max(0, Math.floor(o.cap))
    this.windowMs = o.windowMs
    this.maxWaitMs = Math.max(0, o.maxWaitMs)
    this.now = o.now
  }

  get enabled(): boolean {
    return this.cap > 0
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    let i = 0
    while (i < this.times.length && this.times[i]! <= cutoff) i++
    if (i) this.times.splice(0, i)
  }

  private insert(t: number): void {
    let i = this.times.length
    while (i > 0 && this.times[i - 1]! > t) i--
    this.times.splice(i, 0, t)
  }

  /** Admissions (including reservations) in the current window. */
  inWindow(): number {
    this.prune(this.now())
    return this.times.length
  }

  headroom(): number {
    return this.enabled ? Math.max(0, this.cap - this.inWindow()) : Number.POSITIVE_INFINITY
  }

  /** Milliseconds until a new request could be admitted; 0 = now. */
  nextFreeInMs(): number {
    if (!this.enabled) return 0
    const now = this.now()
    this.prune(now)
    const n = this.times.length
    if (n < this.cap) return 0
    return Math.max(0, this.times[n - this.cap]! + this.windowMs - now)
  }

  reserve(): Reservation {
    const now = this.now()
    if (!this.enabled) return { verdict: "admit", waitMs: 0, at: now }
    this.prune(now)
    const n = this.times.length
    if (n < this.cap) {
      this.insert(now)
      this.admitted++
      return { verdict: "admit", waitMs: 0, at: now }
    }
    // The new request may enter the moment the cap-th most recent admission
    // leaves the window: then cap-1 remain, plus this one = cap.
    const at = this.times[n - this.cap]! + this.windowMs
    const waitMs = Math.max(0, at - now)
    if (waitMs <= this.maxWaitMs) {
      this.insert(at)
      this.queued++
      return { verdict: "queue", waitMs, at }
    }
    this.rejected++
    return { verdict: "reject", waitMs, at }
  }

  /** Book a slot at an explicit time (KeyPool uses it for keys in cooldown). */
  reserveAt(t: number): void {
    this.insert(t)
    this.queued++
  }

  /** Give back a booked time, e.g. when the waiting client went away. */
  release(t: number): boolean {
    const i = this.times.indexOf(t)
    if (i < 0) return false
    this.times.splice(i, 1)
    return true
  }

  /** Restore admissions after a restart. */
  seed(times: number[]): void {
    for (const t of times) this.insert(t)
    this.prune(this.now())
  }

  oldest(): number | undefined {
    this.prune(this.now())
    return this.times[0]
  }

  snapshot() {
    return {
      enabled: this.enabled,
      cap: this.cap,
      windowMs: this.windowMs,
      inWindow: this.inWindow(),
      admitted: this.admitted,
      queued: this.queued,
      rejected: this.rejected,
    }
  }
}
