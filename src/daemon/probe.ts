/**
 * Auto-probe for models UFR serves but models.json does not describe yet:
 * one oversized request makes vLLM name its real context limit in the error
 * ("This model's maximum context length is N tokens"). Results are stored in
 * the stats DB and survive restarts — new models measure themselves, no
 * patches needed.
 */

import type { FetchLike } from "./catalog-source"

const LIMIT_RES = [
  /context length is (\d+)/i,
  /maximum context length[^\d]{0,40}(\d+)/i,
  /context window[^\d]{0,30}(\d+)/i,
]

export function parseLimitFromBody(body: string): number | null {
  for (const re of LIMIT_RES) {
    const m = re.exec(body)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 1024) return n
    }
  }
  return null
}

/** Prompt filler: ~4.5 chars per token for prose-like text. */
export function fillerForTokens(tokens: number): string {
  return "The quick brown fox jumps over the lazy dog. ".repeat(Math.ceil((tokens * 4.5) / 45))
}

export type ProbeResult = { context: number; how: "error-named" | "accepted-floor" } | null

/**
 * Ladder probe: sizes in tokens. The first error either names the limit
 * (done) or marks the ceiling; the last success sets the floor.
 */
export async function probeContextLimit(o: {
  model: string
  baseUrl: string
  key: string
  transport: { name: string; fetch(url: string, init?: RequestInit): Promise<Response> }
  sizes?: number[] // token counts to try, in order
  log: (m: string) => void
}): Promise<ProbeResult> {
  const sizes = o.sizes ?? [300_000, 600_000, 1_048_000, 1_500_000]
  let floor = 0
  for (const tokens of sizes) {
    const body = JSON.stringify({
      model: o.model,
      max_tokens: 1,
      messages: [{ role: "user", content: fillerForTokens(tokens) + "\n\nReply with exactly: OK" }],
    })
    let res: Response
    try {
      res = await o.transport.fetch(`${o.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${o.key}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(180_000),
        redirect: "manual",
      })
    } catch (e) {
      o.log(`context probe ${o.model}: transport error at ${tokens} tokens (${(e as Error).message})`)
      return floor > 0 ? { context: floor, how: "accepted-floor" } : null
    }
    if (res.ok) {
      const j = (await res.json().catch(() => null)) as { usage?: { prompt_tokens?: number } } | null
      floor = j?.usage?.prompt_tokens ?? tokens
      continue // accepted: try the next rung
    }
    const text = await res.text().catch(() => "")
    const named = parseLimitFromBody(text)
    if (named) {
      o.log(`context probe ${o.model}: the server names the limit: ${named} tokens`)
      return { context: named, how: "error-named" }
    }
    if (res.status === 400 || res.status === 413) {
      o.log(`context probe ${o.model}: rejected at ${tokens} tokens without naming a limit`)
      return floor > 0 ? { context: floor, how: "accepted-floor" } : null
    }
    // rate limit / auth / anything else: not a context answer, retry later
    o.log(`context probe ${o.model}: HTTP ${res.status} — will retry later`)
    return null
  }
  return floor > 0 ? { context: floor, how: "accepted-floor" } : null
}

export const PROBE_KV_KEY = "ctxprobes"

type ProbeStore = Record<string, { context: number; at: number }>

export function loadProbes(getKv: (k: string) => string | null): ProbeStore {
  try {
    const raw = getKv(PROBE_KV_KEY)
    const parsed = raw ? JSON.parse(raw) : null
    return parsed && typeof parsed === "object" ? (parsed as ProbeStore) : {}
  } catch {
    return {}
  }
}

export function saveProbe(
  store: ProbeStore,
  model: string,
  result: ProbeResult,
  setKv: (k: string, v: string) => void,
): void {
  if (!result) return
  store[model] = { context: result.context, at: Date.now() }
  setKv(PROBE_KV_KEY, JSON.stringify(store))
}
