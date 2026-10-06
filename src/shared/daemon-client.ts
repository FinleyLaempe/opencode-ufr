import type { FetchLike } from "../daemon/catalog-source"
import { readJson, readText } from "./fs"
import type { Paths } from "./paths"

/** What daemon.json holds (written by the daemon at startup). */
export type DaemonInfo = { port: number; pid: number; version: string }

/** Runtime-checked read of daemon.json — the one parser for that file (used by the plugin and the daemon itself). */
export async function readDaemonInfo(paths: Paths): Promise<DaemonInfo | null> {
  const j = (await readJson(paths.daemonFile)) as Record<string, unknown> | null
  if (j === null || typeof j.port !== "number" || typeof j.version !== "string") return null
  return { port: j.port, pid: typeof j.pid === "number" ? j.pid : 0, version: j.version }
}

/** A request to the running daemon, or null if none answers. */
export async function daemonRequest(paths: Paths, f: FetchLike, path: string, method = "GET"): Promise<Response | null> {
  const info = await readDaemonInfo(paths)
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
