import { describe, expect, test } from "bun:test"
import { buildCatalog, listModels, opencodeStamp, parseUfrModels, resolveModel } from "../../src/daemon/catalog"
import { TEST_MODELS_FILE, UFR_RAW_MODELS } from "../support/models"

const ufr = parseUfrModels({ data: UFR_RAW_MODELS })
const cat = buildCatalog(ufr, TEST_MODELS_FILE, { allowPaid: false })

describe("parseUfrModels", () => {
  test("reads id, trimmed name, tier from connection_type and vision", () => {
    expect(ufr[0]).toEqual({ id: "glm-5.2-llmlb", name: "GLM 5.2", tier: "free", vision: false })
    expect(ufr.find((u) => u.id === "openai/gpt-5.6-llmlb")?.tier).toBe("paid")
  })

  test("accepts a bare array and rejects other shapes", () => {
    expect(parseUfrModels(UFR_RAW_MODELS)).toHaveLength(UFR_RAW_MODELS.length)
    expect(() => parseUfrModels({ nope: true })).toThrow(/unexpected/)
  })
})

describe("buildCatalog", () => {
  test("models.json wins over UFR's facts", () => {
    const glm = cat.models.get("glm-5.2-llmlb")!
    expect(glm.context).toBe(1048576)
    expect(glm.price).toEqual({ input: 0.4, output: 0.4, cacheRead: 0.4, cacheWrite: 0.4 })
    expect(cat.models.get("hidden-model-llmlb")!.vision).toBe(false) // UFR says true
  })

  test("new UFR models get defaults and a warning; unpriced models warn", () => {
    const n = cat.models.get("brand-new-llmlb")!
    expect(n).toMatchObject({ hasEntry: false, context: 131072, maxOutput: 16384, price: null })
    expect(cat.warnings.some((w) => w.includes("brand-new-llmlb") && w.includes("no models.json entry"))).toBe(true)
    expect(cat.warnings.some((w) => w.includes("mistral-small-4-llmlb") && w.includes("no price"))).toBe(true)
  })

  test("models.json entries UFR does not serve are dropped", () => {
    const c = buildCatalog(ufr.filter((u) => u.id !== "gemma-4-31b-llmlb"), TEST_MODELS_FILE, { allowPaid: false })
    expect(c.models.has("gemma-4-31b-llmlb")).toBe(false)
    expect(c.chains.get("glm-5.2-llmlb")).toEqual(["mistral-small-4-llmlb"])
  })

  test("alias spellings resolve to their target and are not listed twice", () => {
    expect(resolveModel(cat, "gpt-5.6-llmlb")).toBe("openai/gpt-5.6-llmlb")
    expect(cat.models.has("gpt-5.6-llmlb")).toBe(false)
    expect(resolveModel(cat, "anything-else")).toBe("anything-else")
  })

  test("excluded models are hidden from the list but still known", () => {
    expect(cat.models.get("hidden-model-llmlb")!.hidden).toBe(true)
    expect(listModels(cat).map((m) => m.id)).not.toContain("hidden-model-llmlb")
  })

  test("chains are derived; paid context hub needs allowPaid", () => {
    expect(cat.chains.get("glm-5.2-llmlb")).toEqual(["gemma-4-31b-llmlb", "mistral-small-4-llmlb"])
    expect(cat.contextChains.size).toBe(0)
    const paid = buildCatalog(ufr, TEST_MODELS_FILE, { allowPaid: true })
    expect(paid.contextChains.get("glm-5.2-llmlb")).toEqual(["openai/gpt-5.6-llmlb"])
  })
})

describe("opencodeStamp", () => {
  test("maps a model onto the stamp the plugin reads", () => {
    expect(opencodeStamp(cat.models.get("openai/gpt-5.6-llmlb")!)).toEqual({
      name: "GPT 5.6",
      limit: { context: 1050000, output: 16384 },
      cost: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 },
      tool_call: true,
      attachment: true,
      reasoning: false,
      temperature: true,
    })
    expect(opencodeStamp(cat.models.get("mistral-small-4-llmlb")!).cost).toBeUndefined()
  })
})
