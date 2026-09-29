import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadModelsFile, loadUfrModels } from "../../src/daemon/catalog-source"
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
const opts = (url: string) => ({
  url: `${url}/models.json`,
  cachePath: join(dir, "models.json"),
  etagPath: join(dir, "models.etag"),
  bundledPath: join(dir, "bundled.json"),
  fetch: (u: string, i?: RequestInit) => fetch(u, i),
  log: noLog,
})

describe("loadModelsFile", () => {
  test("remote copy is validated, cached and its ETag remembered; 304 reuses the cache", async () => {
    let seenTag: string | null = null
    const url = serve((req) => {
      seenTag = req.headers.get("if-none-match")
      if (seenTag === '"v1"') return new Response(null, { status: 304 })
      return new Response(JSON.stringify(TEST_MODELS_FILE), { headers: { etag: '"v1"' } })
    })
    expect((await loadModelsFile(opts(url))).source).toBe("remote")
    expect(JSON.parse(await readFile(join(dir, "models.json"), "utf8"))).toEqual(TEST_MODELS_FILE)
    const second = await loadModelsFile(opts(url))
    expect(seenTag!).toBe('"v1"')
    expect(second).toEqual({ file: TEST_MODELS_FILE, source: "remote" })
  })

  test("a server error falls back to the cache", async () => {
    await writeFile(join(dir, "models.json"), JSON.stringify(TEST_MODELS_FILE))
    const url = serve(() => new Response("boom", { status: 500 }))
    expect((await loadModelsFile(opts(url))).source).toBe("cache")
  })

  test("an invalid remote file is ignored and does not overwrite the cache", async () => {
    await writeFile(join(dir, "models.json"), JSON.stringify(TEST_MODELS_FILE))
    const url = serve(() => Response.json({ schema: 99 }))
    const r = await loadModelsFile(opts(url))
    expect(r.source).toBe("cache")
    expect(JSON.parse(await readFile(join(dir, "models.json"), "utf8"))).toEqual(TEST_MODELS_FILE)
  })

  test("no cache and no network falls back to the bundled copy", async () => {
    await writeFile(join(dir, "bundled.json"), JSON.stringify(TEST_MODELS_FILE))
    const r = await loadModelsFile(opts("http://127.0.0.1:9"))
    expect(r).toEqual({ file: TEST_MODELS_FILE, source: "bundled" })
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

  test("no key and no cache gives an empty list with the reason", async () => {
    const r = await loadUfrModels(ufrOpts("http://127.0.0.1:9/api", null))
    expect(r).toEqual({ models: [], source: "cache", error: "no key configured" })
  })
})
