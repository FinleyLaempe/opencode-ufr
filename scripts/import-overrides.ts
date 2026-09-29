#!/usr/bin/env bun
// Convert the author's former self-hosted LiteLLM proxy's overrides.toml into models.json.
//   bun scripts/import-overrides.ts overrides.live.toml > models.json
import { type ModelEntry, type ModelsFile, validateModelsFile } from "../src/shared/models-file"

/** Prices that overrides.toml lacks, measured against the UFR portal. */
const MEASURED: Record<string, { input: number; output: number; note: string }> = {
  "glm-5.3-flash-llmlb": {
    input: 0.4,
    output: 0.4,
    note: "portal-measured 2026-09-28: 100 267 input tokens moved a test key 1.58% -> 1.78% of $20 (= $0.40/Mtok)",
  },
}

/** Inject a ~11 000-token server-side system prompt on every call (docs/04). */
const EXCLUDE_EXTRA = ["standard-chat-ufr", "standard-reasoning-ufr", "standard-bild-ufr"]

const perMillion = (x: number) => Math.round(x * 1e6 * 1e4) / 1e4

export function convert(toml: Record<string, any>, today: string): ModelsFile {
  const models: Record<string, ModelEntry> = {}
  for (const [id, m] of Object.entries<Record<string, any>>(toml.models ?? {})) {
    const e: ModelEntry = {}
    if (m.context !== undefined) e.context = m.context
    if (m.max_output !== undefined) e.max_output = m.max_output
    if (m.vision !== undefined) e.vision = m.vision
    if (m.tools !== undefined) e.tools = m.tools
    if (m.input_cost !== undefined) {
      e.price = { input: perMillion(m.input_cost), output: perMillion(m.output_cost ?? m.input_cost) }
      if (m.cache_read_cost !== undefined) e.price.cache_read = perMillion(m.cache_read_cost)
      if (m.cache_write_cost !== undefined) e.price.cache_write = perMillion(m.cache_write_cost)
    }
    models[id] = e
  }
  for (const [id, p] of Object.entries(MEASURED)) {
    const e = (models[id] ??= {})
    if (!e.price) {
      e.price = { input: p.input, output: p.output }
      e.note = p.note
    }
  }
  return validateModelsFile({
    schema: 1,
    updated: today,
    defaults: {
      context: toml.proxy?.default_context ?? 131072,
      max_output: toml.proxy?.default_max_output ?? 16384,
    },
    fallbacks: {
      free_escape_order: toml.fallbacks?.free_escape_order ?? [],
      max_targets: toml.fallbacks?.max_targets ?? 4,
      context_hub: toml.fallbacks?.context_hub ?? null,
    },
    exclude: [...new Set([...(toml.opencode?.exclude_models ?? []), ...EXCLUDE_EXTRA])],
    aliases: toml.aliases ?? {},
    models,
  })
}

if (import.meta.main) {
  const path = Bun.argv[2]
  if (!path) {
    console.error("usage: bun scripts/import-overrides.ts <overrides.toml>")
    process.exit(2)
  }
  const toml = Bun.TOML.parse(await Bun.file(path).text()) as Record<string, any>
  console.log(JSON.stringify(convert(toml, new Date().toISOString().slice(0, 10)), null, 2))
}
