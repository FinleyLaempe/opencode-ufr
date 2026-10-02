import { readText, writeFileAtomic } from "./fs"

export type Config = {
  schema: 1
  port: number | null
  transport: { type: "direct" | "auto" }
  vpn: { gateway: string; mode: "auto" | "always" }
  upstream: { baseUrl: string; requestTimeoutS: number }
  keys: string[]
  limits: {
    keyRpm: number
    keyWindowS: number
    keyMaxWaitS: number
    poolPerHour: number
    poolWindowS: number
    poolMaxWaitS: number
    maxUpstreamAttempts: number
  }
  breaker: { tripThreshold: number; ladderS: number[]; probeTimeoutS: number }
  allowPaid: boolean
  dailyBudgetUsd: number
  idleShutdownMin: number
}

export const DEFAULTS: Config = {
  schema: 1,
  port: null,
  // "auto": reach UFR directly when possible, otherwise through the built-in
  // Fortinet tunnel (needs a stored uni login; behaves like "direct" otherwise).
  transport: { type: "auto" },
  vpn: { gateway: "https://fortivpn.uni-freiburg.de", mode: "auto" },
  upstream: { baseUrl: "https://openwebui.uni-freiburg.de/api", requestTimeoutS: 600 },
  keys: [],
  limits: {
    keyRpm: 18,
    keyWindowS: 60,
    keyMaxWaitS: 60,
    poolPerHour: 800,
    poolWindowS: 3600,
    poolMaxWaitS: 20,
    maxUpstreamAttempts: 4,
  },
  breaker: { tripThreshold: 3, ladderS: [30, 120, 300, 900, 1800, 3600], probeTimeoutS: 120 },
  allowPaid: false,
  dailyBudgetUsd: 20,
  idleShutdownMin: 5,
}

export class ConfigError extends Error {}

type Rule = "int>=0" | "int>=1" | "num>=0" | "bool" | "str" | "port|null" | "aliases" | "int>=1[]" | "transport" | "vpnMode"

const RULES: Record<string, Rule> = {
  port: "port|null",
  "transport.type": "transport",
  "vpn.gateway": "str",
  "vpn.mode": "vpnMode",
  "upstream.baseUrl": "str",
  "upstream.requestTimeoutS": "int>=1",
  keys: "aliases",
  "limits.keyRpm": "int>=1",
  "limits.keyWindowS": "int>=1",
  "limits.keyMaxWaitS": "int>=0",
  "limits.poolPerHour": "int>=0",
  "limits.poolWindowS": "int>=1",
  "limits.poolMaxWaitS": "int>=0",
  "limits.maxUpstreamAttempts": "int>=1",
  "breaker.tripThreshold": "int>=1",
  "breaker.ladderS": "int>=1[]",
  "breaker.probeTimeoutS": "int>=1",
  allowPaid: "bool",
  dailyBudgetUsd: "num>=0",
  idleShutdownMin: "int>=1",
}

// Upper bounds for values that become setTimeout/setInterval delays: above 2^31-1 ms
// Bun clamps a timer to 1 ms, which would turn e.g. the catalog refresh into a tight loop.
// For an array (breaker.ladderS) the bound applies to every entry.
const MAX: Record<string, number> = {
  "upstream.requestTimeoutS": 86_400,
  "limits.keyWindowS": 86_400,
  "limits.keyMaxWaitS": 86_400,
  "limits.poolWindowS": 86_400,
  "limits.poolMaxWaitS": 86_400,
  "breaker.ladderS": 86_400,
  "breaker.probeTimeoutS": 86_400,
  idleShutdownMin: 1_440,
}

export const ALIAS_RE = /^[A-Za-z0-9._-]{1,32}$/

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x)
const isInt = (x: unknown): x is number => typeof x === "number" && Number.isInteger(x)

function deepMerge(base: unknown, over: unknown): unknown {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(over)) out[k] = deepMerge(base[k], v)
  return out
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (isObj(o) ? o[k] : undefined), obj)
}

function valid(v: unknown, rule: Rule): boolean {
  switch (rule) {
    case "int>=0":
      return isInt(v) && v >= 0
    case "int>=1":
      return isInt(v) && v >= 1
    case "num>=0":
      return typeof v === "number" && Number.isFinite(v) && v >= 0
    case "bool":
      return typeof v === "boolean"
    case "str":
      return typeof v === "string" && v.length > 0
    case "port|null":
      return v === null || (isInt(v) && v >= 1 && v <= 65535)
    case "aliases":
      return Array.isArray(v) && v.every((s) => typeof s === "string" && ALIAS_RE.test(s))
    case "int>=1[]":
      return Array.isArray(v) && v.length > 0 && v.every((x) => isInt(x) && x >= 1)
    case "transport":
      return v === "direct" || v === "auto"
    case "vpnMode":
      return v === "auto" || v === "always"
  }
}

export function mergeConfig(raw: unknown): Config {
  if (raw !== undefined && !isObj(raw)) throw new ConfigError("config: the top level must be a JSON object")
  if (isObj(raw) && raw.schema !== undefined && raw.schema !== 1) {
    throw new ConfigError(`config: unsupported schema ${JSON.stringify(raw.schema)} (this version reads schema 1)`)
  }
  const cfg = deepMerge(structuredClone(DEFAULTS), raw ?? {}) as Config
  for (const [path, rule] of Object.entries(RULES)) {
    const v = get(cfg, path)
    if (!valid(v, rule)) throw new ConfigError(`config: ${path} is invalid (${JSON.stringify(v)}), expected ${rule}`)
    const max = MAX[path]
    if (max !== undefined && (Array.isArray(v) ? v : [v]).some((x) => (x as number) > max)) {
      const what = Array.isArray(v) ? "every entry must be" : "must be"
      throw new ConfigError(`config: ${path} is too large (${JSON.stringify(v)}), ${what} at most ${max}`)
    }
  }
  if (new Set(cfg.keys).size !== cfg.keys.length) throw new ConfigError("config: keys contains duplicate aliases")
  return { ...cfg, schema: 1 }
}

export async function loadConfig(file: string): Promise<Config> {
  const text = await readText(file)
  if (text === null) return structuredClone(DEFAULTS)
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (e) {
    throw new ConfigError(`config: ${file} is not valid JSON (${(e as Error).message})`)
  }
  return mergeConfig(raw)
}

export async function saveConfig(file: string, cfg: Config): Promise<void> {
  mergeConfig(cfg) // refuse to write something we could not read back
  await writeFileAtomic(file, JSON.stringify(cfg, null, 2) + "\n")
}
