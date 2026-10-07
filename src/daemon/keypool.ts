import { startOfLocalDay } from "../shared/time"
import { SlidingWindow } from "./window"

export type KeyInfo = { alias: string; secret: string }
export type Acquired = { kind: "ok"; alias: string; secret: string; waitMs: number; at: number }
export type NotAcquired = { kind: "none"; reason: "no_keys" | "all_tried" | "exhausted"; retryAfterMs: number }
export type KeySnapshot = {
  alias: string
  used: number
  cap: number
  blockedForMs: number
  /** Why the key is blocked right now: a daily-budget 429 or a bucket 429; null when usable. */
  blockedBy: "budget" | "rate" | null
  /** Parsed from UFR's budget body, only while budget-blocked and only when UFR named the numbers. */
  budgetSpend?: number
  budgetLimit?: number
  invalid: boolean
}

/** A 401 can be transient (portal hiccup, short-lived token rotation): the key
 *  is skipped for this long, then retried — instead of being dead until restart. */
export const INVALID_KEY_TTL_MS = 10 * 60_000

type Slot = KeyInfo & {
  window: SlidingWindow
  blockedUntil: number
  /** What blocked the key: a daily-budget 429 or a bucket 429 (null until one fires). */
  blockedBy: "budget" | "rate" | null
  /** Spend/limit parsed from the last budget error, for the display; cleared with the block. */
  budgetSpend?: number
  budgetLimit?: number
  /** Until when the key is considered invalid (0 = valid); a transient 401 expires. */
  invalidUntil: number
  recent429: { at: number; model: string }[]
}

export class KeyPool {
  private readonly slots: Slot[]
  private rr = 0

  constructor(
    keys: KeyInfo[],
    private readonly o: { cap: number; windowMs: number; maxWaitMs: number; now: () => number },
  ) {
    this.slots = keys.map((k) => ({
      ...k,
      window: new SlidingWindow({ cap: o.cap, windowMs: o.windowMs, maxWaitMs: o.maxWaitMs, now: o.now }),
      blockedUntil: 0,
      blockedBy: null,
      invalidUntil: 0,
      recent429: [],
    }))
  }

  /** Number of keys not currently marked invalid. */
  get size(): number {
    return this.slots.filter((s) => s.invalidUntil <= this.o.now()).length
  }

  private find(alias: string): Slot | undefined {
    return this.slots.find((s) => s.alias === alias)
  }

  private availableAt(s: Slot): number {
    return Math.max(s.blockedUntil, this.o.now() + s.window.nextFreeInMs())
  }

  acquire(exclude: ReadonlySet<string> = new Set()): Acquired | NotAcquired {
    const now = this.o.now()
    const valid = this.slots.filter((s) => s.invalidUntil <= now)
    if (valid.length === 0) return { kind: "none", reason: "no_keys", retryAfterMs: 0 }
    const usable = valid.filter((s) => !exclude.has(s.alias))
    if (usable.length === 0) return { kind: "none", reason: "all_tried", retryAfterMs: 0 }

    const ready = usable.filter((s) => this.availableAt(s) <= now)
    if (ready.length > 0) {
      const best = Math.max(...ready.map((s) => s.window.headroom()))
      const tied = ready.filter((s) => s.window.headroom() === best)
      const pick = tied[this.rr++ % tied.length]!
      const r = pick.window.reserve()
      return { kind: "ok", alias: pick.alias, secret: pick.secret, waitMs: 0, at: r.at }
    }

    let soonest = usable[0]!
    for (const s of usable) if (this.availableAt(s) < this.availableAt(soonest)) soonest = s
    const at = this.availableAt(soonest)
    const waitMs = at - now
    if (waitMs <= this.o.maxWaitMs) {
      soonest.window.reserveAt(at)
      return { kind: "ok", alias: soonest.alias, secret: soonest.secret, waitMs, at }
    }
    return { kind: "none", reason: "exhausted", retryAfterMs: waitMs }
  }

  release(alias: string, at: number): void {
    this.find(alias)?.window.release(at)
  }

  /**
   * UFR said 429 on this key. Bucket, model wall and daily $ cap look identical,
   * so only cool the key down when the bucket is the plausible cause.
   */
  onRateLimited(alias: string, model: string): void {
    const s = this.find(alias)
    if (!s) return
    const now = this.o.now()
    s.recent429 = s.recent429.filter((e) => e.at > now - this.o.windowMs)
    s.recent429.push({ at: now, model })
    const usedHalf = s.window.inWindow() >= Math.max(1, Math.floor(this.o.cap / 2))
    const acrossModels = new Set(s.recent429.map((e) => e.model)).size >= 2
    if (usedHalf || acrossModels) {
      // UFR frees a slot at first admission + window; rejected calls do not count.
      const until = Math.max(s.blockedUntil, (s.window.oldest() ?? now) + this.o.windowMs, now + 1_000)
      // Only the block that actually extends the deadline owns the cause: a rate
      // block on top of a longer budget block must not relabel it "rate".
      if (until > s.blockedUntil) {
        s.blockedUntil = until
        s.blockedBy = "rate"
      }
    }
  }

  /**
   * UFR's daily-budget error (the `budget_exceeded` marker 429, or the 400
   * `ExceededBudget` body since 2026-10-07) means this key's $ cap is spent for
   * the day: block it until the next local midnight — UFR's own reset time is
   * unknown, and midnight is the same assumption the spend-today stats already
   * make. A bucket 429 carries the identical body (2026-10-07), so a merely
   * rate-limited key can end up budget-blocked; that only costs until midnight
   * and is safe. Never shortens an existing block. When UFR's body named the
   * numbers, they are kept for the display — and expire with the block.
   */
  onBudgetExhausted(alias: string, spend?: number, limit?: number): void {
    const s = this.find(alias)
    if (!s) return
    const now = this.o.now()
    // startOfLocalDay(now) at exactly midnight would be now itself — +24h always
    // lands in the future, so the block can never be already expired.
    s.blockedUntil = Math.max(s.blockedUntil, startOfLocalDay(now) + 24 * 3_600_000)
    s.blockedBy = "budget"
    s.budgetSpend = spend
    s.budgetLimit = limit
  }

  onInvalid(alias: string): void {
    const s = this.find(alias)
    if (s) s.invalidUntil = this.o.now() + INVALID_KEY_TTL_MS
  }

  snapshot(): KeySnapshot[] {
    const now = this.o.now()
    return this.slots.map((s) => ({
      alias: s.alias,
      used: s.window.inWindow(),
      cap: this.o.cap,
      blockedForMs: Math.max(0, s.blockedUntil - now),
      // The cause is derived from the current time, not stored state: a block
      // whose deadline has passed reports as unblocked even if the slot still
      // carries a stale blockedBy. The parsed spend/limit are display values of
      // the block — they must not outlive it either.
      blockedBy: s.blockedUntil > now ? s.blockedBy : null,
      ...(s.blockedUntil > now && s.blockedBy === "budget" && s.budgetSpend !== undefined
        ? { budgetSpend: s.budgetSpend, budgetLimit: s.budgetLimit }
        : {}),
      invalid: s.invalidUntil > now,
    }))
  }
}
