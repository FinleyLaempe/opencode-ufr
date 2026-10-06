import { describe, expect, test } from "bun:test"
import { applyProbeResults, formatProbeReport, probeAllContexts, sizesFor } from "../../src/daemon/probe-all"
import type { UfrModel } from "../../src/daemon/catalog"
import type { ModelsFile } from "../../src/shared/models-file"

const FILE: ModelsFile = {
  schema: 1,
  updated: "2026-10-01",
  defaults: { context: 131_072, max_output: 16_384 },
  fallbacks: { free_escape_order: [], max_targets: 4, context_hub: null },
  exclude: ["standard-chat-ufr"],
  aliases: {},
  models: {
    "small-llmlb": { context: 131_072 },
    "grown-llmlb": { context: 131_072 },
    "unknown-llmlb": {},
    "noisy-llmlb": { context: 262_144 },
  },
}

const UFR_LIST: UfrModel[] = [
  { id: "small-llmlb", name: "Small", tier: "free", vision: false },
  { id: "grown-llmlb", name: "Grown", tier: "free", vision: false },
  { id: "unknown-llmlb", name: "Unknown", tier: "free", vision: false },
  { id: "external-llmlb", name: "External", tier: "paid", vision: false },
  { id: "standard-chat-ufr", name: "Standard", tier: "free", vision: false },
]

const LIMIT_NAMED = (n: number) =>
  JSON.stringify({
    detail: `litellm.ContextWindowExceededError: This model's maximum context length is ${n} tokens. However, you requested 1 output tokens`,
  })

/** Fake UFR: each model has a true context limit; requests above it get the LiteLLM 400, below a 200. */
function fakeUfr(limits: Record<string, number>) {
  const calls: { model: string; approxTokens: number }[] = []
  return {
    calls,
    call: async (body: Record<string, unknown>) => {
      const b = body as { model: string; messages: { content: string }[] }
      const approxTokens = Math.round((b.messages[0]!.content.length * 2) / 9) // filler ≈ 4.5 chars/token
      calls.push({ model: b.model, approxTokens })
      const limit = limits[b.model]
      if (approxTokens > limit) return { status: 400, body: LIMIT_NAMED(limit) }
      return { status: 200, body: JSON.stringify({ usage: { prompt_tokens: approxTokens } }) }
    },
  }
}

const deps = (call: (body: Record<string, unknown>) => Promise<{ status: number; body: string }>, o: Partial<Parameters<typeof probeAllContexts>[0]> = {}) => ({
  call,
  ufr: UFR_LIST,
  file: FILE,
  paceMs: 0,
  sleep: () => Promise.resolve(), // no real 20 s backoff in tests
  log: () => {},
  ...o,
})

describe("probeAllContexts", () => {
  test("known context: one rejected rung names the exact limit", async () => {
    const { call, calls } = fakeUfr({ "small-llmlb": 131_072, "grown-llmlb": 131_072, "unknown-llmlb": 262_144, "external-llmlb": 128_000 })
    const rows = await probeAllContexts(deps(call))
    const small = rows.find((r) => r.id === "small-llmlb")!
    expect(small).toEqual({ id: "small-llmlb", tier: "free", known: 131_072, probed: 131_072, how: "error-named" })
    expect(calls.filter((c) => c.model === "small-llmlb")).toHaveLength(1) // no escalation needed
  })

  test("grown context escalates rungs and names the new limit", async () => {
    const { call, calls } = fakeUfr({ "small-llmlb": 131_072, "grown-llmlb": 400_000, "unknown-llmlb": 262_144 })
    const rows = await probeAllContexts(deps(call))
    const grown = rows.find((r) => r.id === "grown-llmlb")!
    expect(grown.how).toBe("error-named")
    expect(grown.probed).toBe(400_000) // UFR renamed the limit at the rejected 524k rung
    expect(calls.filter((c) => c.model === "grown-llmlb").length).toBe(3) // escalated twice before the reject
  })

  test("unknown models use one oversized rung and name the limit", async () => {
    const { call, calls } = fakeUfr({ "small-llmlb": 131_072, "grown-llmlb": 131_072, "unknown-llmlb": 262_144 })
    const rows = await probeAllContexts(deps(call))
    const unknown = rows.find((r) => r.id === "unknown-llmlb")!
    expect(unknown.how).toBe("error-named")
    expect(unknown.probed).toBe(262_144)
    expect(calls.filter((c) => c.model === "unknown-llmlb")).toHaveLength(1) // rejected = free, no ladder needed
  })

  test("paid models are skipped unless included; excluded models skipped always", async () => {
    const { call } = fakeUfr({ "small-llmlb": 131_072, "grown-llmlb": 131_072, "unknown-llmlb": 262_144, "external-llmlb": 128_000 })
    const rows = await probeAllContexts(deps(call))
    expect(rows.find((r) => r.id === "external-llmlb")!.how).toBe("skipped-paid")
    expect(rows.find((r) => r.id === "standard-chat-ufr")!.how).toBe("skipped-hidden")

    const paid = await probeAllContexts(deps(call, { includePaid: true }))
    expect(paid.find((r) => r.id === "external-llmlb")!.how).toBe("error-named")
  })

  test("429 retries the same rung and then still gets the answer", async () => {
    let rateLimited = false
    const call = async (body: Record<string, unknown>) => {
      const b = body as { model: string }
      if (b.model !== "small-llmlb") return { status: 400, body: LIMIT_NAMED(131_072) }
      if (!rateLimited) {
        rateLimited = true
        return { status: 429, body: "budget_exceeded" }
      }
      return { status: 400, body: LIMIT_NAMED(131_072) }
    }
    const rows = await probeAllContexts(deps(call))
    expect(rows.find((r) => r.id === "small-llmlb")!.how).toBe("error-named")
  })
})

