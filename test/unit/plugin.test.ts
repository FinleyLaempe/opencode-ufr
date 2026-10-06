import { afterEach, describe, expect, test } from "bun:test"
import { UFR_INTEGRATION_ID } from "../../src/plugin/connect"
import { ensureDaemon, isNewer } from "../../src/plugin/ensure-daemon"
import { heartbeat, default as plugin, setupPlugin } from "../../src/plugin/index"
import { loadConfig } from "../../src/shared/config"
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

  test("a spawn failure fails fast instead of waiting out the timeout", async () => {
    env = await daemonEnv()
    const t0 = Date.now()
    await expect(
      ensureDaemon({ paths: env.paths, version: VERSION, spawn: (onError) => onError(new Error("spawn ENOENT")), timeoutMs: 30_000 }),
    ).rejects.toThrow(/failed to start/)
    expect(Date.now() - t0).toBeLessThan(5_000)
  })

  test("a /health answer without a version is not trusted as our daemon", async () => {
    env = await daemonEnv()
    const srv = Bun.serve({ port: 0, fetch: () => Response.json({ ok: true, pid: process.pid }) })
    await Bun.write(env.paths.daemonFile, JSON.stringify({ port: srv.port, pid: process.pid, version: VERSION }))
    await Bun.write(env.paths.tokenFile, "tok\n")
    let spawned = 0
    await expect(
      ensureDaemon({ paths: env.paths, version: VERSION, spawn: () => spawned++, timeoutMs: 500 }),
    ).rejects.toThrow(/did not start/)
    expect(spawned).toBe(1)
    srv.stop(true)
  })

  test("a daemon that rejects the stored token fails with the reason instead of returning a 401 conn", async () => {
    env = await daemonEnv()
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, version: "0.1.0" })
        return new Response("unauthorized", { status: 401 }) // _status never verifiable
      },
    })
    await Bun.write(env.paths.daemonFile, JSON.stringify({ port: srv.port, pid: process.pid, version: "0.1.0" }))
    await Bun.write(env.paths.tokenFile, "tok\n")
    await expect(
      ensureDaemon({ paths: env.paths, version: "999.0.0", spawn: () => {}, timeoutMs: 400 }),
    ).rejects.toThrow(/rejects the stored token/)
    srv.stop(true)
  })

  test("a transient non-ok _status is not a token rejection — the running daemon keeps serving", async () => {
    env = await daemonEnv()
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, version: "0.1.0" })
        return new Response("unavailable", { status: 503 }) // e.g. mid-restart
      },
    })
    await Bun.write(env.paths.daemonFile, JSON.stringify({ port: srv.port, pid: process.pid, version: "0.1.0" }))
    await Bun.write(env.paths.tokenFile, "tok\n")
    let spawned = 0
    const conn = await ensureDaemon({
      paths: env.paths,
      version: "999.0.0",
      spawn: () => spawned++, // harmless: the lock keeps the redundant child out
      timeoutMs: 2_000,
    })
    expect(spawned).toBe(1)
    expect(conn).toEqual({ port: srv.port as number, token: "tok" })
    srv.stop(true)
  })

  test("an upgrade is deferred while the daemon answers a request", async () => {
    env = await daemonEnv()
    const srv = Bun.serve({
      port: 0,
      fetch: (req) => {
        if (new URL(req.url).pathname === "/health") return Response.json({ ok: true, version: "0.1.0" })
        return Response.json({ inFlight: 2 })
      },
    })
    await Bun.write(env.paths.daemonFile, JSON.stringify({ port: srv.port, pid: process.pid, version: "0.1.0" }))
    await Bun.write(env.paths.tokenFile, "tok\n")
    const conn = await ensureDaemon({
      paths: env.paths,
      version: "999.0.0",
      spawn: () => {
        throw new Error("must not spawn while a request is in flight")
      },
      timeoutMs: 1_000,
    })
    expect(conn).toEqual({ port: srv.port as number, token: "tok" })
    srv.stop(true)
  })
})

