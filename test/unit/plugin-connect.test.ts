import { afterEach, describe, expect, test } from "bun:test"
import { CONNECT_POLL_MS, credentialToInput, registerConnect, UFR_INTEGRATION_ID } from "../../src/plugin/connect"
import { daemonRequest } from "../../src/cli/daemon-client"
import { loadConfig, mergeConfig, saveConfig } from "../../src/shared/config"
import { applyConnect } from "../../src/shared/connect"
import { daemonEnv } from "../support/daemon-env"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  await env?.cleanup()
  env = null
})

describe("credentialToInput", () => {
  test("reads keys from the credential key and login/password from the configuration", () => {
    expect(credentialToInput({ type: "key", key: "k1,k2, k3", configuration: { login: "xx0000@uni-freiburg.de", password: "pw" } }))
      .toEqual({ keys: "k1,k2, k3", login: "xx0000@uni-freiburg.de", password: "pw" })
  })

  test("falls back to a keys field in the configuration", () => {
    expect(credentialToInput({ type: "key", key: "", configuration: { keys: "a\nb" } }))
      .toEqual({ keys: "a\nb", login: undefined, password: undefined })
  })

  test("non-key credentials and empty ones yield null", () => {
    expect(credentialToInput(undefined)).toBeNull()
    expect(credentialToInput({ type: "oauth", key: "x" })).toBeNull()
    expect(credentialToInput({ type: "key", key: "  " })).toBeNull()
  })
})

describe("registerConnect (the /connect integration)", () => {
  function fakeCtx(cred: unknown) {
    const methodUpdates: any[] = []
    let resolveCalls = 0
    const ctx = {
      integration: {
        transform: async (fn: (editor: any) => void) => fn({
          method: {
            update: (input: any) => methodUpdates.push(input),
          },
        }),
        connection: {
          active: async (id: string) => {
            if (id !== UFR_INTEGRATION_ID) return undefined
            resolveCalls++
            return cred === null ? undefined : { type: "credential", id: "cred_1", label: "default", method: "key" }
          },
          resolve: async () => (cred === null ? undefined : (cred as any)),
        },
      },
      storage: {
        get: async () => undefined,
        set: async () => {},
      },
    }
    return { ctx, methodUpdates, resolveCalls: () => resolveCalls }
  }

  test("registers the key method with the optional-login form on the unifreiburg integration", async () => {
    env = await daemonEnv({ keys: {} })
    const { ctx, methodUpdates } = fakeCtx(null)
    const r = await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    r.stop()
    expect(methodUpdates).toHaveLength(1)
    expect(methodUpdates[0].integrationID).toBe("unifreiburg")
    expect(methodUpdates[0].method.type).toBe("key")
    const form = methodUpdates[0].method.form as { key: string; required?: boolean }[]
    expect(form.map((f) => f.key)).toEqual(["login", "password"])
    expect(form.every((f) => !f.required)).toBe(true) // both optional — uni network machines skip them
  })

  test("a submitted credential is applied to keyring + config", async () => {
    env = await daemonEnv({ keys: {} })
    const { ctx } = fakeCtx({ type: "key", key: "k1, k2", configuration: { login: "xx0000@uni-freiburg.de", password: "pw" } })
    await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    expect(await env.secrets.get("key1")).toBe("k1")
    expect(await env.secrets.get("key2")).toBe("k2")
    expect(await env.secrets.get("vpn-login")).toBe("xx0000@uni-freiburg.de")
    expect(await env.secrets.get("vpn-pass")).toBe("pw")
    expect((await loadConfig(env.paths.configFile)).keys).toEqual(["key1", "key2"])
  })

  test("the same credential is not applied twice; a changed one re-applies", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = { type: "key", key: "k1" }
    const c = {
      integration: {
        transform: async () => {},
        connection: {
          active: async () => ({ type: "credential", id: "cred_1", label: "d", method: "key" }),
          resolve: async () => cred,
        },
      },
    }
    const { stop, applyNow } = await registerConnect({ ctx: c, paths: env.paths, secrets: env.secrets, log: () => {} })
    expect(await env.secrets.get("key1")).toBe("k1")
    // the watcher polls: same credential → signature dedup → no re-apply (observable via a spy)
    let applied = 0
    const realApply = applyNow
    for (let i = 0; i < 2; i++) {
      const changed = await realApply()
      if (changed) applied++
    }
    expect(applied).toBe(0) // signature unchanged → no further application
    expect((await loadConfig(env.paths.configFile)).keys).toEqual(["key1"])
    // changed credential → the next registration applies it immediately at setup
    cred = { type: "key", key: "k1,k2" }
    const r2 = await registerConnect({ ctx: c, paths: env.paths, secrets: env.secrets, log: () => {} })
    r2.stop()
    expect(await env.secrets.get("key2")).toBe("k2")
    expect((await loadConfig(env.paths.configFile)).keys).toEqual(["key1", "key2"])
    stop()
  })

  test("no connection → nothing happens, no error", async () => {
    env = await daemonEnv({ keys: {} })
    const { ctx } = fakeCtx(null)
    const r = await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    r.stop()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
  })
})

