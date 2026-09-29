import type { FetchLike } from "../daemon/catalog-source"
import { readJson, readText } from "../shared/fs"
import type { Paths } from "../shared/paths"

/** A request to the running daemon, or null if none answers. */
export async function daemonRequest(paths: Paths, f: FetchLike, path: string, method = "GET"): Promise<Response | null> {
  const info = (await readJson(paths.daemonFile)) as { port?: number } | null
  const token = (await readText(paths.tokenFile))?.trim()
  if (!info?.port || !token) return null
  try {
    return await f(`http://127.0.0.1:${info.port}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5_000),
    })
  } catch {
    return null
  }
}
