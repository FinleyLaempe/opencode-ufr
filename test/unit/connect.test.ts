import { afterEach, describe, expect, test } from "bun:test"
import { type CliDeps, main } from "../../src/cli/index"
import { daemonRequest } from "../../src/cli/daemon-client"
import { disconnectAll } from "../../src/cli/keys"
import { loadConfig } from "../../src/shared/config"
import { daemonEnv } from "../support/daemon-env"
import { testIo } from "../support/io"
import { nextAliases, splitKeys } from "../../src/cli/connect"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  await env?.cleanup()
  env = null
})

async function cli(argv: string[], answers: (string | boolean)[] = [], o: { keys?: Record<string, string> } = {}) {
  env ??= await daemonEnv({ keys: o.keys ?? {} })
  const t = testIo(answers)
  const deps: Partial<CliDeps> = {
    paths: env.paths,
    secrets: env.secrets,
    io: t.io,
    fetch: (u, i) => fetch(u, i),
    now: Date.now,
    runOpencode: async () => 0,
  }
  const code = await main(argv, deps)
  return { code, out: t.out(), err: t.err(), left: t.left() }
}

describe("ufr connect", () => {
  test("splitKeys: commas AND newlines, whitespace filtered, empties dropped", () => {
    expect(splitKeys("a, b ,c")).toEqual(["a", "b", "c"])
    expect(splitKeys("  k1  ,\n  k2\n\nk3,")).toEqual(["k1", "k2", "k3"])
    expect(splitKeys(",,,")).toEqual([])
    expect(splitKeys("single")).toEqual(["single"])
  })

  test("nextAliases skips numbers already in use", () => {
    expect(nextAliases([], 3)).toEqual(["key1", "key2", "key3"])
    expect(nextAliases(["key1", "key3"], 2)).toEqual(["key2", "key4"])
    expect(nextAliases(["main"], 2)).toEqual(["key1", "key2"])
  })

  test("non-interactive: --keys with comma separation stores key1..keyN, verified", async () => {
    const r = await cli(["connect", "--keys", "key-a, key-b ,key-c"])
    expect(r.code).toBe(0)
    expect(await env!.secrets.get("key1")).toBe("key-a")
    expect(await env!.secrets.get("key2")).toBe("key-b")
    expect(await env!.secrets.get("key3")).toBe("key-c")
    expect((await loadConfig(env!.paths.configFile)).keys).toEqual(["key1", "key2", "key3"])
    expect(r.out).toContain("key1\tok")
    expect(r.out + r.err).not.toContain("key-a") // keys never echoed
  })

  test("non-interactive: login without --password is refused", async () => {
    const r = await cli(["connect", "--login", "xx0000@uni-freiburg.de", "--keys", "key-a"])
    expect(r.code).toBe(2)
    expect(r.err).toContain("--password is required")
  })

  test("full non-interactive: login + password + keys in one call", async () => {
    const r = await cli(["connect", "--login", "xx0000@uni-freiburg.de", "--password", "pw", "--keys", "key-a"])
    expect(r.code).toBe(0)
    expect(await env!.secrets.get("vpn-login")).toBe("xx0000@uni-freiburg.de")
    expect(await env!.secrets.get("vpn-pass")).toBe("pw")
    expect(await env!.secrets.get("key1")).toBe("key-a")
    expect(r.out).toContain("login\tstored for xx0000@uni-freiburg.de")
    expect(r.out + r.err).not.toContain("pw")
  })

  test("interactive in a TTY: prompts for keys and login, empty login skips", async () => {
    env = await daemonEnv({ keys: {} })
    const t = testIo(["key-a, key-b", "", false], { isTTY: true })
    const deps: Partial<CliDeps> = {
      paths: env.paths,
      secrets: env.secrets,
      io: t.io,
      fetch: (u, i) => fetch(u, i),
      now: Date.now,
      runOpencode: async () => 0,
    }
    const code = await main(["connect"], deps)
    expect(code).toBe(0)
    expect(await env.secrets.get("key1")).toBe("key-a")
    expect(await env.secrets.get("key2")).toBe("key-b")
    expect(await env.secrets.get("vpn-login")).toBeNull()
  })

  test("a key UFR rejects is not stored; the rest are", async () => {
    const r = await cli(["connect", "--keys", "sk-wrong,key-a"])
    expect(r.code).toBe(1)
    expect(await env!.secrets.get("key1")).toBeNull()
    expect(await env!.secrets.get("key2")).toBe("key-a")
    expect(r.err).toContain("INVALID")
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
})

describe("ufr disconnect", () => {
  test("wipes keys, the uni login and config.keys, and reports what went", async () => {
    env = await daemonEnv({ keys: { key1: "k1" } })
    await env.secrets.set("vpn-login", "xx0000@uni-freiburg.de")
    await env.secrets.set("vpn-pass", "pw")
    const t = testIo([])
    const code = await main(["disconnect"], {
      paths: env.paths,
      secrets: env.secrets,
      io: t.io,
      fetch: (u, i) => fetch(u, i),
      now: Date.now,
      runOpencode: async () => 0,
    })
    expect(code).toBe(0)
    expect(await env.secrets.get("key1")).toBeNull()
    expect(await env.secrets.get("vpn-login")).toBeNull()
    expect(await env.secrets.get("vpn-pass")).toBeNull()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
    expect(t.out()).toContain("key1")
    expect(t.out()).toContain("uni login")
  })

  test("nothing stored → still exit 0", async () => {
    const r = await cli(["disconnect"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("nothing")
  })
})
