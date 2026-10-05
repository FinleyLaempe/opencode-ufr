import { BUNDLED_MODELS, loadBundledModels } from "../daemon/catalog-source"
import { applyProbeResults, formatProbeReport, probeAllContexts } from "../daemon/probe-all"
import { VpnManager } from "../daemon/vpn/manager"
import { loadConfig } from "../shared/config"
import { VPN_PASS, VPN_USER } from "../shared/secrets"
import type { CliDeps } from "./index"

/**
 * ufr context-probe — measure every UFR model's context limit with one of the
 * stored keys. Rejected probes are free and don't consume the key's bucket;
 * the report flags values that drifted from models.json. `--write` patches
 * the local models.json copy (the repo copy when run from a checkout).
 *
 * `--vpn` routes the probes through the built-in Fortinet tunnel with the
 * stored uni login (vpn-login/vpn-pass) — for off campus machines without
 * their own VPN connection.
 */
export async function cmdContextProbe(d: CliDeps, args: string[]): Promise<number> {
  const write = args.includes("--write")
  const viaVpn = args.includes("--vpn")
  const cfg = await loadConfig(d.paths.configFile)
  const alias = cfg.keys[0]
  if (!alias) {
    d.io.err("no stored key — run `ufr connect` first\n")
    return 2
  }
  const key = await d.secrets.get(alias)
  if (!key) {
    d.io.err(`key "${alias}" is configured but missing from the keyring\n`)
    return 2
  }
  let fetch = d.fetch
  let vpn: { stop(): Promise<void> } | null = null
  if (viaVpn) {
    const [user, pass] = await Promise.all([d.secrets.get(VPN_USER), d.secrets.get(VPN_PASS)])
    if (!user || !pass) {
      d.io.err("no stored uni login — run `ufr login` or `ufr connect --login …` first\n")
      return 2
    }
    const manager = new VpnManager({
      gateway: cfg.vpn.gateway,
      upstreamHost: new URL(cfg.upstream.baseUrl).hostname,
      baseUrl: cfg.upstream.baseUrl,
      credentials: { user, pass },
      mode: "always",
      log: (m) => d.io.out(`${m}\n`),
      fetch: d.fetch,
    })
    vpn = manager
    fetch = manager.transport().fetch
  }
  const { file } = await loadBundledModels({})
  d.io.out(`probing ${cfg.keys.length} key(s) via "${alias}"${viaVpn ? " through the built-in VPN" : ""} — rejected probes are free, this takes a few minutes\n`)
  try {
    const rows = await probeAllContexts({
      baseUrl: cfg.upstream.baseUrl,
      key,
      fetch,
      file,
      log: (m) => d.io.out(`${m}\n`),
    })
    d.io.out("\n" + formatProbeReport(rows) + "\n")
    return await report(d, file, rows, write)
  } finally {
    if (vpn) await vpn.stop()
  }
}

async function report(
  d: CliDeps,
  file: Awaited<ReturnType<typeof loadBundledModels>>["file"],
  rows: Awaited<ReturnType<typeof probeAllContexts>>,
  write: boolean,
): Promise<number> {
  if (write) {
    const date = new Date().toISOString().slice(0, 10)
    const { file: updated, changed } = applyProbeResults(file, rows, date)
    if (changed.length === 0) {
      d.io.out("\nmodels.json is already current — nothing written\n")
    } else {
      await Bun.write(BUNDLED_MODELS, JSON.stringify(updated, null, 2) + "\n")
      d.io.out(`\n${BUNDLED_MODELS} updated (${changed.length}):\n`)
      for (const c of changed) d.io.out(`  ${c.id}: ${c.from ?? "—"} -> ${c.to}\n`)
      d.io.out("\nIf this is a repo checkout: commit models.json (PR welcome per README).\n")
      d.io.out("On an installed copy this patches your local file until the next plugin/CLI update;\n")
      d.io.out("upstream fixes reach everyone through models.json PRs and releases.\n")
    }
  } else {
    const needsUpdate = rows.filter((r) => r.how === "error-named" && r.probed !== null && r.probed !== r.known)
    if (needsUpdate.length > 0) {
      d.io.out("\nrun `ufr context-probe --write` to patch your local models.json, or PR the values upstream\n")
      return 1
    }
  }
  return 0
}
