import { loadConfig, saveConfig } from "../shared/config"
import type { Paths } from "../shared/paths"
import { VPN_PASS, VPN_USER } from "../shared/secrets"
import { daemonRequest } from "./daemon-client"
import type { FetchLike } from "../daemon/catalog-source"
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

/** A running gateway read its keys at start: stop it while idle so opencode starts it with the new set. */
export async function applyKeyChange(d: { paths: Paths; fetch: FetchLike; log: (m: string) => void }): Promise<void> {
  const res = await daemonRequest(d.paths, d.fetch, "/v1/_status")
  if (!res?.ok) return // not running — it reads the keys when opencode next starts it
  const { inFlight } = (await res.json()) as { inFlight?: number }
  if (inFlight !== 0) {
    d.log("the gateway is answering a request right now — run `ufr stop` later so it picks up the new keys")
    return
  }
  const stopped = await daemonRequest(d.paths, d.fetch, "/v1/_shutdown", "POST")
  d.log(stopped?.ok ? "gateway stopped — it restarts with the new keys when opencode next needs it"
    : "could not stop the gateway — run `ufr stop` so it picks up the new keys")
}

export async function cmdKeys(d: CliDeps, args: string[]): Promise<number> {
  const [sub, ...rest] = args
  const cfg = await loadConfig(d.paths.configFile)
  switch (sub) {
    case "list": {
      if (cfg.keys.length === 0) {
        d.io.out("no keys — add them with `ufr connect`\n")
        return 0
      }
      for (const a of cfg.keys) d.io.out(`${a}\t${(await d.secrets.get(a)) ? "stored" : LABEL.missing}\n`)
      return 0
    }
    case "remove": {
      const alias = rest[0]
      if (!alias) {
        d.io.err("usage: ufr keys remove <alias>\n")
        return 2
      }
      await d.secrets.delete(alias)
      const had = cfg.keys.includes(alias)
      cfg.keys = cfg.keys.filter((k) => k !== alias)
      await saveConfig(d.paths.configFile, cfg)
      d.io.out(`removed "${alias}"\n`)
      if (had) await applyKeyChange({ paths: d.paths, fetch: d.fetch, log: (m) => d.io.out(m + "\n") })
      return 0
    }
    case "test": {
      let bad = 0
      for (const a of rest[0] ? [rest[0]] : cfg.keys) {
        const key = await d.secrets.get(a)
        const r: Check | "missing" = key ? await checkKey(d.fetch, cfg.upstream.baseUrl, key) : "missing"
        if (r !== "ok" && r !== "rate_limited") bad++
        d.io.out(`${a}\t${LABEL[r]}\n`)
      }
      return bad ? 1 : 0
    }
    default:
      d.io.err("usage: ufr keys list | remove <alias> | test [alias]\n")
      return 2
  }
}

/** ufr login — inspect or remove the stored uni login (set it with `ufr connect`). */
export async function cmdLogin(d: CliDeps, args: string[]): Promise<number> {
  const [sub] = args
  if (sub === "remove") {
    await d.secrets.delete(VPN_USER)
    await d.secrets.delete(VPN_PASS)
    d.io.out("removed the stored uni login\n")
    return 0
  }
  if (sub === "show" || sub === undefined) {
    const u = await d.secrets.get(VPN_USER)
    const p = await d.secrets.get(VPN_PASS)
    if (!u) {
      d.io.out("no uni login stored — set it with `ufr connect --login <user> --password <pass> --keys …`\n")
      return 1
    }
    d.io.out(`${u}\tpassword ${p ? "stored" : "MISSING in keyring"}\n`)
    return p ? 0 : 1
  }
  d.io.err("usage: ufr login show | remove\n")
  return 2
}
