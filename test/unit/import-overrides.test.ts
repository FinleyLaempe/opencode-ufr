import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { convert } from "../../scripts/import-overrides"

const toml = Bun.TOML.parse(await Bun.file(join(import.meta.dir, "..", "fixtures", "overrides.sample.toml")).text())
const out = convert(toml as Record<string, any>, "2026-09-28")

describe("import-overrides", () => {
  test("per-token prices become USD per 1M tokens", () => {
    expect(out.models["glm-5.2-llmlb"]!.price).toEqual({ input: 0.4, output: 0.4 })
    expect(out.models["openai/gpt-5.6-llmlb"]!.price).toEqual({ input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 })
  })

  test("adds the measured glm-5.3-flash price with its source", () => {
    expect(out.models["glm-5.3-flash-llmlb"]!.price).toEqual({ input: 0.4, output: 0.4 })
    expect(out.models["glm-5.3-flash-llmlb"]!.note).toContain("2026-09-28")
  })

  test("keeps context, tools and vision facts; models without a price stay unpriced", () => {
    expect(out.models["nuextract3-llmlb"]).toEqual({ context: 131072, tools: false })
    expect(out.models["ufr/coding-complex"]).toEqual({ context: 1048576, vision: false })
    expect(out.models["gemma-4-31b-llmlb"]!.price).toBeUndefined()
  })

  test("carries fallbacks, defaults and aliases; hides the injecting standard-* spellings", () => {
    expect(out.fallbacks).toEqual({ free_escape_order: ["gemma-4-31b-llmlb", "glm-5.2-llmlb"], max_targets: 4, context_hub: "openai/gpt-5.6-llmlb" })
    expect(out.defaults).toEqual({ context: 131072, max_output: 16384 })
    expect(out.aliases).toEqual({ "gpt-5.6-llmlb": "openai/gpt-5.6-llmlb" })
    expect(out.exclude).toEqual(["gpt-oss-120b-llmlb", "standard-chat-ufr", "standard-reasoning-ufr", "standard-bild-ufr"])
    expect(out.updated).toBe("2026-09-28")
  })
})
