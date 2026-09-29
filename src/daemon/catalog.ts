import type { ModelsFile, Price } from "../shared/models-file"
import { deriveChains, deriveContextChains } from "./fallbacks"
import type { Model, ModelPrice } from "./model"

export type UfrModel = { id: string; name: string; tier: "free" | "paid"; vision: boolean }

export type Catalog = {
  models: Map<string, Model>
  aliases: Map<string, string>
  chains: Map<string, string[]>
  contextChains: Map<string, string[]>
  warnings: string[]
}

export const EMPTY_CATALOG: Catalog = {
  models: new Map(),
  aliases: new Map(),
  chains: new Map(),
  contextChains: new Map(),
  warnings: [],
}

type RawUfrModel = {
  id?: unknown
  name?: unknown
  connection_type?: unknown
  info?: { meta?: { capabilities?: { vision?: unknown } } }
}

/** UFR's /api/models: `external` = UFR pays a vendor per token (OpenAI, Mistral). */
export function parseUfrModels(raw: unknown): UfrModel[] {
  const list = Array.isArray(raw) ? raw : (raw as { data?: unknown } | null)?.data
  if (!Array.isArray(list)) throw new Error("UFR /api/models: unexpected response shape")
  return (list as RawUfrModel[])
    .filter((m) => m && typeof m.id === "string")
    .map((m) => ({
      id: m.id as string,
      name: typeof m.name === "string" && m.name.trim() ? m.name.trim() : (m.id as string),
      tier: m.connection_type === "external" ? "paid" : "free",
      vision: Boolean(m.info?.meta?.capabilities?.vision),
    }))
}

function toPrice(p: Price | undefined): ModelPrice | null {
  if (!p) return null
  return { input: p.input, output: p.output, cacheRead: p.cache_read ?? p.input, cacheWrite: p.cache_write ?? p.input }
}

export function buildCatalog(ufr: UfrModel[], file: ModelsFile, opts: { allowPaid: boolean }): Catalog {
  const warnings: string[] = []
  const exclude = new Set(file.exclude)
  const models = new Map<string, Model>()
  for (const u of ufr) {
    const e = file.models[u.id]
    models.set(u.id, {
      id: u.id,
      name: u.name,
      tier: u.tier,
      vision: e?.vision ?? u.vision,
      tools: e?.tools ?? true,
      context: e?.context ?? file.defaults.context,
      maxOutput: e?.max_output ?? file.defaults.max_output,
      price: toPrice(e?.price),
      hasEntry: e !== undefined,
      hidden: exclude.has(u.id),
    })
  }
  const aliases = new Map<string, string>()
  for (const [alias, target] of Object.entries(file.aliases)) {
    if (!models.has(target)) continue
    aliases.set(alias, target)
    models.delete(alias) // UFR may list the alias spelling too; one entry per model
  }
  for (const m of models.values()) {
    if (!m.hasEntry) {
      warnings.push(`${m.id}: new at UFR, no models.json entry — using defaults (context ${m.context}, output ${m.maxOutput}), no fallbacks`)
    } else if (!m.price && !m.hidden) {
      warnings.push(`${m.id}: no price in models.json — cost shown as unknown`)
    }
  }
  const hub = file.fallbacks.context_hub
  if (hub && !models.has(hub)) warnings.push(`context hub ${hub} is not served by UFR — context fallback disabled`)
  return {
    models,
    aliases,
    chains: deriveChains(models, file.fallbacks, opts),
    contextChains: deriveContextChains(models, hub, opts),
    warnings,
  }
}

export function resolveModel(cat: Catalog, name: string): string {
  return cat.aliases.get(name) ?? name
}

export type OpencodeStamp = {
  name: string
  limit: { context: number; output: number }
  cost?: { input: number; output: number; cache_read: number; cache_write: number }
  tool_call: boolean
  attachment: boolean
  reasoning: boolean
  temperature: boolean
}

/**
 * What the plugin needs per model. reasoning=false for every UFR route
 * (measured reasoning_effort inert upstream); temperature is accepted everywhere.
 */
export function opencodeStamp(m: Model): OpencodeStamp {
  const s: OpencodeStamp = {
    name: m.name,
    limit: { context: m.context, output: m.maxOutput },
    tool_call: m.tools,
    attachment: m.vision,
    reasoning: false,
    temperature: true,
  }
  if (m.price) s.cost = { input: m.price.input, output: m.price.output, cache_read: m.price.cacheRead, cache_write: m.price.cacheWrite }
  return s
}

export function listModels(cat: Catalog) {
  return [...cat.models.values()]
    .filter((m) => !m.hidden)
    .map((m) => ({ id: m.id, object: "model" as const, owned_by: "ufr" as const, opencode: opencodeStamp(m) }))
}
