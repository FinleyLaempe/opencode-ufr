import { describe, expect, test } from "bun:test"
import { ModelsFileError, validateModelsFile } from "../../src/shared/models-file"
import { TEST_MODELS_FILE } from "../support/models"

const withChange = (f: (x: any) => void) => {
  const x = structuredClone(TEST_MODELS_FILE) as any
  f(x)
  return x
}

describe("validateModelsFile", () => {
  test("accepts the fixture", () => {
    expect(validateModelsFile(structuredClone(TEST_MODELS_FILE))).toEqual(TEST_MODELS_FILE)
  })

  test("rejects a wrong schema version", () => {
    expect(() => validateModelsFile(withChange((x) => (x.schema = 2)))).toThrow(/schema/)
  })

  test("rejects bad numbers with the exact path", () => {
    expect(() => validateModelsFile(withChange((x) => (x.models["glm-5.2-llmlb"].context = -1)))).toThrow(
      /models\["glm-5.2-llmlb"\]\.context/,
    )
    expect(() => validateModelsFile(withChange((x) => (x.models["glm-5.2-llmlb"].price = { input: 0.4 })))).toThrow(
      /price/,
    )
    expect(() => validateModelsFile(withChange((x) => (x.fallbacks.max_targets = 0)))).toThrow(/max_targets/)
  })

  test("rejects an alias that points at a model without an entry", () => {
    expect(() => validateModelsFile(withChange((x) => (x.aliases.foo = "nope")))).toThrow(/aliases\["foo"\]/)
  })

  test("rejects an updated field that is not a parseable date", () => {
    expect(() => validateModelsFile(withChange((x) => (x.updated = "soon")))).toThrow(/updated.*date string/)
    expect(() => validateModelsFile(withChange((x) => (x.updated = 42)))).toThrow(/updated.*date string/)
  })

  test("rejects non-objects and missing sections", () => {
    expect(() => validateModelsFile(null)).toThrow(ModelsFileError)
    expect(() => validateModelsFile(withChange((x) => delete x.fallbacks))).toThrow(/fallbacks/)
    expect(() => validateModelsFile(withChange((x) => (x.exclude = "nope")))).toThrow(/exclude/)
  })
})