describe("plugin setup", () => {
  const fakeCtx = (options: Record<string, unknown> = {}) => {
    const added: any[] = []
    const skills: any[] = []
    return {
      added,
      skills,
      ctx: {
        options,
        provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) },
        skill: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => skills.push(x) }) },
      },
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

  test("registers the pdf2md skill with the script path baked in", async () => {
    env = await daemonEnv()
    await env.start()
    process.env.OPENCODE_UFR_HOME = env.home
    const { ctx, skills } = fakeCtx()
    const cleanup = await plugin.setup(ctx)
    expect(skills).toHaveLength(1)
    expect(skills[0]).toMatchObject({ id: "ufr-pdf2md", name: "PDF to Markdown" })
    expect(skills[0].description.length).toBeGreaterThan(20)
    expect(skills[0].content).toContain("bun ")
    expect(skills[0].content).toContain("src/client/pdf2md.ts")
    expect(skills[0].content).not.toContain("{{PDF2MD_SCRIPT}}") // placeholder resolved
    if (typeof cleanup === "function") cleanup()
  })

  test("setup survives an opencode without the skill API", async () => {
    env = await daemonEnv()
    await env.start()
    process.env.OPENCODE_UFR_HOME = env.home
    const added: any[] = []
    const ctx = {
      options: { providerId: "ufr-test" },
      provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) },
    }
    const cleanup = await plugin.setup(ctx)
    expect(added).toHaveLength(1) // provider still registers
    if (typeof cleanup === "function") cleanup()
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

  test("a removal while opencode was closed is wiped on the next start", async () => {
    env = await daemonEnv({ keys: { key1: "k1" } })
    await env.secrets.set("vpn-login", "xx0000@uni-freiburg.de")
    await env.secrets.set("vpn-pass", "pw")
    process.env.OPENCODE_UFR_HOME = env.home
    const added: any[] = []
    const ctx = {
      options: { providerId: "ufr-test" },
      provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) },
      integration: {
        transform: async () => {},
        connection: { active: async () => undefined }, // removed while opencode was closed
      },
    }
    const cleanup = await setupPlugin(ctx, { secrets: env.secrets })
    if (typeof cleanup === "function") cleanup()
    expect(added).toHaveLength(0)
    expect(await env.secrets.get("key1")).toBeNull()
    expect(await env.secrets.get("vpn-login")).toBeNull()
    expect(await env.secrets.get("vpn-pass")).toBeNull()
    expect((await loadConfig(env.paths.configFile)).keys).toEqual([])
  })

  test("a broken config does not brick the plugin load (cleanup failure is caught)", async () => {
    env = await daemonEnv({ keys: {} })
    await Bun.write(env.paths.configFile, '{ "keyRpm": 5 }') // unknown key → loadConfig throws
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
    const cleanup = await setupPlugin(ctx, { secrets: env.secrets }) // must not reject
    if (typeof cleanup === "function") cleanup()
    expect(added).toHaveLength(0)
    expect(await env.secrets.get("key1")).toBeNull()
  })

  test("heartbeat leaves the daemon down when the connection is gone", async () => {
    env = await daemonEnv({ keys: {} })
    process.env.OPENCODE_UFR_HOME = env.home
    const ctx = { integration: { connection: { active: async () => undefined } } }
    await heartbeat(ctx, env.paths)
    expect(await Bun.file(env.paths.daemonFile).exists()).toBe(false)
  })
})

describe("plugin setup: provider key", () => {
  test("the provider is not linked to the /connect integration, so opencode sends the gateway token", async () => {
    env = await daemonEnv()
    const d = await env.start()
    process.env.OPENCODE_UFR_HOME = env.home
    const added: any[] = []
    const ctx = { provider: { transform: async (fn: (editor: any) => void) => fn({ add: (x: any) => added.push(x) }) } }
    const cleanup = await plugin.setup(ctx)
    if (typeof cleanup === "function") cleanup()
    const info = added[0].info
    // opencode takes a request's key from connection.active(info.integrationID ?? info.id); a key credential
    // there replaces settings.apiKey — on "unifreiburg" that is the user's UFR key list, which the gateway rejects.
    expect(info.integrationID ?? info.id).not.toBe(UFR_INTEGRATION_ID)
    expect(info.settings.apiKey).toBe(d.token)
  })
})
