import { describe, expect, test } from "bun:test"
import { toModelInfo } from "../../src/plugin/model-info"

const stamp = {
  name: "GLM 5.2",
  limit: { context: 1048576, output: 16384 },
  cost: { input: 0.4, output: 0.4, cache_read: 0.4, cache_write: 0.4 },
  tool_call: true,
  attachment: false,
  reasoning: false,
  temperature: true,
}

describe("toModelInfo", () => {
  test("maps a stamp onto opencode's V2 Model.Info", () => {
    expect(toModelInfo("unifreiburg", "glm-5.2-llmlb", stamp)).toEqual({
      id: "glm-5.2-llmlb",
      modelID: "glm-5.2-llmlb",
      providerID: "unifreiburg",
      name: "GLM 5.2",
      capabilities: { tools: true, input: ["text"], output: ["text"] },
      limit: { context: 1048576, output: 16384 },
      time: { released: 0 },
      variants: [],
      status: "active",
      enabled: true,
      cost: [{ input: 0.4, output: 0.4, cache: { read: 0.4, write: 0.4 } }],
    })
  })

  test("vision models accept images", () => {
    expect((toModelInfo("p", "m", { ...stamp, attachment: true }) as any).capabilities.input).toEqual(["text", "image"])
  })

  test("unpriced models still get a complete cost array (opencode reads it unguarded)", () => {
    const { cost: _drop, ...unpriced } = stamp
    expect((toModelInfo("p", "m", unpriced) as any).cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }])
  })
})

describe("toModelInfo: reasoning efforts", () => {
  const base = { name: "M", limit: { context: 1000, output: 100 }, tool_call: true, attachment: false, reasoning: true, temperature: true }
  test("one variant per effort, each setting reasoning_effort in the request body", () => {
    const info = toModelInfo("ufr", "m", { ...base, efforts: ["none", "low", "high"] })
    expect(info.variants).toEqual([
      { id: "none", headers: {}, body: { reasoning_effort: "none" } },
      { id: "low", headers: {}, body: { reasoning_effort: "low" } },
      { id: "high", headers: {}, body: { reasoning_effort: "high" } },
    ])
  })
  test("a stamp from an older gateway without efforts still yields an empty variants array", () => {
    expect(toModelInfo("ufr", "m", base).variants).toEqual([])
  })
})
