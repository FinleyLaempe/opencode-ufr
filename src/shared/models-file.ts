/** USD per 1M tokens. */
export type Price = { input: number; output: number; cache_read?: number; cache_write?: number }

export type ModelEntry = {
  context?: number
  max_output?: number
  vision?: boolean
  tools?: boolean
  price?: Price
  note?: string
}

export type ModelsFile = {
  schema: 1
  updated: string
  defaults: { context: number; max_output: number }
  fallbacks: { free_escape_order: string[]; max_targets: number; context_hub: string | null }
  exclude: string[]
  aliases: Record<string, string>
  models: Record<string, ModelEntry>
}

export class ModelsFileError extends Error {}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const posInt = (x: unknown) => typeof x === "number" && Number.isInteger(x) && x > 0
const nonNeg = (x: unknown) => typeof x === "number" && Number.isFinite(x) && x >= 0
const strList = (x: unknown) => Array.isArray(x) && x.every((s) => typeof s === "string")

function fail(path: string, why: string): never {
  throw new ModelsFileError(`models.json: ${path} ${why}`)
}

export function validateModelsFile(x: unknown): ModelsFile {
  if (!isObj(x)) fail("(root)", "must be an object")
  if (x.schema !== 1) fail("schema", `must be 1 (got ${JSON.stringify(x.schema)})`)
  if (typeof x.updated !== "string") fail("updated", "must be a date string")
  const d = x.defaults
  if (!isObj(d) || !posInt(d.context) || !posInt(d.max_output)) fail("defaults", "needs positive integers context and max_output")
  const fb = x.fallbacks
  if (!isObj(fb)) fail("fallbacks", "must be an object")
  if (!strList(fb.free_escape_order)) fail("fallbacks.free_escape_order", "must be a list of model ids")
  if (!posInt(fb.max_targets)) fail("fallbacks.max_targets", "must be a positive integer")
  if (fb.context_hub !== null && typeof fb.context_hub !== "string") fail("fallbacks.context_hub", "must be a model id or null")
  if (!strList(x.exclude)) fail("exclude", "must be a list of model ids")
  if (!isObj(x.aliases) || !Object.values(x.aliases).every((s) => typeof s === "string")) fail("aliases", "must map alias -> model id")
  if (!isObj(x.models)) fail("models", "must be an object")
  for (const [id, m] of Object.entries(x.models)) {
    const p = `models["${id}"]`
    if (!isObj(m)) fail(p, "must be an object")
    if (m.context !== undefined && !posInt(m.context)) fail(`${p}.context`, "must be a positive integer")
    if (m.max_output !== undefined && !posInt(m.max_output)) fail(`${p}.max_output`, "must be a positive integer")
    if (m.vision !== undefined && typeof m.vision !== "boolean") fail(`${p}.vision`, "must be true or false")
    if (m.tools !== undefined && typeof m.tools !== "boolean") fail(`${p}.tools`, "must be true or false")
    if (m.note !== undefined && typeof m.note !== "string") fail(`${p}.note`, "must be a string")
    if (m.price !== undefined) {
      const pr = m.price
      if (!isObj(pr) || !nonNeg(pr.input) || !nonNeg(pr.output)) fail(`${p}.price`, "needs non-negative input and output (USD per 1M tokens)")
      for (const k of ["cache_read", "cache_write"] as const) {
        if (pr[k] !== undefined && !nonNeg(pr[k])) fail(`${p}.price.${k}`, "must be a non-negative number")
      }
    }
  }
  for (const [alias, target] of Object.entries(x.aliases as Record<string, string>)) {
    if (!(target in x.models)) fail(`aliases["${alias}"]`, `points at "${target}", which has no models entry`)
  }
  return x as unknown as ModelsFile
}
