import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { readJson, readText } from "../shared/fs"
import type { Paths } from "../shared/paths"

export type DaemonInfo = { port: number; pid: number; version: string }
export type Conn = { port: number; token: string }
type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export function isNewer(a: string, b: string): boolean {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x !== y) return x > y
  }
  return false
}

export async function readDaemonInfo(paths: Paths): Promise<DaemonInfo | null> {
  const j = (await readJson(paths.daemonFile)) as Partial<DaemonInfo> | null
  return j && typeof j.port === "number" && typeof j.version === "string" ? { port: j.port, pid: j.pid ?? 0, version: j.version } : null
}

async function readToken(paths: Paths): Promise<string | null> {
  return (await readText(paths.tokenFile))?.trim() || null
}

/** Find the shared daemon, replace it if we are newer and it is idle, or start one. */
export async function ensureDaemon(o: {
  paths: Paths
  version: string
  spawn: () => void
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  now?: () => number
}): Promise<Conn> {
  const f: FetchLike = o.fetch ?? ((u, i) => fetch(u, i))
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = o.now ?? Date.now
  const health = async (port: number) => {
    try {
      const r = await f(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      return r.ok ? ((await r.json()) as { version?: string }) : null
    } catch {
      return null
    }
  }
  const authed = (token: string, method = "GET"): RequestInit => ({
    method,
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(2_000),
  })

  const info = await readDaemonInfo(o.paths)
  if (info) {
    const h = await health(info.port)
    const token = await readToken(o.paths)
    if (h && token) {
      if (!h.version || !isNewer(o.version, h.version)) return { port: info.port, token }
      const st = (await f(`http://127.0.0.1:${info.port}/v1/_status`, authed(token))
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null)) as { inFlight?: number } | null
      if (!st || (st.inFlight ?? 0) > 0) return { port: info.port, token } // upgrade later, never mid-request
      await f(`http://127.0.0.1:${info.port}/v1/_shutdown`, authed(token, "POST")).catch(() => null)
      for (let i = 0; i < 25 && (await health(info.port)); i++) await sleep(200)
    }
  }

  o.spawn()
  // Startup can take up to ~35 s: two catalog fetches (models.json, UFR /api/models)
  // with 15 s and 20 s timeouts before /health answers.
  const timeoutMs = o.timeoutMs ?? 40_000
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    await sleep(200)
    const next = await readDaemonInfo(o.paths)
    const token = await readToken(o.paths)
    if (next && token && (await health(next.port))) return { port: next.port, token }
  }
  throw new Error(`the opencode-ufr gateway did not start within ${Math.round(timeoutMs / 1000)} s — see daemon.log`)
}

/**
 * Start the daemon detached on the runtime that runs opencode (BUN_BE_BUN: opencode's own Bun).
 * It runs in `cwd` (the state directory), never in the spawning project: Bun auto-loads
 * .env / bunfig.toml from the working directory, and on Windows the folder would stay locked.
 */
export function spawnDaemon(entry: string, cwd: string): void {
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [entry], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, BUN_BE_BUN: "1" },
  })
  child.unref()
}
