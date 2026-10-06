import { afterAll, describe, expect, test } from "bun:test"
import { startOfLocalDay } from "../../src/shared/time"

// Bun quirk: deleting process.env.TZ after a set makes later sets a no-op
// (the zone stays cached). So tests always ASSIGN, and we restore the system
// zone by assigning it back — never by deleting.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const REAL_TZ = process.env.TZ

afterAll(() => {
  process.env.TZ = REAL_TZ ?? SYSTEM_TZ
})

describe("startOfLocalDay", () => {
  test("returns local midnight of the day containing the timestamp (UTC pinned)", () => {
    process.env.TZ = "UTC"
    // 2026-01-15T15:30:45.123Z → local midnight is 2026-01-15T00:00:00Z
    const ms = Date.UTC(2026, 0, 15, 15, 30, 45, 123)
    expect(startOfLocalDay(ms)).toBe(Date.UTC(2026, 0, 15))
  })

  test("a non-UTC zone shifts midnight accordingly (America/New_York, DST-safe mid-January)", () => {
    process.env.TZ = "America/New_York"
    // mid-January: EST (UTC-5), no DST ambiguity
    const ms = Date.UTC(2026, 0, 15, 15, 30, 45, 123) // 10:30 local
    expect(startOfLocalDay(ms)).toBe(Date.UTC(2026, 0, 15, 5)) // local midnight = 05:00Z
  })

  test("the result is exactly midnight in local time (h/m/s/ms all zero)", () => {
    process.env.TZ = "Europe/Berlin"
    const ms = Date.UTC(2026, 6, 10, 23, 59, 59, 999) // 2026-07-11 01:59 local
    const d = new Date(startOfLocalDay(ms))
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([0, 0, 0, 0])
    // and it belongs to the same local calendar day as the input
    expect(d.toDateString()).toBe(new Date(ms).toDateString())
  })

  test("a late-evening timestamp maps to the same day, not the next", () => {
    process.env.TZ = "UTC"
    const ms = Date.UTC(2026, 2, 3, 23, 0, 0)
    expect(startOfLocalDay(ms)).toBe(Date.UTC(2026, 2, 3))
  })
})
