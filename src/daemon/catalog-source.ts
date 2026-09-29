import { fileURLToPath } from "node:url"
import { readJson, readText, writeFileAtomic } from "../shared/fs"
import { type ModelsFile, validateModelsFile } from "../shared/models-file"
import { VPN_MESSAGE, isVpnPage } from "../shared/vpn"
import { type UfrModel, parseUfrModels } from "./catalog"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export type ModelsSource = "remote" | "cache" | "bundled"

export const BUNDLED_MODELS = fileURLToPath(new URL("../../models.json", import.meta.url))

/** models.json: remote (ETag) → last good cache → copy shipped in the package. */
export async function loadModelsFile(o: {
  url: string
  cachePath: string
  etagPath: string
  bundledPath?: string
  fetch: FetchLike
  log: (m: string) => void
}): Promise<{ file: ModelsFile; source: ModelsSource }> {
  const cached = await readJson(o.cachePath)
  const etag = cached ? (await readText(o.etagPath))?.trim() : undefined
  try {
    const res = await o.fetch(o.url, {
      headers: etag ? { "If-None-Match": etag } : {},
      signal: AbortSignal.timeout(15_000),
    })
    if (res.status === 304 && cached) return { file: validateModelsFile(cached), source: "remote" }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const file = validateModelsFile(JSON.parse(text)) // validate before it can replace a good cache
    await writeFileAtomic(o.cachePath, text)
    const tag = res.headers.get("etag")
    if (tag) await writeFileAtomic(o.etagPath, tag)
    return { file, source: "remote" }
  } catch (e) {
    o.log(`models.json: remote copy unavailable or invalid (${(e as Error).message}) — using the ${cached ? "cached" : "bundled"} copy`)
  }
  if (cached) {
    try {
      return { file: validateModelsFile(cached), source: "cache" }
    } catch (e) {
      o.log(`models.json: cached copy invalid (${(e as Error).message})`)
    }
  }
  const bundled: unknown = JSON.parse(await Bun.file(o.bundledPath ?? BUNDLED_MODELS).text())
  return { file: validateModelsFile(bundled), source: "bundled" }
}

/** UFR's own model list (needs the VPN like every UFR path); last good list is cached. */
export async function loadUfrModels(o: {
  baseUrl: string
  key: string | null
  cachePath: string
  fetch: FetchLike
  log: (m: string) => void
}): Promise<{ models: UfrModel[]; source: "remote" | "cache"; error: string | null }> {
  let error: string
  if (!o.key) {
    error = "no key configured"
  } else {
    try {
      const res = await o.fetch(`${o.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${o.key}` },
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      })
      const type = res.headers.get("content-type") ?? ""
      if (type.includes("text/html")) {
        const html = await res.text()
        throw new Error(isVpnPage(html) ? VPN_MESSAGE : `HTML instead of JSON (HTTP ${res.status})`)
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const models = parseUfrModels(await res.json())
      if (models.length === 0) throw new Error("UFR returned an empty model list")
      await writeFileAtomic(o.cachePath, JSON.stringify(models))
      return { models, source: "remote", error: null }
    } catch (e) {
      error = (e as Error).message
    }
  }
  o.log(`UFR /api/models: ${error} — using the cached model list`)
  const cached = await readJson(o.cachePath)
  return { models: Array.isArray(cached) ? (cached as UfrModel[]) : [], source: "cache", error }
}
