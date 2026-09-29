import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ConfigError, DEFAULTS, loadConfig, mergeConfig, saveConfig } from "../../src/shared/config"

let dir = ""
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
  dir = ""
})
const tmp = async () => (dir = await mkdtemp(join(tmpdir(), "ufr-config-")))

describe("config", () => {
  test("defaults match the spec", () => {
    expect(DEFAULTS.limits).toEqual({
      keyRpm: 18, keyWindowS: 60, keyMaxWaitS: 60,
      poolPerHour: 800, poolWindowS: 3600, poolMaxWaitS: 20, maxUpstreamAttempts: 4,
    })
    expect(DEFAULTS.breaker).toEqual({ tripThreshold: 3, ladderS: [30, 120, 300, 900, 1800, 3600], probeTimeoutS: 120 })
    expect(DEFAULTS.port).toBeNull()
    expect(DEFAULTS.allowPaid).toBe(false)
    expect(DEFAULTS.dailyBudgetUsd).toBe(20)
    expect(DEFAULTS.idleShutdownMin).toBe(5)
    expect(DEFAULTS.upstream).toEqual({ baseUrl: "https://openwebui.uni-freiburg.de/api", requestTimeoutS: 600 })
    expect(DEFAULTS.catalog).toEqual({
      url: "https://raw.githubusercontent.com/FinleyLaempe/opencode-ufr/main/models.json",
      refreshHours: 6,
    })
    expect(DEFAULTS.transport).toEqual({ type: "direct" })
  })

  test("a missing file yields the defaults", async () => {
    const d = await tmp()
    expect(await loadConfig(join(d, "nope.json"))).toEqual(DEFAULTS)
  })

  test("partial files are deep-merged over the defaults", () => {
    const c = mergeConfig({ limits: { keyRpm: 10 }, keys: ["main"] })
    expect(c.limits.keyRpm).toBe(10)
    expect(c.limits.poolPerHour).toBe(800)
    expect(c.keys).toEqual(["main"])
  })

  test("invalid values name the offending path", () => {
    expect(() => mergeConfig({ limits: { keyRpm: 0 } })).toThrow(/limits\.keyRpm/)
    expect(() => mergeConfig({ port: 70000 })).toThrow(/port/)
    expect(() => mergeConfig({ keys: ["bad alias!"] })).toThrow(/keys/)
    expect(() => mergeConfig({ transport: { type: "socks5" } })).toThrow(/transport\.type/)
    expect(() => mergeConfig({ breaker: { ladderS: [] } })).toThrow(/breaker\.ladderS/)
    expect(() => mergeConfig({ schema: 2 })).toThrow(ConfigError)
    expect(() => mergeConfig(["not", "an", "object"])).toThrow(ConfigError)
  })

  test("values that become timers are bounded (a timer above 2^31-1 ms fires every 1 ms)", () => {
    expect(() => mergeConfig({ catalog: { refreshHours: 169 } })).toThrow(/catalog\.refreshHours.*at most 168/)
    expect(() => mergeConfig({ breaker: { ladderS: [30, 86_401] } })).toThrow(/breaker\.ladderS.*at most 86400/)
    const bounds: [string, number][] = [
      ["limits.keyWindowS", 86_400], ["limits.keyMaxWaitS", 86_400], ["limits.poolWindowS", 86_400],
      ["limits.poolMaxWaitS", 86_400], ["upstream.requestTimeoutS", 86_400], ["breaker.probeTimeoutS", 86_400],
      ["idleShutdownMin", 1_440],
    ]
    const at = (path: string, v: number): unknown => {
      const [head, tail] = path.split(".")
      return tail === undefined ? { [head!]: v } : { [head!]: { [tail]: v } }
    }
    for (const [path, max] of bounds) {
      expect(() => mergeConfig(at(path, max))).not.toThrow()
      expect(() => mergeConfig(at(path, max + 1))).toThrow(new RegExp(`${path.replace(".", "\\.")}.*at most ${max}`))
    }
    expect(mergeConfig({ catalog: { refreshHours: 168 }, breaker: { ladderS: [86_400] } }).catalog.refreshHours).toBe(168)
  })

  test("duplicate key aliases are rejected", () => {
    expect(() => mergeConfig({ keys: ["a", "a"] })).toThrow(/duplicate/)
  })

  test("a file that is not JSON gives a clear error", async () => {
    const d = await tmp()
    const f = join(d, "config.json")
    await writeFile(f, "{ nope")
    await expect(loadConfig(f)).rejects.toThrow(/not valid JSON/)
  })

  test("save then load round-trips and creates directories", async () => {
    const d = await tmp()
    const f = join(d, "deep", "dir", "config.json")
    const c = mergeConfig({ keys: ["main", "alt"], port: 47301 })
    await saveConfig(f, c)
    expect(await loadConfig(f)).toEqual(c)
    expect((await readFile(f, "utf8")).endsWith("\n")).toBe(true)
  })
})