function dynamicCtx(cred: () => unknown) {
  const logs: string[] = []
  const ctx = {
    integration: {
      transform: async () => {},
      connection: {
        active: async () => (cred() === null ? undefined : { type: "credential", id: "cred_1", label: "d", method: "key" }),
        resolve: async () => cred(),
      },
    },
  }
  return { ctx, logs }
}

describe("watcher: connection removal and reconnect", () => {
  test("removing the connection in opencode wipes keys, the uni login and config", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = { type: "key", key: "k1,k2", configuration: { login: "xx0000@uni-freiburg.de", password: "pw" } }
    const { ctx, logs } = dynamicCtx(() => cred)
    const { stop, applyNow } = await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: (m) => logs.push(m) })
    expect(await env.secrets.get("key1")).toBe("k1")
    cred = null // the provider was removed in opencode's UI
    expect(await applyNow()).toBe(true) // a disconnect is a state change
    expect(await env.secrets.get("key1")).toBeNull()
    expect(await env.secrets.get("key2")).toBeNull()
    expect(await env.secrets.get("vpn-login")).toBeNull()
    expect(await env.secrets.get("vpn-pass")).toBeNull()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
    expect(logs.some((m) => m.includes("removed") && m.includes("key1"))).toBe(true)
    stop()
  })

  test("reconnecting with the same keys re-applies them after a removal", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = { type: "key", key: "k1,k2", configuration: {} }
    const { ctx } = dynamicCtx(() => cred)
    const { stop, applyNow } = await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    expect(await env.secrets.get("key1")).toBe("k1")
    cred = null
    await applyNow()
    expect(await env.secrets.get("key1")).toBeNull()
    cred = { type: "key", key: "k1,k2", configuration: {} } // same keys submitted again
    expect(await applyNow()).toBe(true)
    expect(await env.secrets.get("key1")).toBe("k1")
    expect(await env.secrets.get("key2")).toBe("k2")
    stop()
  })

  test("a reconnect re-registers the provider; a stable connection does not re-register", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = { type: "key", key: "k1", configuration: {} }
    const { ctx } = dynamicCtx(() => cred)
    let registrations = 0
    const { stop, applyNow } = await registerConnect({
      ctx,
      paths: env.paths,
      secrets: env.secrets,
      log: () => {},
      register: async () => { registrations++ },
    })
    expect(registrations).toBe(1) // first connect mid-session
    await applyNow() // stable, unchanged credential
    expect(registrations).toBe(1)
    cred = null
    await applyNow() // removal — no registration
    expect(registrations).toBe(1)
    cred = { type: "key", key: "k1", configuration: {} }
    await applyNow() // reconnect
    expect(registrations).toBe(2)
    stop()
  })

  test("never connected → no registration, no cleanup", async () => {
    env = await daemonEnv({ keys: {} })
    const { ctx } = dynamicCtx(() => null)
    let registrations = 0
    const { stop, applyNow } = await registerConnect({
      ctx,
      paths: env.paths,
      secrets: env.secrets,
      log: () => {},
      register: async () => { registrations++ },
    })
    expect(await applyNow()).toBe(false)
    expect(registrations).toBe(0)
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
    stop()
  })
})

