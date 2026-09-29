import { VPN_MESSAGE, isVpnPage } from "../shared/vpn"
import type { Transport } from "./transport"

export type UpstreamResult =
  | { kind: "ok"; response: Response }
  | { kind: "rate_limited"; status: number; body: string }
  | { kind: "context_overflow"; status: number; body: string }
  | { kind: "auth_invalid"; status: number; body: string }
  | { kind: "unreachable"; message: string }
  | { kind: "error"; status: number; body: string; contentType: string }

const CONTEXT_RE = /maximum context length|max input tokens|context length|context window|too many tokens|prompt is too long/i

/** One call to UFR. Throws only if the caller's own signal aborted. */
export async function callUpstream(o: {
  transport: Transport
  baseUrl: string
  key: string
  body: unknown
  timeoutMs: number
  signal?: AbortSignal
  stream: boolean
}): Promise<UpstreamResult> {
  const timeout = AbortSignal.timeout(o.timeoutMs)
  const signal = o.signal ? AbortSignal.any([o.signal, timeout]) : timeout
  let res: Response
  try {
    res = await o.transport.fetch(`${o.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${o.key}`,
        "Content-Type": "application/json",
        Accept: o.stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(o.body),
      signal,
      redirect: "manual",
    })
  } catch (e) {
    if (o.signal?.aborted) throw e
    if (timeout.aborted) {
      const message = `UFR did not answer within ${Math.round(o.timeoutMs / 1000)} s`
      return {
        kind: "error",
        status: 504,
        body: JSON.stringify({ error: { message, type: "upstream_timeout", code: 504 } }),
        contentType: "application/json",
      }
    }
    return { kind: "unreachable", message: `cannot reach UFR (${(e as Error).message}) — are you connected to the uni VPN?` }
  }
  const type = res.headers.get("content-type") ?? ""
  if (res.status >= 300 && res.status < 400) {
    // Not proof of the VPN wall (ruling R12): only UFR's HTML page below is.
    await res.body?.cancel()
    return { kind: "unreachable", message: `UFR answered with a redirect (HTTP ${res.status}) instead of JSON` }
  }
  if (type.includes("text/html")) {
    const html = await res.text()
    return { kind: "unreachable", message: isVpnPage(html) ? VPN_MESSAGE : `UFR answered with an HTML page (HTTP ${res.status}) instead of JSON` }
  }
  if (res.ok) return { kind: "ok", response: res }
  const body = await res.text()
  if (res.status === 429) return { kind: "rate_limited", status: 429, body }
  if (res.status === 401 || res.status === 403) return { kind: "auth_invalid", status: res.status, body }
  if ((res.status === 400 || res.status === 413) && CONTEXT_RE.test(body)) return { kind: "context_overflow", status: res.status, body }
  return { kind: "error", status: res.status, body, contentType: type || "application/json" }
}
