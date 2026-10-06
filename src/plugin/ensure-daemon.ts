import { spawn } from "node:child_process"
import { mkdirSync } from "node:fs"
import { readText } from "../shared/fs"
import { readDaemonInfo, type DaemonInfo } from "../shared/daemon-client"
import type { Paths } from "../shared/paths"

export type { DaemonInfo }
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

async function readToken(paths: Paths): Promise<string | null> {
  return (await readText(paths.tokenFile))?.trim() || null
}

/** Find the shared daemon, replace it if we are newer and it is idle, or start one. */
export async function ensureDaemon(o: {
  paths: Paths
  version: string
  spawn: (onError: (e: Error) => void) => void
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  timeoutMs?: number
  now?: () => number
}): Promise<Conn> {
  const f: FetchLike = o.fetch ?? ((u, i) => fetch(u, i))
  const sleep = o.sleep ?? ((ms: number) => Bun.sleep(ms))
  const now = o.now ?? Date.now
  const health = async (port: number): Promise<{ version: string } | null> => {
    try {
      const r = await f(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (!r.ok) return null
      const h = (await r.json()) as { version?: unknown }
      // Only reuse a daemon that identifies itself — a 200 without a version could be anything on that port.
      return typeof h.version === "string" ? { version: h.version } : null
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
      if (!isNewer(o.version, h.version)) return { port: info.port, token }
      const res = await f(`http://127.0.0.1:${info.port}/v1/_status`, authed(token)).catch(() => null)
      if (res !== null && !res.ok && (res.status === 401 || res.status === 403)) {
        // The stored token is rejected — handing the conn back would only serve
        // 401s, and this daemon can be neither stopped nor replaced without a
        // valid token. Fail with the reason instead of pretending success.
        throw new Error(
          "the running opencode-ufr gateway rejects the stored token — restart it or remove the opencode-ufr state directory",
        )
      }
      // Any other non-ok answer (a 503 while the daemon restarts, say) is not a
      // token rejection: it lands in the couldn't-verify path below.
      const st = res !== null ? ((await res.json().catch(() => null)) as { inFlight?: unknown } | null) : null
      const inFlight = st !== null && typeof st.inFlight === "number" ? st.inFlight : null
      if (inFlight === null) {
        // Couldn't verify (transport hiccup on the probe, or a non-ok _status
        // above) — not confirmed idle: fall through to the spawn path below
        // instead of trusting the guess. Spawning while the old daemon still
        // holds the lock is safe: the child cannot take over and exits quietly
        // (no error event — only a failed exec fires one), and the health poll
        // below keeps answering with the running daemon's conn either way.
      } else if (inFlight > 0) {
        return { port: info.port, token } // upgrade later, never mid-request
      } else {
        await f(`http://127.0.0.1:${info.port}/v1/_shutdown`, authed(token, "POST")).catch(() => null)
        for (let i = 0; i < 25 && (await health(info.port)); i++) await sleep(200)
      }
    }
  }

  const spawnError: { message: string | null } = { message: null }
  o.spawn((e) => {
    spawnError.message = e.message
  })
  // Startup can take up to ~35 s: two catalog fetches (models.json, UFR /api/models)
  // with 15 s and 20 s timeouts before /health answers.
  const timeoutMs = o.timeoutMs ?? 40_000
  const deadline = now() + timeoutMs
  while (now() < deadline) {
    if (spawnError.message !== null) {
      throw new Error(`the opencode-ufr gateway failed to start (${spawnError.message}) — see daemon.log`)
    }
    await sleep(200)
    const next = await readDaemonInfo(o.paths)
    const token = await readToken(o.paths)
    if (next && token && (await health(next.port))) return { port: next.port, token }
  }
  if (spawnError.message !== null) {
    throw new Error(`the opencode-ufr gateway failed to start (${spawnError.message}) — see daemon.log`)
  }
  throw new Error(`the opencode-ufr gateway did not start within ${Math.round(timeoutMs / 1000)} s — see daemon.log`)
}

/**
 * Start the daemon detached on the runtime that runs opencode (BUN_BE_BUN: opencode's own Bun).
 * It runs in `cwd` (the state directory), never in the spawning project: Bun auto-loads
 * .env / bunfig.toml from the working directory, and on Windows the folder would stay locked.
 */
export function spawnDaemon(entry: string, cwd: string, onError?: (e: Error) => void): void {
  mkdirSync(cwd, { recursive: true })
  const child = spawn(process.execPath, [entry], {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, BUN_BE_BUN: "1" },
  })
  if (onError) child.on("error", (e) => onError(e instanceof Error ? e : new Error(String(e))))
  child.unref()
}
