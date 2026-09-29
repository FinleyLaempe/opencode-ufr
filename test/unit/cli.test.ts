import { afterEach, describe, expect, test } from "bun:test"
import { PassThrough } from "node:stream"
import { type CliDeps, main } from "../../src/cli/index"
import { diffCatalog } from "../../src/cli/catalog"
import { readPipedSecret } from "../../src/cli/io"
import { formatStatus } from "../../src/cli/status"
import { checkKey } from "../../src/cli/ufr-check"
import { parseUfrModels } from "../../src/daemon/catalog"
import { Stats } from "../../src/daemon/stats"
import { loadConfig } from "../../src/shared/config"
import { daemonEnv } from "../support/daemon-env"
import { testIo } from "../support/io"
import { TEST_MODELS_FILE, UFR_RAW_MODELS } from "../support/models"

let env: Awaited<ReturnType<typeof daemonEnv>> | null = null
afterEach(async () => {
  await env?.cleanup()
  env = null
})

async function cli(argv: string[], answers: (string | boolean)[] = [], o: { keys?: Record<string, string> } = {}) {
  env ??= await daemonEnv({ keys: o.keys ?? {} })
  const t = testIo(answers)
  const opencodeCalls: string[][] = []
  const deps: Partial<CliDeps> = {
    paths: env.paths,
    secrets: env.secrets,
    io: t.io,
    fetch: (u, i) => fetch(u, i),
    now: Date.now,
    runOpencode: async (args) => {
      opencodeCalls.push(args)
      return 0
    },
  }
  const code = await main(argv, deps)
  return { code, out: t.out(), err: t.err(), left: t.left(), opencodeCalls }
}

