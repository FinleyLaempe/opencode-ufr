import { describe, expect, test } from "bun:test"
import { Stats, costUsd, type RequestRow } from "../../src/daemon/stats"

const GLM = { input: 0.4, output: 0.4, cacheRead: 0.4, cacheWrite: 0.4 }
const row = (over: Partial<RequestRow> = {}): RequestRow => ({
  ts: 1_000, model: "glm-5.2-llmlb", keyAlias: "main", status: 200, promptTokens: 10, completionTokens: 2,
  costUsd: costUsd(GLM, 10, 2), latencyMs: 50, attempts: 1, errorType: null, poolAdmitted: true, ...over,
})

describe("costUsd", () => {
  test("reproduces the 2026-09-28 portal measurement", () => {
    // phase A: 267 168 prompt + 60 completion tokens on glm-5.2 → portal 0.53 % of $20
    expect(costUsd(GLM, 267_168, 60)!).toBeCloseTo(0.1069, 4)
  })

  test("cache reads and writes are priced separately from plain input", () => {
    // deepseek 2026-11-09: reads free, writes at the input price; 3.63M cached of 3.74M prompt
    const DS = { input: 0.025, output: 0.025, cacheRead: 0, cacheWrite: 0.025 }
    expect(costUsd(DS, 3_740_080, 200, 3_634_176, 93_184)!).toBeCloseTo((3_740_080 - 3_634_176) * 0.025e-6 + 200 * 0.025e-6, 9)
    // OpenAI luna: write 1.25x input, read 0.1x
    const LUNA = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
    expect(costUsd(LUNA, 9633, 4, 0, 9630)!).toBeCloseTo((3 * 0.1 + 9630 * 0.125 + 4 * 0.5) / 1e6, 12)
    expect(costUsd(LUNA, 9633, 4, 9630, 0)!).toBeCloseTo((3 * 0.1 + 9630 * 0.01 + 4 * 0.5) / 1e6, 12)
  })

  test("a catalog price without cache prices bills cached tokens as input", () => {
    expect(costUsd(GLM, 1000, 0, 900, 0)!).toBeCloseTo(costUsd(GLM, 1000, 0)!, 12)
  })

  test("cached + written can never exceed the prompt", () => {
    const P = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }
    expect(costUsd(P, 100, 0, 80, 80)!).toBe(0)
  })

  test("unknown price means unknown cost", () => {
    expect(costUsd(null, 10, 2)).toBeNull()
  })
})

describe("Stats", () => {
  test("summaries per model and per key, unpriced counted separately", () => {
    const s = new Stats(":memory:")
    s.record(row())
    s.record(row({ keyAlias: "alt", model: "mistral-small-4-llmlb", costUsd: null }))
    s.record(row({ status: 429, errorType: "upstream_rate_limited", costUsd: null, promptTokens: 0, completionTokens: 0 }))
    const { byModel, byKey } = s.summary(0)
    const glm = byModel.find((r) => r.name === "glm-5.2-llmlb")!
    expect(glm).toMatchObject({ requests: 2, errors: 1, promptTokens: 10, completionTokens: 2, unpriced: 0 })
    expect(glm.costUsd).toBeCloseTo(4.8e-6, 12)
    expect(byModel.find((r) => r.name === "mistral-small-4-llmlb")!.unpriced).toBe(1)
    expect(byKey.map((r) => r.name).sort()).toEqual(["alt", "main"])
  })

  test("pool admissions since a time exclude locally rejected requests", () => {
    const s = new Stats(":memory:")
    s.record(row({ ts: 100 }))
    s.record(row({ ts: 150 })) // boundary: "since" is inclusive, like spendByKeySince
    s.record(row({ ts: 200, poolAdmitted: false }))
    s.record(row({ ts: 300 }))
    expect(s.poolAdmissionsSince(150)).toEqual([150, 300])
  })

  test("spend per key since a time", () => {
    const s = new Stats(":memory:")
    s.record(row({ ts: 100 }))
    s.record(row({ ts: 200 }))
    s.record(row({ ts: 50, keyAlias: "alt" }))
    const spend = s.spendByKeySince(100)
    expect(spend.main).toBeCloseTo(9.6e-6, 12)
    expect(spend.alt).toBeUndefined()
  })

  test("prune deletes old rows; kv round-trips", () => {
    const s = new Stats(":memory:")
    s.record(row({ ts: 1 }))
    s.record(row({ ts: 10 }))
    expect(s.prune(5)).toBe(1)
    expect(s.summary(0).byModel[0]!.requests).toBe(1)
    s.setKv("breakers", "{}")
    s.setKv("breakers", '{"a":1}')
    expect(s.getKv("breakers")).toBe('{"a":1}')
    expect(s.getKv("missing")).toBeNull()
  })
})
