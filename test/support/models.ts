import type { ModelsFile } from "../../src/shared/models-file"

/** A small models.json that exercises every rule. */
export const TEST_MODELS_FILE: ModelsFile = {
  schema: 1,
  updated: "2026-09-28",
  defaults: { context: 131072, max_output: 16384 },
  fallbacks: {
    free_escape_order: ["glm-5.2-llmlb", "gemma-4-31b-llmlb", "mistral-small-4-llmlb"],
    max_targets: 4,
    context_hub: "openai/gpt-5.6-llmlb",
  },
  exclude: ["hidden-model-llmlb"],
  aliases: { "gpt-5.6-llmlb": "openai/gpt-5.6-llmlb" },
  models: {
    "glm-5.2-llmlb": { context: 1048576, price: { input: 0.4, output: 0.4 } },
    "gemma-4-31b-llmlb": { context: 262144, price: { input: 0, output: 0 } },
    "mistral-small-4-llmlb": { context: 256000 },
    "nuextract3-llmlb": { context: 131072, tools: false },
    "openai/gpt-5.6-llmlb": { context: 1050000, price: { input: 0.2, output: 1.2, cache_read: 0.02, cache_write: 0.25 } },
    "hidden-model-llmlb": { context: 8192, vision: false },
  },
}

const ufr = (id: string, name: string, external: boolean, vision: boolean) => ({
  id,
  name,
  connection_type: external ? "external" : "local",
  info: { meta: { capabilities: { vision } } },
})

/** What UFR's /api/models returns for the fixture above (shape as of 2026-09). */
export const UFR_RAW_MODELS = [
  ufr("glm-5.2-llmlb", " GLM 5.2 ", false, false),
  ufr("gemma-4-31b-llmlb", "Gemma 4 31B", false, true),
  ufr("mistral-small-4-llmlb", "Mistral Small 4", false, true),
  ufr("nuextract3-llmlb", "NuExtract 3", false, false),
  ufr("openai/gpt-5.6-llmlb", "GPT 5.6", true, true),
  ufr("gpt-5.6-llmlb", "GPT 5.6 (alias spelling)", true, true),
  ufr("hidden-model-llmlb", "Hidden", false, true),
  ufr("brand-new-llmlb", "Brand New", false, false),
]
