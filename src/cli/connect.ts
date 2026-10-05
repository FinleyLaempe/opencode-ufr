import { parseArgs } from "node:util"
import { ALIAS_RE, loadConfig, saveConfig } from "../shared/config"
import { VPN_PASS, VPN_USER } from "../shared/secrets"
import { checkKey, type Check } from "./ufr-check"
import { applyKeyChange } from "./keys"
import type { CliDeps } from "./index"

const LABEL: Record<Check | "missing", string> = {
  ok: "ok",
  invalid: "INVALID (UFR says 401)",
  vpn: "not verified — not on the uni VPN",
  unreachable: "not verified — UFR unreachable",
  rate_limited: "ok (currently rate-limited)",
  missing: "MISSING in keyring",
}

const PLUGIN_SPEC = "github:FinleyLaempe/opencode-ufr"

/** Splits a key list on commas AND newlines, trims whitespace, drops empties. */
export function splitKeys(spec: string): string[] {
  return spec
    .split(/[,\n\r]+/)
    .map((k) => k.trim())
    .filter((k) => k.length > 0)
}

/** Auto-aliases key1…keyN, skipping numbers already in use. */
export function nextAliases(existing: string[], count: number): string[] {
  const used = new Set(existing)
  const out: string[] = []
  for (let n = 1; out.length < count; n++) {
    const alias = `key${n}`
    if (!used.has(alias)) {
      used.add(alias)
      out.push(alias)
    }
  }
  return out
}

async function storeKey(d: CliDeps, alias: string, key: string): Promise<{ stored: boolean; check: Check }> {
  const cfg = await loadConfig(d.paths.configFile)
  const check = await checkKey(d.fetch, cfg.upstream.baseUrl, key)
  if (check === "invalid") return { stored: false, check }
  if (check !== "ok" && check !== "rate_limited") {
    const why = check === "vpn" ? "not on the uni VPN" : "UFR unreachable"
    if (!(await d.io.confirm(`could not verify this key (${why}). Store it anyway?`))) return { stored: false, check }
  }
  await d.secrets.set(alias, key)
  if (!cfg.keys.includes(alias)) {
    cfg.keys.push(alias)
    await saveConfig(d.paths.configFile, cfg)
  }
  return { stored: true, check }
}

async function stopIdleGateway(d: CliDeps): Promise<void> {
  await applyKeyChange({ paths: d.paths, fetch: d.fetch, log: (m) => d.io.out(m + "\n") })
}

/**
 * ufr connect — one command for everything: uni login (optional) + API keys.
 * Interactive when arguments are missing; fully non-interactive with flags
 * (what the /connect slash command uses).
 */
export async function cmdConnect(d: CliDeps, args: string[]): Promise<number> {
  const { values } = parseArgs({
    args,
    options: {
      login: { type: "string" },
      password: { type: "string" },
      keys: { type: "string" },
    },
    allowPositionals: true,
  })

  const io = d.io
  const cfg = await loadConfig(d.paths.configFile)

  // keys -------------------------------------------------------------------
  let keySpec = values.keys
  if (keySpec === undefined && d.io.isTTY) {
    keySpec = await io.prompt("UFR API keys (comma-separated or one per line; Open WebUI → Settings → Account → API keys): ")
  }
  const keys = splitKeys(keySpec ?? "")
  if (keys.length === 0) {
    io.err("no keys given — usage: ufr connect [--login <user> --password <pass>] --keys \"<key1>,<key2>\"\n")
    return 2
  }
  const aliases = nextAliases(cfg.keys, keys.length)

  // --- login (optional) ------------------------------------------------------
  let user = values.login
  let pass = values.password
  if (user === undefined && d.io.isTTY) {
    user = (await io.prompt("Uni login for the built-in VPN, e.g. xx0000@uni-freiburg.de (empty to skip): ")).trim()
  }
  if (user) {
    if (!/^[^\s@]+@[^\s@]+$/.test(user)) {
      io.err(`"${user}" does not look like a uni login (expected e.g. xx0000@uni-freiburg.de)\n`)
      return 2
    }
    if (pass === undefined) {
      if (d.io.isTTY) pass = await io.prompt(`Uni password for ${user}: `, { secret: true })
      else {
        io.err("--password is required when --login is given non-interactively\n")
        return 2
      }
    }
    if (!pass) {
      io.err("no password entered\n")
      return 2
    }
  }

  // --- store everything -------------------------------------------------------
  let bad = 0
  for (let i = 0; i < keys.length; i++) {
    const alias = aliases[i]!
    const r = await storeKey(d, alias, keys[i]!)
    if (r.stored) io.out(`${alias}\t${LABEL[r.check]}\n`)
    else {
      bad++
      io.err(`${alias}\t${LABEL[r.check]} — not stored\n`)
    }
  }
  if (bad === keys.length) return 1

  if (user && pass) {
    await d.secrets.set(VPN_USER, user)
    await d.secrets.set(VPN_PASS, pass)
    io.out(`login\tstored for ${user} (used by the built-in VPN)\n`)
  }

  await stopIdleGateway(d)
  if (d.io.isTTY) {
    if (await io.confirm(`register the plugin with opencode now (\`opencode plugin add ${PLUGIN_SPEC}\`)?`)) {
      const code = await d.runOpencode(["plugin", "add", PLUGIN_SPEC])
      if (code !== 0) io.err(`opencode plugin add exited with ${code} — add "${PLUGIN_SPEC}" to "plugins" in opencode.json yourself\n`)
    }
  } else {
    io.out(`register the provider in opencode if not done yet: opencode plugin add ${PLUGIN_SPEC}\n`)
  }
  io.out(`done — ${keys.length - bad}/${keys.length} key(s) stored${user ? ", uni login stored" : ""}\n`)
  return bad > 0 ? 1 : 0
}
