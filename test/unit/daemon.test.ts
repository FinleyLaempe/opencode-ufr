import { utimes } from "node:fs/promises"
import { afterEach, describe, expect, test } from "bun:test"
import { AlreadyRunningError, acquireLock } from "../../src/daemon/daemon"
import { loadConfig } from "../../src/shared/config"
import { daemonEnv } from "../support/daemon-env"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
const setup = async (o?: Parameters<typeof daemonEnv>[0]) => (env = await daemonEnv(o))
afterEach(async () => {
  await env?.cleanup()
  env = null
})

const chatBody = JSON.stringify({ model: "glm-5.2-llmlb", messages: [{ role: "user", content: "Hi" }] })

describe("daemon", () => {
  test("/health needs no token; everything else does", async () => {
    const e = await setup()
    const d = await e.start()
    const h = await fetch(`http://127.0.0.1:${d.port}/health`)
    expect(await h.json()).toMatchObject({ ok: true })
    expect((await fetch(`http://127.0.0.1:${d.port}/v1/models`)).status).toBe(401)
  })

  test("lists models with opencode stamps and hides excluded ones", async () => {
    const e = await setup()
    const d = await e.start()
    const body = (await (await e.api(d, "/v1/models")).json()) as { data: { id: string; opencode: any }[] }
    const ids = body.data.map((m) => m.id)
    expect(ids).toContain("glm-5.2-llmlb")
    expect(ids).not.toContain("hidden-model-llmlb")
    expect(body.data.find((m) => m.id === "glm-5.2-llmlb")!.opencode.limit.context).toBe(1048576)
  })

  test("answers a chat completion end to end; status never contains key values", async () => {
    const e = await setup()
    const d = await e.start()
    const res = await e.api(d, "/v1/chat/completions", { method: "POST", body: chatBody })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).choices[0].message.content).toBe("Hello")
    const status = await (await e.api(d, "/v1/_status")).text()
    expect(status).toContain('"alias":"main"')
    expect(status).not.toContain("key-a")
  })

  test("long non-streaming call survives Bun's idle timeout", async () => {
    const e = await setup()
    const d = await e.start()
    e.ufr.delayMs = 11_000 // Bun.serve closes idle connections after 10 s by default
    const res = await e.api(d, "/v1/chat/completions", { method: "POST", body: chatBody })
    expect(res.status).toBe(200)
  }, 20_000)

  test("token and port survive a restart", async () => {
    const e = await setup()
    const preferredPort = 41_000 + Math.floor(Math.random() * 2_000)
    const a = await e.start({ port: undefined, preferredPort })
    expect((await loadConfig(e.paths.configFile)).port).toBe(a.port)
    const { port, token } = a
    await a.stop()
    const b = await e.start({ port: undefined })
    expect(b.port).toBe(port)
    expect(b.token).toBe(token)
  })

  test("only one of two concurrent lock attempts wins", async () => {
    const e = await setup()
    const results = await Promise.all([acquireLock(e.paths.lockFile), acquireLock(e.paths.lockFile)])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  test("a second daemon refuses to start", async () => {
    const e = await setup()
    await e.start()
    await expect(e.start()).rejects.toThrow(AlreadyRunningError)
  })

  test("a stale lock from a dead process is taken over", async () => {
    const e = await setup()
    await Bun.write(e.paths.lockFile, "999999")
    expect(await acquireLock(e.paths.lockFile, { isAlive: () => false })).toBe(true)
  })

  test("a lock held by an unrelated live process is taken over once it is old", async () => {
    const e = await setup()
    await Bun.write(e.paths.lockFile, String(process.ppid))
    const old = new Date(Date.now() - 120_000)
    await utimes(e.paths.lockFile, old, old)
    expect(await acquireLock(e.paths.lockFile, { isAlive: () => true, confirmDaemon: async () => false })).toBe(true)
  })

  test("a young lock of a live process is respected", async () => {
    const e = await setup()
    await Bun.write(e.paths.lockFile, String(process.ppid))
    expect(await acquireLock(e.paths.lockFile, { isAlive: () => true, confirmDaemon: async () => false })).toBe(false)
  })

  test("a lock with our own pid but a foreign nonce is stale", async () => {
    const e = await setup()
    await Bun.write(e.paths.lockFile, `${process.pid} deadbeef`)
    expect(await acquireLock(e.paths.lockFile)).toBe(true)
  })

  test("writes daemon.json and cleans up on shutdown", async () => {
    const e = await setup()
    const d = await e.start()
    expect(((await Bun.file(e.paths.daemonFile).json()) as any).port).toBe(d.port)
    await e.api(d, "/v1/_shutdown", { method: "POST" })
    await Bun.sleep(200)
    expect(await Bun.file(e.paths.daemonFile).exists()).toBe(false)
    expect(await Bun.file(e.paths.lockFile).exists()).toBe(false)
  })

  test("stops itself when idle", async () => {
    const e = await setup()
    let stopped = false
    await e.start({ exitOnIdle: true, idleMs: 200, idleCheckMs: 50, onStopped: () => (stopped = true) })
    await Bun.sleep(600)
    expect(stopped).toBe(true)
  })

  test("reports the VPN problem in status", async () => {
    const e = await setup()
    e.ufr.vpnPage = true
    const d = await e.start()
    expect(d.status().upstream.ok).toBe(false)
    expect(d.status().upstream.message).toContain("VPN")
  })

  test("retries UFR's model list until the VPN is up, then stops retrying", async () => {
    const e = await setup()
    e.ufr.vpnPage = true
    let listCalls = 0
    const countingFetch = (u: string, i?: RequestInit) => {
      if (u.endsWith("/api/models")) listCalls++
      return fetch(u, i)
    }
    const d = await e.start({ fetch: countingFetch, catalogRetryMs: [30, 60] })
    const ids = async () => ((await (await e.api(d, "/v1/models")).json()) as { data: { id: string }[] }).data.map((m) => m.id)
    expect(await ids()).toEqual([])
    expect(d.status().upstream.ok).toBe(false)
    e.ufr.vpnPage = false
    for (let t = 0; t < 40 && d.status().catalog.models === 0; t++) await Bun.sleep(25)
    expect(await ids()).toContain("glm-5.2-llmlb")
    expect(d.status().upstream.ok).toBe(true)
    const afterSuccess = listCalls
    await Bun.sleep(250)
    expect(listCalls).toBe(afterSuccess)
  })

  test("stop() ends the model-list retry", async () => {
    const e = await setup()
    e.ufr.vpnPage = true
    let listCalls = 0
    const d = await e.start({
      fetch: (u, i) => {
        if (u.endsWith("/api/models")) listCalls++
        return fetch(u, i)
      },
      catalogRetryMs: [30],
    })
    await Bun.sleep(100)
    expect(listCalls).toBeGreaterThan(1)
    await d.stop()
    const atStop = listCalls
    await Bun.sleep(200)
    expect(listCalls).toBe(atStop)
  })

  test("without a key there is no model-list retry (keys are read once at start)", async () => {
    const e = await setup({ keys: {} })
    let fetches = 0
    await e.start({ fetch: (u, i) => (fetches++, fetch(u, i)), catalogRetryMs: [30] })
    const atStart = fetches
    await Bun.sleep(150)
    expect(fetches).toBe(atStart)
  })

  test("rebuilds the pool window from stats after a restart", async () => {
    const e = await setup()
    const a = await e.start()
    await e.api(a, "/v1/chat/completions", { method: "POST", body: chatBody })
    await e.api(a, "/v1/chat/completions", { method: "POST", body: chatBody })
    await a.stop()
    const b = await e.start()
    expect(b.status().pool.inWindow).toBe(2)
  })

  test("keys missing from the keyring are skipped, not fatal", async () => {
    const e = await setup()
    await e.secrets.delete("alt")
    const d = await e.start()
    expect(d.status().keys.map((k) => k.alias)).toEqual(["main"])
  })

  test("a model unknown to models.json auto-probes its real context limit", async () => {
    const e = await setup()
    // the fake names the limit in the context error (like vLLM does)
    e.ufr.contextLimitChars.set("brand-new-llmlb", 262_144)
    const d = await e.start({ probes: true })
    // the probe runs after the catalog load; wait for the rebuilt catalog
    const models = async () => ((await (await e.api(d, "/v1/models")).json()) as { data: { id: string; opencode: { limit: { context: number } } }[] }).data
    let context = 0
    for (let t = 0; t < 200 && context !== 262_144; t++) {
      context = (await models()).find((m) => m.id === "brand-new-llmlb")?.opencode.limit.context ?? 0
      if (context !== 262_144) await Bun.sleep(50)
    }
    expect(context).toBe(262_144)
    // the probe result survives a restart (stored in the stats db)
    await d.stop()
    const d2 = await e.start({ probes: true })
    const list2 = await (await e.api(d2, "/v1/models")).json() as { data: { id: string; opencode: { limit: { context: number } } }[] }
    const again = list2.data.find((m) => m.id === "brand-new-llmlb")
    expect(again!.opencode.limit.context).toBe(262_144)
    await d2.stop()
  }, 15_000)

  test("a client disconnecting mid-stream aborts the upstream call and frees the in-flight slot", async () => {
    const e = await setup()
    e.ufr.streamChunkDelayMs = 1_000
    const d = await e.start()
    const ac = new AbortController()
    const res = await fetch(`http://127.0.0.1:${d.port}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "glm-5.2-llmlb", stream: true, messages: [{ role: "user", content: "Hi" }] }),
      signal: ac.signal,
    })
    const reader = res.body!.getReader()
    await reader.read()
    ac.abort()
    await reader.read().catch(() => {})
    await Bun.sleep(500)
    expect(e.ufr.calls.at(-1)!.aborted).toBe(true)
    expect(d.router.inFlight).toBe(0)
  })
})
