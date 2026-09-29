import { describe, expect, test } from "bun:test"
import { deriveChains, deriveContextChains } from "../../src/daemon/fallbacks"
import type { Model } from "../../src/daemon/model"

const m = (id: string, over: Partial<Model> = {}): [string, Model] => [
  id,
  { id, name: id, tier: "free", vision: false, tools: true, context: 262144, maxOutput: 16384,
    price: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, hasEntry: true, hidden: false, ...over },
]
const FB = { free_escape_order: ["a", "b", "c", "d"], max_targets: 4, context_hub: "hub" }
const free = { allowPaid: false }

describe("deriveChains", () => {
  test("a model in the order falls back only to models strictly later in it", () => {
    const models = new Map([m("a"), m("b"), m("c"), m("d")])
    const chains = deriveChains(models, FB, free)
    expect(chains.get("a")).toEqual(["b", "c", "d"])
    expect(chains.get("c")).toEqual(["d"])
    expect(chains.has("d")).toBe(false) // last one is a sink
  })

  test("no chain ever points backwards (no cycles)", () => {
    const models = new Map([m("a"), m("b"), m("c"), m("d"), m("x")])
    for (const [src, targets] of deriveChains(models, FB, free)) {
      if (!FB.free_escape_order.includes(src)) continue
      for (const t of targets) expect(FB.free_escape_order.indexOf(t)).toBeGreaterThan(FB.free_escape_order.indexOf(src))
    }
  })

  test("a model outside the order may use the whole order", () => {
    const chains = deriveChains(new Map([m("a"), m("b"), m("x")]), FB, free)
    expect(chains.get("x")).toEqual(["a", "b"])
  })

  test("a vision model only falls back to vision models", () => {
    const models = new Map([m("a", { vision: true }), m("b"), m("c", { vision: true })])
    expect(deriveChains(models, FB, free).get("a")).toEqual(["c"])
  })

  test("purpose-built models (tools: false) get no chain", () => {
    expect(deriveChains(new Map([m("nuextract", { tools: false }), m("a")]), FB, free).has("nuextract")).toBe(false)
  })

  test("models without a models.json entry get no chain", () => {
    expect(deriveChains(new Map([m("new", { hasEntry: false }), m("a")]), FB, free).has("new")).toBe(false)
  })

  test("max_targets truncates", () => {
    const models = new Map([m("a"), m("b"), m("c"), m("d"), m("x")])
    expect(deriveChains(models, { ...FB, max_targets: 2 }, free).get("x")).toEqual(["a", "b"])
  })

  test("paid targets only with allowPaid", () => {
    const models = new Map([m("a"), m("b", { tier: "paid" }), m("c")])
    expect(deriveChains(models, FB, free).get("a")).toEqual(["c"])
    expect(deriveChains(models, FB, { allowPaid: true }).get("a")).toEqual(["b", "c"])
  })

  test("the context hub has no rate-limit chain and order entries UFR does not serve are ignored", () => {
    const models = new Map([m("hub"), m("a"), m("c")])
    const chains = deriveChains(models, FB, free)
    expect(chains.has("hub")).toBe(false)
    expect(chains.get("a")).toEqual(["c"])
  })
})

describe("deriveContextChains", () => {
  const models = new Map([
    m("hub", { tier: "paid", context: 1_050_000, price: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 } }),
    m("small", { context: 128_000 }),
    m("huge", { context: 2_000_000 }),
    m("tool-less", { context: 8192, tools: false }),
  ])

  test("nothing without allowPaid when the hub is paid", () => {
    expect(deriveContextChains(models, "hub", free).size).toBe(0)
  })

  test("with allowPaid everything smaller than the hub escapes to it", () => {
    const c = deriveContextChains(models, "hub", { allowPaid: true })
    expect(c.get("small")).toEqual(["hub"])
    expect(c.has("huge")).toBe(false)
    expect(c.has("tool-less")).toBe(false)
    expect(c.has("hub")).toBe(false)
  })

  test("no hub or an unserved hub means no context chains", () => {
    expect(deriveContextChains(models, null, { allowPaid: true }).size).toBe(0)
    expect(deriveContextChains(models, "gone", { allowPaid: true }).size).toBe(0)
  })
})
