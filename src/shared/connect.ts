/**
 * Shared connect logic: parsing key lists and applying credentials to the
 * keyring + config. Used by the CLI (`ufr connect`) and by the plugin's
 * /connect integration watcher.
 */

import { loadConfig, saveConfig } from "./config"
import type { Paths } from "./paths"
import type { SecretStore } from "./secrets"
import { VPN_PASS, VPN_USER } from "./secrets"

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

export const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

export type ConnectInput = {
  keys: string // comma/newline separated, whitespace filtered
  login?: string // optional uni login (built-in VPN)
  password?: string
}

export type ConnectApplied = {
  aliases: { alias: string; key: string }[]
  removedAliases: string[]
  loginStored: boolean
  /** False when the submission was byte-identical to what is already stored — no gateway restart needed. */
  changed: boolean
  errors: string[]
}

/**
 * Applies a /connect submission: stores the keys as key1…keyN in the keyring
 * (replacing previous key* aliases), optionally the uni login, and updates
 * config.keys. Custom (non-key*) aliases are left untouched.
 */
export async function applyConnect(
  input: ConnectInput,
  o: { paths: Paths; secrets: SecretStore; log?: (m: string) => void },
): Promise<ConnectApplied> {
  const log = o.log ?? (() => {})
  const errors: string[] = []
  const keys = splitKeys(input.keys)
  if (keys.length === 0) {
    errors.push("no keys given")
    return { aliases: [], removedAliases: [], loginStored: false, changed: false, errors }
  }
  if (input.login && !EMAIL_RE.test(input.login.trim())) {
    errors.push(`"${input.login}" does not look like a uni login`)
    return { aliases: [], removedAliases: [], loginStored: false, changed: false, errors }
  }

  const cfg = await loadConfig(o.paths.configFile)
  const custom = cfg.keys.filter((k) => !/^key\d+$/.test(k))
  const beforeKeys = cfg.keys.join("\n")

  // replace the managed key1…keyN aliases
  const removedAliases: string[] = []
  const wanted = nextAliases(custom, keys.length)
  for (const alias of cfg.keys) {
    if (/^key\d+$/.test(alias) && !wanted.includes(alias)) {
      await o.secrets.delete(alias)
      removedAliases.push(alias)
    }
  }
  const aliases: { alias: string; key: string }[] = []
  let changed = beforeKeys !== [...custom, ...wanted].join("\n") || removedAliases.length > 0
  for (let i = 0; i < keys.length; i++) {
    const alias = wanted[i]!
    if ((await o.secrets.get(alias)) !== keys[i]!) changed = true
    await o.secrets.set(alias, keys[i]!)
    aliases.push({ alias, key: keys[i]! })
  }

  let loginStored = false
  if (input.login?.trim()) {
    const login = input.login.trim()
    if ((await o.secrets.get(VPN_USER)) !== login || (input.password && (await o.secrets.get(VPN_PASS)) !== input.password)) {
      changed = true
    }
    await o.secrets.set(VPN_USER, login)
    if (input.password) await o.secrets.set(VPN_PASS, input.password)
    loginStored = true
  }

  cfg.keys = [...custom, ...wanted]
  await saveConfig(o.paths.configFile, cfg)
  log(`connect applied: ${aliases.length} key(s), login ${loginStored ? "stored" : "unchanged"}`)
  return { aliases, removedAliases, loginStored, changed, errors }
}
