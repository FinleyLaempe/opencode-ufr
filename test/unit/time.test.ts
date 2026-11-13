import { afterAll, describe, expect, test } from "bun:test"
import { startOfUfrDay } from "../../src/shared/time"

// Bun quirk: deleting process.env.TZ after a set makes later sets a no-op
// (the zone stays cached). So tests always ASSIGN, and we restore the system
// zone by assigning it back — never by deleting.
const SYSTEM_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone
const REAL_TZ = process.env.TZ

afterAll(() => {
  process.env.TZ = REAL_TZ ?? SYSTEM_TZ
})

describe("startOfUfrDay", () => {
  test("returns the last local 02:00 at or before the timestamp (UTC pinned)", () => {
    process.env.TZ = "UTC"
    // 2026-01-15T15:30:45.123Z → the UFR day started at 2026-01-15T02:00:00Z
    const ms = Date.UTC(2026, 0, 15, 15, 30, 45, 123)
    expect(startOfUfrDay(ms)).toBe(Date.UTC(2026, 0, 15, 2))
  })

  test("a timestamp before 02:00 belongs to the previous UFR day (UTC)", () => {
    process.env.TZ = "UTC"
    const ms = Date.UTC(2026, 0, 15, 1, 59, 59, 999)
    expect(startOfUfrDay(ms)).toBe(Date.UTC(2026, 0, 14, 2))
  })

  test("exactly 02:00 starts the UFR day at the timestamp itself", () => {
    process.env.TZ = "UTC"
    const ms = Date.UTC(2026, 0, 15, 2)
    expect(startOfUfrDay(ms)).toBe(ms)
  })

  test("a non-UTC zone shifts 02:00 accordingly (America/New_York, DST-safe mid-January)", () => {
    process.env.TZ = "America/New_York"
    // mid-January: EST (UTC-5), no DST ambiguity. 10:30 local → the UFR day
    // started at 02:00 EST = 07:00Z.
    const ms = Date.UTC(2026, 0, 15, 15, 30, 45, 123)
    expect(startOfUfrDay(ms)).toBe(Date.UTC(2026, 0, 15, 7))
  })

  test("the result is exactly 02:00 in local time (Europe/Berlin, across the day boundary)", () => {
    process.env.TZ = "Europe/Berlin"
    const ms = Date.UTC(2026, 6, 10, 23, 59, 59, 999) // 2026-07-11 01:59 local — before 02:00
    const d = new Date(startOfUfrDay(ms))
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([2, 0, 0, 0])
    // ...so it belongs to the previous local calendar day: 02:00 CEST on Jul 10 = 00:00Z
    expect(startOfUfrDay(ms)).toBe(Date.UTC(2026, 6, 10))
  })
})
