import { afterEach, describe, expect, test } from "bun:test"
import { ensureDaemon, isNewer } from "../../src/plugin/ensure-daemon"
import { heartbeat, default as plugin } from "../../src/plugin/index"
import { VERSION } from "../../src/shared/version"
import { daemonEnv } from "../support/daemon-env"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  delete process.env.OPENCODE_UFR_HOME
  await env?.cleanup()
  env = null
})

describe("isNewer", () => {
  test("compares dotted versions numerically", () => {
    expect(isNewer("0.10.0", "0.9.9")).toBe(true)
    expect(isNewer("0.1.0", "0.1.0")).toBe(false)
    expect(isNewer("0.1.0", "0.2.0")).toBe(false)
  })
})

describe("ensureDaemon", () => {
  test("uses a running daemon of the same version without spawning", async () => {
    env = await daemonEnv()
    const d = await env.start()
    let spawned = 0
    const conn = await ensureDaemon({ paths: env.paths, version: VERSION, spawn: () => spawned++ })
    expect(conn).toEqual({ port: d.port, token: d.token })
    expect(spawned).toBe(0)
  })

  test("spawns when nothing runs and waits until it answers", async () => {
    env = await daemonEnv()
    const e = env
    let spawned = 0
    const conn = await ensureDaemon({ paths: e.paths, version: VERSION, spawn: () => { spawned++; void e.start() } })
    expect(spawned).toBe(1)
    expect((await fetch(`http://127.0.0.1:${conn.port}/health`)).ok).toBe(true)
  })

  test("gives up with a clear error when the daemon never comes up", async () => {
    env = await daemonEnv()
    await expect(ensureDaemon({ paths: env.paths, version: VERSION, spawn: () => {}, timeoutMs: 500 })).rejects.toThrow(/did not start/)
  })

  test("replaces an older daemon once it is idle", async () => {
    env = await daemonEnv()
    const e = env
    const old = await e.start()
    const conn = await ensureDaemon({ paths: e.paths, version: "999.0.0", spawn: () => void e.start() })
    expect(conn.port).not.toBe(old.port)
    expect((await fetch(`http://127.0.0.1:${old.port}/health`).catch(() => null))?.ok ?? false).toBe(false)
  })
})

describe("plugin setup", () => {
  const fakeCtx = (options: Record<string, unknown> = {}) => {
    const added: any[] = []
    return {
      added,
      ctx: { options, provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) } },
    }
  }

  test("registers the provider pointing at the daemon", async () => {
    env = await daemonEnv()
    const d = await env.start()
    process.env.OPENCODE_UFR_HOME = env.home
    const { ctx, added } = fakeCtx({ providerId: "ufr-test" })
    const cleanup = await plugin.setup(ctx)
    expect(added).toHaveLength(1)
    expect(added[0].info).toMatchObject({
      id: "ufr-test",
      name: "Uni Freiburg",
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${d.port}/v1`, apiKey: d.token },
    })
    const ids = added[0].models.map((m: any) => m.id)
    expect(ids).toContain("glm-5.2-llmlb")
    expect(ids).not.toContain("hidden-model-llmlb")
    expect(added[0].models[0].providerID).toBe("ufr-test")
    if (typeof cleanup === "function") cleanup()
  })

  test("registers nothing when the daemon has no models (e.g. off the VPN, no cache)", async () => {
    env = await daemonEnv()
    env.ufr.vpnPage = true
    await env.start()
    process.env.OPENCODE_UFR_HOME = env.home
    const { ctx, added } = fakeCtx()
    await plugin.setup(ctx)
    expect(added).toHaveLength(0)
  })
})

describe("plugin setup: connection gating", () => {
  test("not connected → registers nothing and starts no daemon", async () => {
    env = await daemonEnv({ keys: {} })
    process.env.OPENCODE_UFR_HOME = env.home
    const added: any[] = []
    const ctx = {
      options: { providerId: "ufr-test" },
      provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) },
      integration: {
        transform: async () => {},
        connection: { active: async () => undefined },
      },
    }
    const cleanup = await plugin.setup(ctx)
    if (typeof cleanup === "function") cleanup()
    expect(added).toHaveLength(0)
    expect(await Bun.file(env.paths.daemonFile).exists()).toBe(false)
  })

  test("heartbeat leaves the daemon down when the connection is gone", async () => {
    env = await daemonEnv({ keys: {} })
    process.env.OPENCODE_UFR_HOME = env.home
    const ctx = { integration: { connection: { active: async () => undefined } } }
    await heartbeat(ctx, env.paths)
    expect(await Bun.file(env.paths.daemonFile).exists()).toBe(false)
  })
})