describe("applyConnect change detection", () => {
  test("re-applying the identical keys and login reports changed=false", async () => {
    env = await daemonEnv({ keys: {} })
    await env.secrets.set("key1", "k1")
    await env.secrets.set("vpn-login", "xx0000@uni-freiburg.de")
    await env.secrets.set("vpn-pass", "pw")
    await saveConfig(env.paths.configFile, mergeConfig({ keys: ["key1"] }))
    const r = await applyConnect(
      { keys: "k1", login: "xx0000@uni-freiburg.de", password: "pw" },
      { paths: env.paths, secrets: env.secrets },
    )
    expect(r.errors).toEqual([])
    expect(r.changed).toBe(false)
  })

  test("a different key value or a wider key list reports changed=true", async () => {
    env = await daemonEnv({ keys: {} })
    await env.secrets.set("key1", "k1")
    await saveConfig(env.paths.configFile, mergeConfig({ keys: ["key1"] }))
    const r = await applyConnect({ keys: "k1,k2" }, { paths: env.paths, secrets: env.secrets })
    expect(r.changed).toBe(true)
    expect(await env.secrets.get("key2")).toBe("k2")
    const r2 = await applyConnect({ keys: "k1,k9" }, { paths: env.paths, secrets: env.secrets })
    expect(r2.changed).toBe(true)
    expect(await env.secrets.get("key2")).toBe("k9")
  })

  test("an identical re-apply leaves a running gateway alone (no idle-stop)", async () => {
    env = await daemonEnv({ keys: { key1: "k1" } })
    await env.start()
    const { ctx } = dynamicCtx(() => ({ type: "key", key: "k1", configuration: {} }))
    const { stop } = await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    await new Promise((r) => setTimeout(r, 200)) // an unconditional apply would stop it ~20 ms in
    const status = await daemonRequest(env.paths, (u, i) => fetch(u, i), "/v1/_status")
    expect(status?.ok ?? false).toBe(true)
    stop()
  })
})

describe("watcher: failed registrations are retried", () => {
  test("a registration that reports failure is retried on later polls until it succeeds", async () => {
    env = await daemonEnv({ keys: {} })
    let ok = false
    let attempts = 0
    const { ctx } = dynamicCtx(() => ({ type: "key", key: "k1", configuration: {} }))
    const { stop, applyNow } = await registerConnect({
      ctx,
      paths: env.paths,
      secrets: env.secrets,
      log: () => {},
      register: async () => { attempts++; return ok },
    })
    expect(attempts).toBe(1) // tried once at the initial apply
    ok = true // e.g. the VPN came up and models are available now
    expect(await applyNow()).toBe(true)
    expect(attempts).toBe(2)
    expect(await applyNow()).toBe(false) // registered — no further attempts
    expect(attempts).toBe(2)
    stop()
  })
})

describe("watcher poll interval", () => {
  test("polls on its own: a connection made after setup is applied without any manual trigger", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = null
    const { ctx } = dynamicCtx(() => cred)
    let registrations = 0
    const { stop } = await registerConnect({
      ctx,
      paths: env.paths,
      secrets: env.secrets,
      log: () => {},
      register: async () => { registrations++ },
      pollMs: 20,
    })
    cred = { type: "key", key: "k1", configuration: {} } // the user submits /connect
    for (let i = 0; i < 50 && registrations === 0; i++) await new Promise((r) => setTimeout(r, 20))
    stop()
    expect(await env.secrets.get("key1")).toBe("k1")
    expect(registrations).toBe(1)
  })

  test("the default interval is a few seconds, not a minute", () => {
    expect(CONNECT_POLL_MS).toBeLessThanOrEqual(5_000)
  })
})

describe("watcher: overlapping polls", () => {
  test("a slow registration is not started again by the next poll", async () => {
    env = await daemonEnv({ keys: {} })
    let cred: unknown = null
    const { ctx } = dynamicCtx(() => cred)
    let registrations = 0
    const { stop } = await registerConnect({
      ctx,
      paths: env.paths,
      secrets: env.secrets,
      log: () => {},
      register: async () => {
        registrations++
        await new Promise((r) => setTimeout(r, 300)) // e.g. the gateway still booting
      },
      pollMs: 20,
    })
    cred = { type: "key", key: "k1", configuration: {} }
    await new Promise((r) => setTimeout(r, 600)) // ~30 poll ticks while registration is slow
    stop()
    expect(registrations).toBe(1)
  })
})
