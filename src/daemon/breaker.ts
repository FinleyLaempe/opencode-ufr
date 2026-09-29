export type BreakerState = "closed" | "open" | "half_open"
export type BreakerOptions = { tripThreshold: number; ladderMs: number[]; probeTimeoutMs: number; now: () => number }
export type BreakerSnapshot = { level: number; openUntil: number; consecutive: number; trips: number }

/**
 * Per-model-group breaker (port of the author's former self-hosted LiteLLM
 * proxy's BreakerCore). UFR walls model groups for hours and every request
 * made while walled restarts the clock, so after tripThreshold rate-limited
 * *client requests* the group goes quiet for an escalating time.
 */
export class Breaker {
  consecutive = 0
  level = 0
  openUntil = 0
  trips = 0
  rejected = 0
  private probeInFlight = false
  private probeIssuedAt = 0

  constructor(private readonly o: BreakerOptions) {
    if (o.tripThreshold < 1) throw new Error("tripThreshold must be >= 1")
    if (o.ladderMs.length === 0) throw new Error("ladder must not be empty")
  }

  state(): BreakerState {
    if (this.openUntil === 0) return "closed"
    return this.o.now() >= this.openUntil ? "half_open" : "open"
  }

  retryAfterMs(): number {
    return Math.max(0, this.openUntil - this.o.now())
  }

  allow(): { allowed: boolean; retryAfterMs: number } {
    let state = this.state()
    if (state === "closed") return { allowed: true, retryAfterMs: 0 }
    // A probe whose outcome never came back (attributed to another group after
    // a redirect) must not wedge this group in half-open forever.
    if (this.probeInFlight && this.o.now() - this.probeIssuedAt > this.o.probeTimeoutMs) {
      this.probeInFlight = false
      this.open(this.level + 1)
      state = this.state()
    }
    if (state === "half_open" && !this.probeInFlight) {
      this.probeInFlight = true
      this.probeIssuedAt = this.o.now()
      return { allowed: true, retryAfterMs: 0 }
    }
    this.rejected++
    return { allowed: false, retryAfterMs: this.retryAfterMs() || 5_000 }
  }

  onSuccess(): void {
    this.consecutive = 0
    this.level = 0
    this.openUntil = 0
    this.probeInFlight = false
    this.probeIssuedAt = 0
  }

  onRateLimited(): void {
    const wasProbing = this.probeInFlight
    this.probeInFlight = false
    this.consecutive++
    if (wasProbing) {
      this.open(this.level + 1)
      return
    }
    if (this.state() === "open") return // was already in flight when we tripped
    if (this.consecutive >= this.o.tripThreshold) {
      // Once the ladder is engaged it keeps climbing (regression 2026-09-21).
      this.open(this.openUntil ? this.level + 1 : 0)
    }
  }

  /** Timeouts, context errors, 5xx: no evidence of a wall. Clears a probe. */
  onOtherFailure(): void {
    this.probeInFlight = false
  }

  private open(level: number): void {
    this.level = Math.min(level, this.o.ladderMs.length - 1)
    this.openUntil = this.o.now() + this.o.ladderMs[this.level]!
    this.consecutive = 0
    this.trips++
  }

  snapshot(): BreakerSnapshot {
    return { level: this.level, openUntil: this.openUntil, consecutive: this.consecutive, trips: this.trips }
  }

  restore(s: BreakerSnapshot): void {
    this.level = s.level
    this.openUntil = s.openUntil
    this.consecutive = s.consecutive
    this.trips = s.trips
  }
}

export class BreakerRegistry {
  private readonly groups = new Map<string, Breaker>()

  constructor(private readonly o: BreakerOptions) {}

  get(group: string): Breaker {
    let b = this.groups.get(group)
    if (!b) {
      b = new Breaker(this.o)
      this.groups.set(group, b)
    }
    return b
  }

  /** First group that admits a request. Consumes a half-open probe slot on it. */
  firstAvailable(groups: string[]): string | null {
    for (const g of groups) if (this.get(g).allow().allowed) return g
    return null
  }

  minRetryAfterMs(groups: string[]): number {
    return Math.min(...groups.map((g) => this.get(g).retryAfterMs() || 5_000))
  }

  openGroups(): string[] {
    return [...this.groups]
      .filter(([, b]) => b.state() === "open")
      .map(([g]) => g)
      .sort()
  }

  snapshot(): Record<string, BreakerSnapshot> {
    return Object.fromEntries(
      [...this.groups].filter(([, b]) => b.openUntil !== 0 || b.consecutive > 0).map(([g, b]) => [g, b.snapshot()]),
    )
  }

  restore(map: Record<string, BreakerSnapshot>): void {
    for (const [g, s] of Object.entries(map)) this.get(g).restore(s)
  }

  states(): Record<string, { state: BreakerState; level: number; retryAfterMs: number }> {
    return Object.fromEntries(
      [...this.groups].map(([g, b]) => [g, { state: b.state(), level: b.level, retryAfterMs: b.retryAfterMs() }]),
    )
  }
}
