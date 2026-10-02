import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { resolvePaths } from "../../src/shared/paths"

describe("resolvePaths", () => {
  test("linux defaults follow XDG under $HOME", () => {
    const p = resolvePaths({}, "linux", "/home/u")
    expect(p.configFile).toBe(join("/home/u", ".config", "opencode-ufr", "config.json"))
    expect(p.daemonFile).toBe(join("/home/u", ".local", "state", "opencode-ufr", "daemon.json"))
    expect(p.tokenFile).toBe(join("/home/u", ".local", "state", "opencode-ufr", "token"))
    expect(p.statsDb).toBe(join("/home/u", ".local", "share", "opencode-ufr", "stats.db"))
  })

  test("XDG variables win on linux and macOS", () => {
    const env = { XDG_CONFIG_HOME: "/x/c", XDG_STATE_HOME: "/x/s", XDG_CACHE_HOME: "/x/k", XDG_DATA_HOME: "/x/d" }
    const p = resolvePaths(env, "darwin", "/Users/u")
    expect(p.configDir).toBe(join("/x/c", "opencode-ufr"))
    expect(p.stateDir).toBe(join("/x/s", "opencode-ufr"))
    expect(p.cacheDir).toBe(join("/x/k", "opencode-ufr"))
    expect(p.dataDir).toBe(join("/x/d", "opencode-ufr"))
  })

  test("windows uses APPDATA for config and LOCALAPPDATA for the rest", () => {
    const p = resolvePaths({ APPDATA: "C:/R", LOCALAPPDATA: "C:/L" }, "win32", "C:/Users/u")
    expect(p.configDir).toBe(join("C:/R", "opencode-ufr"))
    expect(p.stateDir).toBe(join("C:/L", "opencode-ufr", "state"))
    expect(p.logFile).toBe(join("C:/L", "opencode-ufr", "state", "daemon.log"))
  })

  test("OPENCODE_UFR_HOME puts everything under one directory", () => {
    const p = resolvePaths({ OPENCODE_UFR_HOME: "/tmp/h", XDG_CONFIG_HOME: "/ignored" }, "linux", "/home/u")
    expect(p.configFile).toBe(join("/tmp/h", "config", "config.json"))
    expect(p.lockFile).toBe(join("/tmp/h", "state", "daemon.lock"))
    expect(p.ufrModelsCache).toBe(join("/tmp/h", "cache", "ufr-models.json"))
  })
})
