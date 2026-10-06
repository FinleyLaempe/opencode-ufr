/**
 * The one door scripts knock on: a connection to the local opencode-ufr
 * gateway. Every model call made through here rides the gateway's central
 * key rotation and soft rate limiting — the caller waits for a key slot
 * instead of being told to back off, and never has to pace itself with
 * artificial sleeps. Two primitives:
 *
 *  - relay(): one raw upstream call to exactly the requested model (no
 *    fallbacks, no context hub, no reasoning retry) with UFR's status and
 *    body passed through verbatim. For context probes and tools that must
 *    know which model answered.
 *  - chat(): a full chat completion with the gateway's fallback chain and
 *    reasoning retry, for tools that just want text.
 */
import { fileURLToPath } from "node:url"
import { type Conn, ensureDaemon, spawnDaemon } from "../plugin/ensure-daemon"
import { resolvePaths } from "../shared/paths"
import { VERSION } from "../shared/version"

const DAEMON_ENTRY = fileURLToPath(new URL("../daemon/main.ts", import.meta.url))

export type Gateway = { port: number; token: string; baseUrl: string }

/** Find the running gateway or start one (waits up to ~40 s on a cold start). */
export async function connectGateway(): Promise<Gateway> {
  const paths = resolvePaths()
  const conn: Conn = await ensureDaemon({
    paths,
    version: VERSION,
    spawn: () => spawnDaemon(DAEMON_ENTRY, paths.stateDir),
  })
  return { port: conn.port, token: conn.token, baseUrl: `http://127.0.0.1:${conn.port}` }
}

export type RawResult = { status: number; body: string; retryAfterMs?: number; contentType: string }

function retryAfterOf(res: Response): number | undefined {
  const s = Number(res.headers.get("retry-after"))
  return Number.isFinite(s) && s > 0 ? s * 1000 : undefined
}

/** One raw upstream call through the gateway (POST /v1/_relay). */
export async function relay(
  gw: Gateway,
  body: Record<string, unknown>,
  o: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<RawResult> {
  const signal = o.timeoutMs
    ? AbortSignal.any([o.signal, AbortSignal.timeout(o.timeoutMs)].filter((s): s is AbortSignal => s !== undefined))
    : o.signal
  const res = await fetch(`${gw.baseUrl}/v1/_relay`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gw.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  }).catch((e) => {
    throw new Error(`cannot reach the gateway at ${gw.baseUrl} (${(e as Error).message})`)
  })
  return {
    status: res.status,
    body: await res.text(),
    retryAfterMs: retryAfterOf(res),
    contentType: res.headers.get("content-type") ?? "application/json",
  }
}

export type ChatResult = { status: number; json: unknown }

/** A full chat completion through the gateway (POST /v1/chat/completions). */
export async function chat(
  gw: Gateway,
  body: Record<string, unknown>,
  o: { signal?: AbortSignal } = {},
): Promise<ChatResult> {
  const res = await fetch(`${gw.baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${gw.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: o.signal,
  }).catch((e) => {
    throw new Error(`cannot reach the gateway at ${gw.baseUrl} (${(e as Error).message})`)
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    json = { error: { message: text.slice(0, 500), type: "invalid_response", code: res.status } }
  }
  return { status: res.status, json }
}

/** The gateway's raw catalog inputs: UFR's model list plus the bundled models.json. */
export async function catalogData(gw: Gateway): Promise<{ ufr: unknown; file: unknown } | null> {
  const res = await fetch(`${gw.baseUrl}/v1/_catalog`, {
    headers: { Authorization: `Bearer ${gw.token}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null)
  if (!res?.ok) return null
  return (await res.json()) as { ufr: unknown; file: unknown } | null
}
