import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { validateModelsFile } from "../../src/shared/models-file"

const file = validateModelsFile(JSON.parse(await Bun.file(join(import.meta.dir, "..", "..", "models.json")).text()))

describe("the committed models.json", () => {
  test("is valid", () => {
    expect(file.schema).toBe(1)
  })

  test("every fallback target has an entry", () => {
    for (const id of file.fallbacks.free_escape_order) expect(file.models[id]).toBeDefined()
  })

  test("the glm models carry the measured price", () => {
    expect(file.models["glm-5.2-llmlb"]?.price).toMatchObject({ input: 0.4, output: 0.4 })
    expect(file.models["glm-5.3-flash-llmlb"]?.price).toMatchObject({ input: 0.4, output: 0.4 })
  })
})
