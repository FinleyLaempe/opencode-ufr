#!/usr/bin/env bun
/**
 * probe-all-contexts.ts — measure every UFR model's context limit and update
 * models.json. Run before committing model data, and from the probe-contexts
 * workflow (weekly + on demand) so the bundled values stay current.
 *
 *   bun scripts/probe-all-contexts.ts                 # via the gateway (default)
 *   bun scripts/probe-all-contexts.ts --write         # update models.json
 *   bun scripts/probe-all-contexts.ts --direct --key-stdin   # without a gateway
 *
 * Gateway mode (default) sends every probe through the local opencode-ufr
 * gateway's relay: central key rotation, soft rate limiting and circuit
 * breakers — no key argument and no artificial pacing needed, the key pool
 * decides when each call goes out. Rejected probes are free (refused before
 * pricing) and don't consume the 20/min key bucket; money is only spent on
 * accepted rungs (context grew) or paid models with --paid.
 *
 * Direct mode (--direct) calls UFR itself, for machines without the gateway
 * (e.g. CI runners): needs --key / UFR_PROBE_KEY / --key-stdin / --keyring and
 * paces itself with a pause between models. --vpn routes through the built-in
 * Fortinet tunnel (UFR_VPN_LOGIN + UFR_VPN_PASSWORD in the environment).
 */
import { BUNDLED_MODELS, loadBundledModels } from "../src/daemon/catalog-source"
import { parseUfrModels, type UfrModel } from "../src/daemon/catalog"
import { applyProbeResults, formatProbeReport, probeAllContexts } from "../src/daemon/probe-all"
import { VpnManager } from "../src/daemon/vpn/manager"
import { catalogData, connectGateway, relay } from "../src/client/gateway"
import { KeyringStore } from "../src/shared/secrets"

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const valueOf = (name: string) => {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

const modelsJsonPath = valueOf("--models-json") ?? BUNDLED_MODELS
const { file } = await loadBundledModels({ bundledPath: modelsJsonPath })
const log = (m: string) => console.error(m)

const direct = flag("--direct")

type ProbeDeps = Parameters<typeof probeAllContexts>[0]

let deps: ProbeDeps
let stopVpn: (() => Promise<void>) | null = null

if (!direct) {
  // -- Gateway mode: everything through the local gateway's relay.
  const gw = await connectGateway().catch((e) => {
    console.error(`cannot reach the gateway (${(e as Error).message}) — start opencode once, or use --direct`)
    process.exit(2)
  })
  const cat = await catalogData(gw)
  if (!cat) {
    console.error("gateway answered but has no catalog yet — is it connected to UFR? (start opencode once, then check GET /v1/_status under `upstream` and `catalog`)")
    process.exit(2)
  }
  if (valueOf("--pace-ms") !== undefined) {
    log("--pace-ms is ignored in gateway mode — the gateway's key pool decides when each call goes out")
  }
  const call = (body: Record<string, unknown>) => relay(gw, body, { timeoutMs: 200_000 })
  deps = {
    call,
    ufr: cat.ufr as UfrModel[],
    file: cat.file as typeof file,
    includePaid: flag("--paid"),
    paceMs: 0, // the key pool paces; no artificial gap
    log,
  }
} else {
  // -- Direct mode: call UFR ourselves, pace with a pause between models.
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
  let fetchImpl: (u: string, init?: RequestInit) => Promise<Response> = (u, i) => fetch(u, i)
  if (flag("--vpn")) {
    const user = process.env.UFR_VPN_LOGIN?.trim()
    const pass = process.env.UFR_VPN_PASSWORD?.trim()
    if (!user || !pass) {
      console.error("--vpn needs UFR_VPN_LOGIN and UFR_VPN_PASSWORD in the environment")
      process.exit(2)
    }
    const vpn = new VpnManager({
      gateway: "https://fortivpn.uni-freiburg.de",
      upstreamHost: new URL(baseUrl).hostname,
      baseUrl,
      credentials: { user, pass },
      mode: "always",
      log,
    })
    fetchImpl = vpn.transport().fetch
    stopVpn = () => vpn.stop()
  }
  const res = await fetchImpl(`${baseUrl}/models`, {
    headers: { Authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(20_000),
    redirect: "manual",
  })
  if (!res.ok) {
    console.error(`UFR /api/models: HTTP ${res.status}`)
    await stopVpn?.()
    process.exit(2)
  }
  const call = async (body: Record<string, unknown>) => {
    const r = await fetchImpl(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(180_000),
      redirect: "manual",
    })
    return { status: r.status, body: await r.text().catch(() => "") }
  }
  const rawPace = valueOf("--pace-ms")
  let paceMs = 3_000
  if (rawPace !== undefined) {
    const n = Number(rawPace)
    if (Number.isFinite(n) && n >= 0) paceMs = n
    else log(`--pace-ms "${rawPace}" is not a number — using the default ${paceMs} ms`)
  }
  deps = {
    call,
    ufr: parseUfrModels(await res.json()),
    file,
    includePaid: flag("--paid"),
    paceMs,
    log,
  }
}

let rows
try {
  rows = await probeAllContexts(deps)
} finally {
  await stopVpn?.()
}
console.log(formatProbeReport(rows))

if (flag("--write")) {
  const date = new Date().toISOString().slice(0, 10)
  const { file: updated, changed } = applyProbeResults(deps.file as typeof file, rows, date)
  if (changed.length === 0) {
    console.error("\nmodels.json is already current — nothing written")
  } else {
    await Bun.write(modelsJsonPath, JSON.stringify(updated, null, 2) + "\n")
    console.error(`\nmodels.json updated (${changed.length}):`)
    for (const c of changed) console.error(`  ${c.id}: ${c.from ?? "—"} -> ${c.to}`)
  }
}
