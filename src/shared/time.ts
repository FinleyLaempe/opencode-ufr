/**
 * Local 02:00 of the UFR day containing `ms`. The daily limits reset at 02:00
 * local (reported 2026-11-13), so a "day" for spend tracking and key blocks
 * runs 02:00 → 02:00, not midnight → midnight.
 */
export function startOfUfrDay(ms: number): number {
  const d = new Date(ms)
  d.setHours(2, 0, 0, 0)
  if (d.getTime() > ms) d.setDate(d.getDate() - 1)
  return d.getTime()
}
