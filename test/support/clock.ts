/** Deterministic clock for tests: time only moves when a test says so. */
export class FakeClock {
  t: number
  constructor(start = 1_800_000_000_000) {
    this.t = start
  }
  now = (): number => this.t
  advance(ms: number): void {
    this.t += ms
  }
}
