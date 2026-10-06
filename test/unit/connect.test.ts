import { afterEach, describe, expect, test } from "bun:test"
import { daemonRequest } from "../../src/shared/daemon-client"
import { nextAliases, splitKeys } from "../../src/shared/connect"
import { applyKeyChange, disconnectAll } from "../../src/shared/keys"
import { loadConfig } from "../../src/shared/config"
import { daemonEnv } from "../support/daemon-env"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  await env?.cleanup()
  env = null
})

describe("splitKeys", () => {
  test("commas AND newlines, whitespace filtered, empties dropped", () => {
    expect(splitKeys("a, b ,c")).toEqual(["a", "b", "c"])
    expect(splitKeys("  k1  ,\n  k2\n\nk3,")).toEqual(["k1", "k2", "k3"])
    expect(splitKeys(",,,")).toEqual([])
    expect(splitKeys("single")).toEqual(["single"])
  })
})

describe("nextAliases", () => {
  test("skips numbers already in use", () => {
    expect(nextAliases([], 3)).toEqual(["key1", "key2", "key3"])
    expect(nextAliases(["key1", "key3"], 2)).toEqual(["key2", "key4"])
    expect(nextAliases(["main"], 2)).toEqual(["key1", "key2"])
  })
})

describe("disconnectAll (provider removal)", () => {
  test("wipes every stored key, the uni login and config.keys, and stops an idle gateway", async () => {
    env = await daemonEnv({ keys: { key1: "k1", "ufr-A": "ka" } })
    await env.secrets.set("vpn-login", "xx0000@uni-freiburg.de")
    await env.secrets.set("vpn-pass", "pw")
    await env.start() // a running gateway must be stopped by the wipe
    const logs: string[] = []
    const r = await disconnectAll({ paths: env.paths, secrets: env.secrets, fetch: (u, i) => fetch(u, i), log: (m) => logs.push(m) })
    expect(r.removed).toEqual(["key1", "ufr-A"])
    expect(r.loginRemoved).toBe(true)
    expect(await env.secrets.get("key1")).toBeNull()
    expect(await env.secrets.get("ufr-A")).toBeNull()
    expect(await env.secrets.get("vpn-login")).toBeNull()
    expect(await env.secrets.get("vpn-pass")).toBeNull()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
    // the gateway stops asynchronously (20 ms after the shutdown answer) — poll for it
    const gone = async () => {
      for (let i = 0; i < 100; i++) {
        const status = await daemonRequest(env!.paths, (u, i) => fetch(u, i), "/v1/_status")
        if (!(status?.ok ?? false)) return true
        await new Promise((r) => setTimeout(r, 25))
      }
      return false
    }
    expect(await gone()).toBe(true)
  })

  test("nothing stored → a no-op that leaves a clean config", async () => {
    env = await daemonEnv({ keys: {} })
    const r = await disconnectAll({ paths: env.paths, secrets: env.secrets, fetch: (u, i) => fetch(u, i), log: () => {} })
    expect(r.removed).toEqual([])
    expect(r.loginRemoved).toBe(false)
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
  })

  test("an orphaned managed alias (crash between secrets.set and saveConfig) is swept too", async () => {
    env = await daemonEnv({ keys: {} })
    await env.secrets.set("key2", "orphan") // config.keys never listed it
    const r = await disconnectAll({ paths: env.paths, secrets: env.secrets, fetch: (u, i) => fetch(u, i), log: () => {} })
    expect(r.removed).toEqual(["key2"])
    expect(await env.secrets.get("key2")).toBeNull()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
  })
})

describe("applyKeyChange", () => {
  test("stops an idle running gateway so it restarts with the new keys", async () => {
    env = await daemonEnv({ keys: {} })
    await env.start()
    const logs: string[] = []
    await applyKeyChange({ paths: env.paths, fetch: (u, i) => fetch(u, i), log: (m) => logs.push(m) })
    expect(logs.join("\n")).toContain("gateway stopped")
    // the gateway stops asynchronously (20 ms after the shutdown answer) — poll for it
    const gone = async () => {
      for (let i = 0; i < 100; i++) {
        const status = await daemonRequest(env!.paths, (u, i) => fetch(u, i), "/v1/_status")
        if (!(status?.ok ?? false)) return true
        await new Promise((r) => setTimeout(r, 25))
      }
      return false
    }
    expect(await gone()).toBe(true)
  })

  test("no gateway running → a no-op", async () => {
    env = await daemonEnv({ keys: {} })
    const logs: string[] = []
    await applyKeyChange({ paths: env.paths, fetch: (u, i) => fetch(u, i), log: (m) => logs.push(m) })
    expect(logs).toEqual([])
  })

  test("a gateway whose state cannot be read is left alone with an honest log", async () => {
    env = await daemonEnv({ keys: {} })
    await env.start()
    const fakeFetch = async (url: string, init?: RequestInit) => {
      if (new URL(url).pathname === "/v1/_status") return Response.json({ nope: true }) // state unreadable
      return fetch(url, init)
    }
    const logs: string[] = []
    await applyKeyChange({ paths: env.paths, fetch: fakeFetch, log: (m) => logs.push(m) })
    expect(logs.join("\n")).toContain("couldn't read gateway state")
    // the gateway must still be running — nothing was stopped on a guess
    const status = await daemonRequest(env.paths, (u, i) => fetch(u, i), "/v1/_status")
    expect(status?.ok ?? false).toBe(true)
  })
})
