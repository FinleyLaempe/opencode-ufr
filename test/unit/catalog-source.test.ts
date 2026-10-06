import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadBundledModels, loadUfrModels } from "../../src/daemon/catalog-source"
import { TEST_MODELS_FILE, UFR_RAW_MODELS } from "../support/models"

let dir = ""
let stopServer: (() => void) | null = null
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ufr-src-"))
})
afterEach(async () => {
  stopServer?.()
  stopServer = null
  await rm(dir, { recursive: true, force: true })
})

function serve(handler: (req: Request) => Response | Promise<Response>): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
  stopServer = () => s.stop(true)
  return `http://127.0.0.1:${s.port}`
}

const noLog = () => {}

describe("loadBundledModels", () => {
  test("loads the copy shipped with the package", async () => {
    const bundled = join(dir, "bundled.json")
    await writeFile(bundled, JSON.stringify(TEST_MODELS_FILE))
    expect(await loadBundledModels({ bundledPath: bundled })).toEqual({ file: TEST_MODELS_FILE, source: "bundled" })
  })

  test("an invalid bundled file fails loudly (it ships with the release)", async () => {
    const bundled = join(dir, "bundled.json")
    await writeFile(bundled, JSON.stringify({ schema: 99 }))
    expect(loadBundledModels({ bundledPath: bundled })).rejects.toThrow()
  })
})

describe("loadUfrModels", () => {
  const ufrOpts = (baseUrl: string, key: string | null) => ({
    baseUrl, key, cachePath: join(dir, "ufr.json"), fetch: (u: string, i?: RequestInit) => fetch(u, i), log: noLog,
  })

  test("reads the live list with the key and caches it", async () => {
    let auth = ""
    const url = serve((req) => {
      auth = req.headers.get("authorization") ?? ""
      return Response.json({ data: UFR_RAW_MODELS })
    })
    const r = await loadUfrModels(ufrOpts(`${url}/api`, "sk-test"))
    expect(auth).toBe("Bearer sk-test")
    expect(r.source).toBe("remote")
    expect(r.error).toBeNull()
    expect(r.models).toHaveLength(UFR_RAW_MODELS.length)
    expect(JSON.parse(await readFile(join(dir, "ufr.json"), "utf8"))).toHaveLength(UFR_RAW_MODELS.length)
  })

  test("the off-VPN HTML page is reported as a VPN problem and the cache is used", async () => {
    await writeFile(join(dir, "ufr.json"), JSON.stringify([{ id: "glm-5.2-llmlb", name: "GLM", tier: "free", vision: false }]))
    const url = serve(() => new Response("<title>Zugriff eingeschränkt | VPN erforderlich</title>", { headers: { "content-type": "text/html" } }))
    const r = await loadUfrModels(ufrOpts(`${url}/api`, "sk-test"))
    expect(r.source).toBe("cache")
    expect(r.error).toContain("VPN")
    expect(r.models.map((m) => m.id)).toEqual(["glm-5.2-llmlb"])
  })

  test("a 3xx redirect is reported as a redirect and the cache is used", async () => {
    await writeFile(join(dir, "ufr.json"), JSON.stringify([{ id: "glm-5.2-llmlb", name: "GLM", tier: "free", vision: false }]))
    const url = serve(() => new Response(null, { status: 302, headers: { location: `${"https://openwebui.uni-freiburg.de"}/remote/login` } }))
    const r = await loadUfrModels(ufrOpts(`${url}/api`, "sk-test"))
    expect(r.source).toBe("cache")
    expect(r.error).toContain("redirect")
  })

  test("no key and no cache gives an empty list with the reason", async () => {
    const r = await loadUfrModels(ufrOpts("http://127.0.0.1:9/api", null))
    expect(r).toEqual({ models: [], source: "cache", error: "no key configured" })
  })
})
