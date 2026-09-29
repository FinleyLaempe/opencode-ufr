/** USD per 1M tokens. UFR bills prefix-cached input in full (measured 2026-09-28). */
export type ModelPrice = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type Model = {
  id: string
  name: string
  tier: "free" | "paid"
  vision: boolean
  tools: boolean
  context: number
  maxOutput: number
  price: ModelPrice | null
  hasEntry: boolean
  hidden: boolean
}
