import { BUNDLED_MODELS, loadBundledModels } from "../daemon/catalog-source"
import { applyProbeResults, formatProbeReport, probeAllContexts } from "../daemon/probe-all"
import { loadConfig } from "../shared/config"
import type { CliDeps } from "./index"

/**
 * ufr context-probe — measure every UFR model's context limit with one of the
 * stored keys. Rejected probes are free and don't consume the key's bucket;
 * the report flags values that drifted from models.json. `--write` patches
 * the local models.json copy (the repo copy when run from a checkout).
 */
export async function cmdContextProbe(d: CliDeps, args: string[]): Promise<number> {
  const write = args.includes("--write")
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
  const { file } = await loadBundledModels({})
  d.io.out(`probing ${cfg.keys.length} key(s) via "${alias}" — rejected probes are free, this takes a few minutes\n`)
  const rows = await probeAllContexts({
    baseUrl: cfg.upstream.baseUrl,
    key,
    fetch: d.fetch,
    file,
    log: (m) => d.io.out(`${m}\n`),
  })
  d.io.out("\n" + formatProbeReport(rows) + "\n")

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
