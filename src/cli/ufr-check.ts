import type { FetchLike } from "../daemon/catalog-source"
import { isVpnPage } from "../shared/vpn"

export type Check = "ok" | "invalid" | "vpn" | "unreachable" | "rate_limited"

async function classify(res: Response): Promise<Check> {
  const type = res.headers.get("content-type") ?? ""
  if (type.includes("text/html")) {
    const html = await res.text().catch(() => "")
    return isVpnPage(html) ? "vpn" : "unreachable"
  }
  if (res.status >= 300 && res.status < 400) return "unreachable"
  if (res.status === 401 || res.status === 403) return "invalid"
  if (res.status === 429) return "rate_limited"
  return res.ok ? "ok" : "unreachable"
}

export async function checkKey(f: FetchLike, baseUrl: string, key: string): Promise<Check> {
  try {
    return await classify(await f(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${key}` },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    }))
  } catch {
    return "unreachable"
  }
}

/** One minimal chat call (max_tokens 1) — proves the whole path incl. the VPN. */
export async function checkChat(f: FetchLike, baseUrl: string, key: string, model: string): Promise<Check> {
  try {
    return await classify(await f(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "Hi" }] }),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    }))
  } catch {
    return "unreachable"
  }
}
