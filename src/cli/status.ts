import type { StatusJson } from "../daemon/daemon"
import { loadConfig } from "../shared/config"
import { VPN_PASS, VPN_USER } from "../shared/secrets"
import { daemonRequest } from "./daemon-client"
import type { CliDeps } from "./index"

const ago = (ms: number) =>
  ms < 60_000 ? `${Math.round(ms / 1000)}s` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 3_600_000)}h`

export function formatStatus(s: StatusJson): string {
  const L: string[] = []
  L.push(`gateway   v${s.version}  pid ${s.pid}  127.0.0.1:${s.port}  up ${ago(s.uptimeMs)}  in flight ${s.inFlight}`)
  if (s.upstream.ok === false) L.push(`UFR       NOT reachable — ${s.upstream.message}`)
  else if (s.upstream.ok) L.push(`UFR       reachable (checked ${ago(s.now - s.upstream.at)} ago)`)
  else L.push("UFR       not checked yet")
  if (s.keys.length === 0) L.push("keys      none — run `ufr connect`")
  s.keys.forEach((k, i) => {
    const spend = s.spendToday[k.alias] ?? 0
    const pct = s.dailyBudgetUsd > 0 ? ` (${((spend / s.dailyBudgetUsd) * 100).toFixed(2)}% of $${s.dailyBudgetUsd}, est.)` : ""
    const state = k.invalid ? "  INVALID" : k.blockedForMs > 0 ? `  cooling down ${ago(k.blockedForMs)}` : ""
    L.push(`${i === 0 ? "keys      " : "          "}${k.alias}  ${k.used}/${k.cap} per 60s  today $${spend.toFixed(4)}${pct}${state}`)
  })
  L.push(`pool      ${s.pool.enabled ? `${s.pool.inWindow}/${s.pool.cap} per hour` : "limiter off"}`)
  const open = Object.entries(s.breakers).filter(([, b]) => b.state !== "closed")
  L.push(open.length === 0 ? "breakers  all closed"
    : `breakers  ${open.map(([g, b]) => `${g} ${b.state} (rung ${b.level + 1}, ${ago(b.retryAfterMs)} left)`).join(", ")}`)
  L.push(`catalog   ${s.catalog.models} models; models.json from ${s.catalog.source}, UFR list from ${s.catalog.ufrSource}` +
    (s.catalog.loadedAt ? ` (loaded ${ago(s.now - s.catalog.loadedAt)} ago)` : ""))
  if (s.vpn) L.push(`vpn       ${s.vpn.mode} — ${s.vpn.detail}`)
  for (const w of s.catalog.warnings) L.push(`warning   ${w}`)
  return L.join("\n") + "\n"
}

export async function cmdStatus(d: CliDeps): Promise<number> {
  const user = await d.secrets.get(VPN_USER)
  const pass = await d.secrets.get(VPN_PASS)
  const vpnLine = user
    ? `vpn       login ${user} (password ${pass ? "stored" : "MISSING in keyring"})\n`
    : "vpn       login not stored — off campus the built-in VPN needs one (ufr login add <user>)\n"
  const res = await daemonRequest(d.paths, d.fetch, "/v1/_status")
  if (!res || !res.ok) {
    const cfg = await loadConfig(d.paths.configFile)
    d.io.out(`gateway   not running (opencode starts it)\nkeys      ${cfg.keys.join(", ") || "none — run `ufr connect`"}\n${vpnLine}`)
    return 0
  }
  d.io.out(formatStatus((await res.json()) as StatusJson) + vpnLine)
  return 0
}
