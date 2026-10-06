/**
 * Key lifecycle used by the plugin's /connect watcher: applying a key change
 * to a running gateway and wiping everything on provider removal.
 */

import type { FetchLike } from "../daemon/catalog-source"
import { daemonRequest } from "./daemon-client"
import { loadConfig, saveConfig } from "./config"
import type { Paths } from "./paths"
import { VPN_PASS, VPN_USER, type SecretStore } from "./secrets"

/** A running gateway read its keys at start: stop it while idle so opencode starts it with the new set. */
export async function applyKeyChange(d: { paths: Paths; fetch: FetchLike; log: (m: string) => void }): Promise<void> {
  const res = await daemonRequest(d.paths, d.fetch, "/v1/_status")
  if (!res?.ok) return // not running — it reads the keys when opencode next starts it
  const j = (await res.json().catch(() => null)) as { inFlight?: unknown } | null
  const inFlight = j !== null && typeof j.inFlight === "number" ? j.inFlight : null
  if (inFlight === null) {
    d.log("couldn't read gateway state — not stopping")
    return
  }
  if (inFlight !== 0) {
    d.log("the gateway is answering a request right now — it picks up the new keys on its next restart")
    return
  }
  const stopped = await daemonRequest(d.paths, d.fetch, "/v1/_shutdown", "POST")
  d.log(stopped?.ok ? "gateway stopped — it restarts with the new keys when opencode next needs it"
    : "could not stop the gateway — it picks up the new keys on its next restart")
}

export type DisconnectResult = { removed: string[]; loginRemoved: boolean }

/** Managed aliases key1…keyN are swept up to this n: a crash between secrets.set and saveConfig can orphan higher numbers than the current config lists. */
const MANAGED_SWEEP = 32

/**
 * Provider-removal cleanup: delete every stored key alias and the uni login
 * from the keyring, clear config.keys, and stop an idle gateway (it reads its
 * keys at start, so a later start serves nothing). Idempotent.
 */
export async function disconnectAll(d: {
  paths: Paths
  secrets: SecretStore
  fetch: FetchLike
  log: (m: string) => void
}): Promise<DisconnectResult> {
  const cfg = await loadConfig(d.paths.configFile)
  const removed: string[] = []
  for (const alias of cfg.keys) {
    if (await d.secrets.delete(alias)) removed.push(alias)
  }
  // Also sweep managed names the config may no longer list (a crash between
  // secrets.set and saveConfig) — deletions of absent names report false.
  for (let n = 1; n <= MANAGED_SWEEP; n++) {
    const alias = `key${n}`
    if (!cfg.keys.includes(alias) && (await d.secrets.delete(alias))) removed.push(alias)
  }
  const userRemoved = await d.secrets.delete(VPN_USER)
  const passRemoved = await d.secrets.delete(VPN_PASS)
  const loginRemoved = userRemoved || passRemoved
  cfg.keys = []
  await saveConfig(d.paths.configFile, cfg)
  await applyKeyChange(d)
  return { removed, loginRemoved }
}