describe("report and models.json application", () => {
  test("report flags NEW and MISMATCH, tolerates sub-1% noise", () => {
    const report = formatProbeReport([
      { id: "a-llmlb", tier: "free", known: 131_072, probed: 131_072, how: "error-named" },
      { id: "b-llmlb", tier: "free", known: 100_000, probed: 262_144, how: "error-named" },
      { id: "c-llmlb", tier: "free", known: null, probed: 8_192, how: "error-named" },
      { id: "d-llmlb", tier: "free", known: 262_144, probed: 261_144, how: "error-named" },
      { id: "e-llmlb", tier: "paid", known: null, probed: null, how: "skipped-paid" },
    ])
    expect(report).toContain("ok")
    expect(report).toContain("MISMATCH (was 100,000)")
    expect(report).toContain("NEW — needs models.json entry")
    expect(report).toContain("ok (±1,000)") // output-reservation noise, not a context change
    expect(report).toContain("skipped-paid")
    expect(report).toContain("5 models, 2 needing a models.json update")
  })

  test("applyProbeResults updates drifted values, keeps notes, ignores floors and sub-1% noise", () => {
    const rows = [
      { id: "grown-llmlb", tier: "free" as const, known: 131_072, probed: 262_144, how: "error-named" as const },
      { id: "small-llmlb", tier: "free" as const, known: 131_072, probed: 131_072, how: "error-named" as const },
      { id: "unknown-llmlb", tier: "free" as const, known: null, probed: 300_000, how: "accepted-floor" as const },
      { id: "noisy-llmlb", tier: "free" as const, known: 262_144, probed: 261_144, how: "error-named" as const },
    ]
    const { file, changed } = applyProbeResults(FILE, rows, "2026-10-05")
    expect(changed).toEqual([{ id: "grown-llmlb", from: 131_072, to: 262_144 }])
    expect(file.models["grown-llmlb"]!.context).toBe(262_144)
    expect(file.models["grown-llmlb"]!.note).toContain("probed live 2026-10-05")
    expect(file.models["unknown-llmlb"]!.context).toBeUndefined() // accepted floor must not write
    expect(file.models["noisy-llmlb"]!.context).toBe(262_144) // within tolerance — untouched
    expect(file.updated).toBe("2026-10-05")
    expect(JSON.parse(JSON.stringify(file)).models["small-llmlb"].context).toBe(131_072)
  })

  test("applyProbeResults replaces an old context-probe note, keeps a price note", () => {
    const file: ModelsFile = JSON.parse(JSON.stringify(FILE))
    file.models["grown-llmlb"]!.note = "context 100000 probed live 2026-09-01 (probe-all-contexts)"
    file.models["small-llmlb"]!.note = "portal-measured 2026-09-28: price"
    const rows = [
      { id: "grown-llmlb", tier: "free" as const, known: 100_000, probed: 262_144, how: "error-named" as const },
      { id: "small-llmlb", tier: "free" as const, known: 131_072, probed: 262_144, how: "error-named" as const },
    ]
    const { file: out } = applyProbeResults(file, rows, "2026-10-05")
    expect(out.models["grown-llmlb"]!.note).not.toContain("2026-09-01")
    expect(out.models["small-llmlb"]!.note).toContain("portal-measured") // price note survives
    expect(out.models["small-llmlb"]!.note).toContain("probed live 2026-10-05")
  })
})

describe("sizesFor", () => {
  test("known context probes just above it, then doubles (max 3 rungs)", () => {
    expect(sizesFor(131_072)).toEqual([131_136, 262_208, 524_416])
    expect(sizesFor(1_048_576)).toEqual([1_048_640]) // next doubling exceeds the ceiling
    expect(sizesFor(8_000)).toEqual([8_064, 16_064, 32_128])
  })
  test("unknown context uses a single oversized rung", () => {
    expect(sizesFor(null)).toEqual([1_500_000])
  })
})