describe("ufr keys", () => {
  test("add verifies the key with UFR, stores it in the keyring and the alias in config", async () => {
    const r = await cli(["keys", "add", "main"], ["key-a"])
    expect(r.code).toBe(0)
    expect(await env!.secrets.get("main")).toBe("key-a")
    expect((await loadConfig(env!.paths.configFile)).keys).toEqual(["main"])
    expect(r.out).toContain("verified")
    expect(r.out + r.err).not.toContain("key-a")
  })

  test("add refuses a key UFR rejects", async () => {
    const r = await cli(["keys", "add", "main"], ["sk-wrong"])
    expect(r.code).toBe(1)
    expect(await env!.secrets.get("main")).toBeNull()
  })

  test("off the VPN, add asks before storing an unverified key", async () => {
    env = await daemonEnv({ keys: {} })
    env.ufr.vpnPage = true
    const r = await cli(["keys", "add", "main"], ["key-a", true])
    expect(r.code).toBe(0)
    expect(await env.secrets.get("main")).toBe("key-a")
  })

  test("add rejects bad aliases", async () => {
    expect((await cli(["keys", "add", "no spaces"])).code).toBe(2)
  })

  test("list shows stored/missing and never the value; remove deletes both places", async () => {
    await cli(["keys", "add", "main"], ["key-a"])
    const listed = await cli(["keys", "list"])
    expect(listed.out).toContain("main\tstored")
    expect(listed.out).not.toContain("key-a")
    expect((await cli(["keys", "remove", "main"])).code).toBe(0)
    expect(await env!.secrets.get("main")).toBeNull()
    expect((await loadConfig(env!.paths.configFile)).keys).toEqual([])
  })

  test("add stops an idle running gateway so it restarts with the new keys", async () => {
    env = await daemonEnv({ keys: {} })
    await env.start()
    const r = await cli(["keys", "add", "main"], ["key-a"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("restarts with the new keys when opencode next needs it")
    expect(r.out + r.err).not.toContain("key-a")
    await Bun.sleep(200)
    expect((await cli(["status"])).out).toContain("not running")
  })

  test("remove stops an idle running gateway too", async () => {
    env = await daemonEnv({ keys: { main: "key-a" } })
    await env.start()
    const r = await cli(["keys", "remove", "main"])
    expect(r.out).toContain("restarts with the new keys when opencode next needs it")
    await Bun.sleep(200)
    expect((await cli(["status"])).out).toContain("not running")
  })

  test("with a request in flight, add leaves the gateway running and says to run `ufr stop` later", async () => {
    env = await daemonEnv({ keys: { main: "key-a" } })
    const d = await env.start()
    env.ufr.delayMs = 1_000
    const pending = env.api(d, "/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2-llmlb", messages: [{ role: "user", content: "Hi" }] }),
    })
    for (let t = 0; t < 40 && d.router.inFlight === 0; t++) await Bun.sleep(10)
    const r = await cli(["keys", "add", "alt"], ["key-b"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("run `ufr stop` later")
    await Bun.sleep(200)
    expect((await cli(["status"])).out).toContain("in flight 1")
    expect((await pending).status).toBe(200)
  })

  test("test labels every key", async () => {
    await cli(["keys", "add", "main"], ["key-a"])
    const r = await cli(["keys", "test"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("main\tok")
  })
})

describe("terminal io", () => {
  test("a piped key (stdin not a TTY) is never echoed; the question goes to stderr", async () => {
    const stdout: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((chunk: unknown) => (stdout.push(String(chunk)), true)) as typeof process.stdout.write
    try {
      for (const piped of ["sk-secret-123\n", "sk-secret-123"]) {
        const input = new PassThrough()
        const err = new PassThrough()
        const errText: string[] = []
        err.on("data", (d) => errText.push(String(d)))
        const got = readPipedSecret("UFR API key: ", input, err)
        input.end(piped)
        expect(await got).toBe("sk-secret-123")
        expect(errText.join("")).toContain("UFR API key: ")
        expect(errText.join("")).not.toContain("sk-secret-123")
      }
    } finally {
      process.stdout.write = write
    }
    expect(stdout.join("")).not.toContain("sk-secret-123")
  })
})

describe("ufr status / stats / catalog / stop", () => {
  test("status without a daemon says so", async () => {
    const r = await cli(["status"])
    expect(r.code).toBe(0)
    expect(r.out).toContain("not running")
  })

  test("status shows keys, pool and spend from a running daemon", async () => {
    env = await daemonEnv({ keys: { main: "key-a" } })
    await env.start()
    const r = await cli(["status"])
    expect(r.out).toContain("main  0/18 per 60s")
    expect(r.out).toContain("pool      0/800 per hour")
    expect(r.out).toContain("breakers  all closed")
  })

  test("formatStatus shows open breakers, cooldowns and the VPN problem", () => {
    const text = formatStatus({
      version: "0.1.0", pid: 1, port: 47300, uptimeMs: 60_000, inFlight: 0, now: 100_000,
      upstream: { ok: false, message: "connect to the uni VPN", at: 90_000 },
      keys: [{ alias: "main", used: 3, cap: 18, blockedForMs: 42_000, invalid: false }],
      pool: { enabled: true, cap: 800, windowMs: 3_600_000, inWindow: 12, admitted: 12, queued: 0, rejected: 0 },
      breakers: { "glm-5.2-llmlb": { state: "open", level: 1, retryAfterMs: 95_000 } },
      catalog: { source: "remote", ufrSource: "cache", loadedAt: 0, models: 34, warnings: ["x: no price"] },
      spendToday: { main: 0.1069 },
      dailyBudgetUsd: 20,
    })
    expect(text).toContain("NOT reachable — connect to the uni VPN")
    expect(text).toContain("cooling down 42s")
    expect(text).toContain("today $0.1069 (0.53% of $20, est.)")
    expect(text).toContain("glm-5.2-llmlb open (rung 2")
    expect(text).toContain("warning   x: no price")
  })

  test("stats summarises today's requests per model and key", async () => {
    env = await daemonEnv({ keys: {} })
    const s = new Stats(env.paths.statsDb)
    s.record({ ts: Date.now(), model: "glm-5.2-llmlb", keyAlias: "main", status: 200, promptTokens: 267_168,
      completionTokens: 60, costUsd: 0.1069, latencyMs: 1, attempts: 1, errorType: null, poolAdmitted: true })
    s.close()
    const r = await cli(["stats"])
    expect(r.out).toContain("glm-5.2-llmlb")
    expect(r.out).toContain("$0.1069")
    expect(r.out).toContain("0.53% of $20 (est.)")
  })

  test("stats without a database is not an error", async () => {
    expect((await cli(["stats"])).out).toContain("no stats yet")
  })

  test("diffCatalog finds new, gone, vision disagreements and unpriced models", () => {
    const d = diffCatalog(parseUfrModels(UFR_RAW_MODELS), TEST_MODELS_FILE)
    expect(d.added).toEqual(["brand-new-llmlb"])
    expect(d.gone).toEqual([])
    expect(d.vision).toEqual([{ id: "hidden-model-llmlb", ufr: true, ours: false }])
    expect(d.unpriced).toContain("mistral-small-4-llmlb")
    expect(d.unpriced).not.toContain("gpt-5.6-llmlb") // alias spelling
  })

  test("catalog diff talks to UFR with the first key", async () => {
    env = await daemonEnv({ keys: { main: "key-a" } })
    await Bun.write(env.paths.modelsCache, JSON.stringify(TEST_MODELS_FILE))
    const r = await cli(["catalog", "diff"])
    expect(r.out).toContain("+ brand-new-llmlb")
  })

  test("stop asks the daemon to shut down", async () => {
    env = await daemonEnv({ keys: {} })
    await env.start()
    const r = await cli(["stop"])
    expect(r.out).toContain("stopping")
    await Bun.sleep(200)
    expect((await cli(["status"])).out).toContain("not running")
  })
})

describe("checkKey VPN classification (ruling R12)", () => {
  test("200 + UFR's VPN page classifies as vpn", async () => {
    const r = await checkKey(
      async () =>
        new Response(
          '<!DOCTYPE html><html lang="de"><head><title>Zugriff eingeschränkt | VPN erforderlich | Open WebUI</title></head></html>',
          { status: 200, headers: { "content-type": "text/html; charset=utf-8" } },
        ),
      "http://x",
      "k",
    )
    expect(r).toBe("vpn")
  })

  test("200 + unrelated HTML (captive portal) classifies as unreachable", async () => {
    const r = await checkKey(
      async () => new Response("<html>captive portal</html>", { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }),
      "http://x",
      "k",
    )
    expect(r).toBe("unreachable")
  })

  test("302 redirect with no body classifies as unreachable", async () => {
    const r = await checkKey(async () => new Response(null, { status: 302 }), "http://x", "k")
    expect(r).toBe("unreachable")
  })
})

describe("ufr setup", () => {
  test("adds a key, checks chat, offers the opencode registration", async () => {
    const r = await cli(["setup"], ["main", "key-a", false, true])
    expect(r.code).toBe(0)
    expect(r.left).toBe(0)
    expect(await env!.secrets.get("main")).toBe("key-a")
    expect(r.out).toContain("UFR chat reachable")
    expect(r.opencodeCalls).toEqual([["plugin", "add", "github:FinleyLaempe/opencode-ufr"]])
  })

  test("setup stops an idle running gateway once, after all keys are added", async () => {
    env = await daemonEnv({ keys: {} })
    await env.start()
    const r = await cli(["setup"], ["main", "key-a", true, "alt", "key-b", false, false])
    expect(r.code).toBe(0)
    expect(r.out.split("restarts with the new keys").length - 1).toBe(1)
    await Bun.sleep(200)
    expect((await cli(["status"])).out).toContain("not running")
  })

  test("off the VPN setup explains what to do", async () => {
    env = await daemonEnv({ keys: {} })
    env.ufr.vpnPage = true
    const r = await cli(["setup"], ["main", "key-a", true, false, false])
    expect(r.out).toContain("VPN")
  })
})

describe("ufr", () => {
  test("help and unknown commands", async () => {
    expect((await cli([])).out).toContain("ufr setup")
    expect((await cli(["frobnicate"])).code).toBe(2)
  })
})
