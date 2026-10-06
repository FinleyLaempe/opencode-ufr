import { fileURLToPath } from "node:url"
import { readJson, writeFileAtomic } from "../shared/fs"
import { type ModelsFile, validateModelsFile } from "../shared/models-file"
import { VPN_MESSAGE, isVpnPage } from "../shared/vpn"
import { type UfrModel, parseUfrModels } from "./catalog"

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>
export type ModelsSource = "bundled"

export const BUNDLED_MODELS = fileURLToPath(new URL("../../models.json", import.meta.url))

/**
 * The fixes file ships with the package (models.json in the release) — no
 * remote pull. Model data updates arrive with plugin updates; UFR's live
 * model list supplies everything else.
 */
export async function loadBundledModels(o: {
  bundledPath?: string
}): Promise<{ file: ModelsFile; source: ModelsSource }> {
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
      // The 3xx check must come first: real redirects carry text/html, so the HTML
      // branch below would otherwise swallow them (and could even misfire isVpnPage
      // on a redirect page). Same ordering as callUpstream.
      if (res.status >= 300 && res.status < 400) {
        // Not proof of the VPN wall — cancel the body (like callUpstream does) so
        // the connection is not left hanging on a redirect we will not follow.
        await res.body?.cancel()
        throw new Error(`UFR answered with a redirect (HTTP ${res.status}) instead of JSON`)
      }
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
