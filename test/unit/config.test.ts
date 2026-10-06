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
      keyRpm: 19, keyWindowS: 60, keyMaxWaitS: 60,
      poolPerHour: 0, poolWindowS: 3600, poolMaxWaitS: 20, maxUpstreamAttempts: 4,
    })
    expect(DEFAULTS.breaker).toEqual({ tripThreshold: 3, ladderS: [30, 120, 300, 900, 1800, 3600], probeTimeoutS: 120 })
    expect(DEFAULTS.port).toBeNull()
    expect(DEFAULTS.allowPaid).toBe(false)
    expect(DEFAULTS.dailyBudgetUsd).toBe(20)
    expect(DEFAULTS.idleShutdownMin).toBe(5)
    expect(DEFAULTS.upstream).toEqual({ baseUrl: "https://openwebui.uni-freiburg.de/api", requestTimeoutS: 600 })
    expect(DEFAULTS.transport).toEqual({ type: "auto" })
  })

  test("a missing file yields the defaults", async () => {
    const d = await tmp()
    expect(await loadConfig(join(d, "nope.json"))).toEqual(DEFAULTS)
  })

  test("partial files are deep-merged over the defaults", () => {
    const c = mergeConfig({ limits: { keyRpm: 10 }, keys: ["main"] })
    expect(c.limits.keyRpm).toBe(10)
    expect(c.limits.poolPerHour).toBe(0)
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
    expect(mergeConfig({ breaker: { ladderS: [86_400] } }).breaker.ladderS).toEqual([86_400])
  })

  test("unknown keys are rejected (a typo must not be silently ignored)", () => {
    expect(() => mergeConfig({ limits: { keyrpm: 5 } })).toThrow(/unknown key "limits\.keyrpm"/)
    expect(() => mergeConfig({ limts: { keyRpm: 5 } })).toThrow(/unknown key "limts"/)
    expect(() => mergeConfig({ port: 47300, unknownThing: 1 })).toThrow(/unknown key "unknownThing"/)
  })

  test("a removed legacy key is dropped with a warning instead of bricking startup", () => {
    const warns: string[] = []
    const c = mergeConfig({ catalog: { whatever: 1 } }, (m) => warns.push(m))
    expect("catalog" in c).toBe(false)
    expect(warns).toEqual([expect.stringMatching(/dropping removed key "catalog" — obsolete/)])
    expect(() => mergeConfig({ catalog: { whatever: 1 } })).not.toThrow()
  })

  test("a config file holding a removed legacy key loads (and the key is gone)", async () => {
    const d = await tmp()
    const f = join(d, "config.json")
    await writeFile(f, JSON.stringify({ catalog: { old: true }, port: 47300 }))
    const c = await loadConfig(f)
    expect(c.port).toBe(47300)
    expect("catalog" in c).toBe(false)
  })

  test("a mistyped section reports a type error, not an unknown key", () => {
    expect(() => mergeConfig({ limits: null })).toThrow(/limits\.keyRpm is invalid/)
    expect(() => mergeConfig({ limits: null })).not.toThrow(/unknown key/)
  })

  test("duplicate key aliases are rejected", () => {
    expect(() => mergeConfig({ keys: ["a", "a"] })).toThrow(/duplicate/)
  })

  test("the reserved uni-login aliases are rejected as keys", () => {
    expect(() => mergeConfig({ keys: ["vpn-login"] })).toThrow(/reserved/)
    expect(() => mergeConfig({ keys: ["vpn-pass"] })).toThrow(/reserved/)
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
