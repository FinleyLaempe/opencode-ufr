import { afterEach, describe, expect, test } from "bun:test"
import { credentialToInput, registerConnect, UFR_INTEGRATION_ID } from "../../src/plugin/connect"
import { loadConfig } from "../../src/shared/config"
import { daemonEnv } from "../support/daemon-env"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  await env?.cleanup()
  env = null
})

describe("credentialToInput", () => {
  test("reads keys from the credential key and login/password from the configuration", () => {
    expect(credentialToInput({ type: "key", key: "k1,k2, k3", configuration: { login: "fl240@uni-freiburg.de", password: "pw" } }))
      .toEqual({ keys: "k1,k2, k3", login: "fl240@uni-freiburg.de", password: "pw" })
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
    const { ctx } = fakeCtx({ type: "key", key: "k1, k2", configuration: { login: "fl240@uni-freiburg.de", password: "pw" } })
    await registerConnect({ ctx, paths: env.paths, secrets: env.secrets, log: () => {} })
    expect(await env.secrets.get("key1")).toBe("k1")
    expect(await env.secrets.get("key2")).toBe("k2")
    expect(await env.secrets.get("vpn-login")).toBe("fl240@uni-freiburg.de")
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
