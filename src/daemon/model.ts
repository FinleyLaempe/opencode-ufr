/** USD per 1M tokens. cacheRead/cacheWrite default to the input price; cached reads are free on glm/deepseek (measured 2026-11-09). */
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
