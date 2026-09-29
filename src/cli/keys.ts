import { ALIAS_RE, loadConfig, saveConfig } from "../shared/config"
import { daemonRequest } from "./daemon-client"
import type { CliDeps } from "./index"
import { type Check, checkKey } from "./ufr-check"

const LABEL: Record<Check | "missing", string> = {
  ok: "ok",
  invalid: "INVALID (UFR says 401)",
  vpn: "cannot check — not on the uni VPN",
  unreachable: "cannot check — UFR unreachable",
  rate_limited: "ok (currently rate-limited)",
  missing: "MISSING in keyring",
}

/** Prompts for, verifies and stores one key. Does not touch a running gateway — see applyKeyChange. */
export async function addKey(d: CliDeps, alias: string | undefined): Promise<number> {
  if (!alias || !ALIAS_RE.test(alias)) {
    d.io.err("usage: ufr keys add <alias>   (letters, digits, . _ -, max 32)\n")
    return 2
  }
  const cfg = await loadConfig(d.paths.configFile)
  const key = (await d.io.prompt(`UFR API key for "${alias}" (Open WebUI → Settings → Account → API keys): `, { secret: true })).trim()
  if (!key) {
    d.io.err("no key entered\n")
    return 2
  }
  const check = await checkKey(d.fetch, cfg.upstream.baseUrl, key)
  if (check === "invalid") {
    d.io.err("UFR rejected this key (401) — not stored\n")
    return 1
  }
  if (check !== "ok" && check !== "rate_limited") {
    const why = check === "vpn" ? "not on the uni VPN" : "UFR unreachable"
    if (!(await d.io.confirm(`could not verify the key (${why}). Store it anyway?`))) return 1
  }
  await d.secrets.set(alias, key)
  if (!cfg.keys.includes(alias)) {
    cfg.keys.push(alias)
    await saveConfig(d.paths.configFile, cfg)
  }
  d.io.out(`stored key "${alias}" in the OS keyring${check === "ok" ? " (verified)" : ""}.\n`)
  return 0
}

/** A running gateway read its keys at start: stop it while idle so opencode starts it with the new set. */
export async function applyKeyChange(d: CliDeps): Promise<void> {
  const res = await daemonRequest(d.paths, d.fetch, "/v1/_status")
  if (!res?.ok) return // not running — it reads the keys when opencode next starts it
  const { inFlight } = (await res.json()) as { inFlight?: number }
  if (inFlight !== 0) {
    d.io.out("the gateway is answering a request right now — run `ufr stop` later so it picks up the new keys\n")
    return
  }
  const stopped = await daemonRequest(d.paths, d.fetch, "/v1/_shutdown", "POST")
  d.io.out(stopped?.ok ? "gateway stopped — it restarts with the new keys when opencode next needs it\n"
    : "could not stop the gateway — run `ufr stop` so it picks up the new keys\n")
}

export async function cmdKeys(d: CliDeps, args: string[]): Promise<number> {
  const [sub, alias] = args
  if (sub === "add") {
    const code = await addKey(d, alias)
    if (code === 0) await applyKeyChange(d)
    return code
  }
  const cfg = await loadConfig(d.paths.configFile)
  switch (sub) {
    case "list": {
      if (cfg.keys.length === 0) {
        d.io.out("no keys — add one with `ufr keys add <alias>`\n")
        return 0
      }
      for (const a of cfg.keys) d.io.out(`${a}\t${(await d.secrets.get(a)) ? "stored" : LABEL.missing}\n`)
      return 0
    }
    case "remove": {
      if (!alias) {
        d.io.err("usage: ufr keys remove <alias>\n")
        return 2
      }
      await d.secrets.delete(alias)
      const had = cfg.keys.includes(alias)
      cfg.keys = cfg.keys.filter((k) => k !== alias)
      await saveConfig(d.paths.configFile, cfg)
      d.io.out(`removed "${alias}"\n`)
      if (had) await applyKeyChange(d)
      return 0
    }
    case "test": {
      let bad = 0
      for (const a of alias ? [alias] : cfg.keys) {
        const key = await d.secrets.get(a)
        const r: Check | "missing" = key ? await checkKey(d.fetch, cfg.upstream.baseUrl, key) : "missing"
        if (r !== "ok" && r !== "rate_limited") bad++
        d.io.out(`${a}\t${LABEL[r]}\n`)
      }
      return bad ? 1 : 0
    }
    default:
      d.io.err("usage: ufr keys add <alias> | list | remove <alias> | test [alias]\n")
      return 2
  }
}
