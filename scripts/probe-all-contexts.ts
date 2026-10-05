#!/usr/bin/env bun
/**
 * probe-all-contexts.ts — measure every UFR model's context limit and update
 * models.json. Run before committing model data, and from the probe-contexts
 * workflow (weekly + on demand) so the bundled values stay current.
 *
 *   bun scripts/probe-all-contexts.ts --key-stdin            # report only
 *   bun scripts/probe-all-contexts.ts --keyring key1 --write # update models.json
 *   UFR_PROBE_KEY=sk-… bun scripts/probe-all-contexts.ts --write   # CI form
 *
 * Rejected probes are free (refused before pricing) and don't consume the
 * 20/min key bucket; money is only spent on accepted rungs (context grew) or
 * paid models with --paid. Full report: src/daemon/probe-all.ts.
 */
import { BUNDLED_MODELS, loadBundledModels } from "../src/daemon/catalog-source"
import { applyProbeResults, formatProbeReport, probeAllContexts } from "../src/daemon/probe-all"
import { KeyringStore } from "../src/shared/secrets"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const valueOf = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const key =
  (valueOf("--key") ?? "").trim() ||
  process.env.UFR_PROBE_KEY?.trim() ||
  (flag("--key-stdin") ? require("node:fs").readFileSync(0, "utf8").trim() : "") ||
  (valueOf("--keyring") ? await new KeyringStore().get(valueOf("--keyring")!) : null) ||
  ""
if (!key) {
  console.error("no key — use --key, UFR_PROBE_KEY, --key-stdin or --keyring <alias>")
  process.exit(2)
}

const baseUrl = valueOf("--base-url") ?? "https://openwebui.uni-freiburg.de/api"
const { file } = await loadBundledModels({ bundledPath: valueOf("--models-json") ?? BUNDLED_MODELS })
const log = (m: string) => console.error(m)

const rows = await probeAllContexts({
  baseUrl,
  key,
  fetch: (u, i) => fetch(u, i),
  file,
  includePaid: flag("--paid"),
  paceMs: Number(valueOf("--pace-ms") ?? 3_000),
  log,
})
console.log(formatProbeReport(rows))

if (flag("--write")) {
  const date = new Date().toISOString().slice(0, 10)
  const { file: updated, changed } = applyProbeResults(file, rows, date)
  if (changed.length === 0) {
    console.error("\nmodels.json is already current — nothing written")
  } else {
    await Bun.write(valueOf("--models-json") ?? BUNDLED_MODELS, JSON.stringify(updated, null, 2) + "\n")
    console.error(`\nmodels.json updated (${changed.length}):`)
    for (const c of changed) console.error(`  ${c.id}: ${c.from ?? "—"} -> ${c.to}`)
  }
}
