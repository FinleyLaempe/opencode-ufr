import { SlidingWindow } from "./window"

export type KeyInfo = { alias: string; secret: string }
export type Acquired = { kind: "ok"; alias: string; secret: string; waitMs: number; at: number }
export type NotAcquired = { kind: "none"; reason: "no_keys" | "all_tried" | "exhausted"; retryAfterMs: number }
export type KeySnapshot = { alias: string; used: number; cap: number; blockedForMs: number; invalid: boolean }

/** A 401 can be transient (portal hiccup, short-lived token rotation): the key
 *  is skipped for this long, then retried — instead of being dead until restart. */
export const INVALID_KEY_TTL_MS = 10 * 60_000

type Slot = KeyInfo & {
  window: SlidingWindow
  blockedUntil: number
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
      s.blockedUntil = Math.max(s.blockedUntil, (s.window.oldest() ?? now) + this.o.windowMs, now + 1_000)
    }
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
      invalid: s.invalidUntil > now,
    }))
  }
}
