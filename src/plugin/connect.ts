/**
 * The /connect integration: opencode's built-in provider-connect panel lists
 * the "unifreiburg" integration; this plugin replaces its key method with one
 * that shows the optional uni-login form (login + password) alongside the API
 * key(s). When the user submits, opencode stores a Credential with the form
 * answers; this module watches for it and applies it to the keyring + config,
 * then restarts the gateway so the keys go live.
 */

import { applyConnect, splitKeys } from "../shared/connect"
import type { Paths } from "../shared/paths"
import { applyKeyChange } from "../cli/keys"

export const UFR_INTEGRATION_ID = "unifreiburg"

export type ConnectDeps = {
  ctx: any // opencode plugin context (integration + storage domains)
  paths: Paths
  secrets: { get(alias: string): Promise<string | null>; set(alias: string, value: string): Promise<void>; delete(alias: string): Promise<boolean> }
  log: (m: string) => void
}

type CredentialValue = { type?: string; key?: string; configuration?: Record<string, unknown> } | undefined

/** Normalizes one opencode credential into a ConnectInput. */
export function credentialToInput(cred: CredentialValue): { keys: string; login?: string; password?: string } | null {
  if (!cred || cred.type && cred.type !== "key") return null
  const cfg = (cred.configuration ?? {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "")
  const keys = str(cred.key) || str(cfg.keys)
  if (!keys) return null
  return {
    keys,
    login: str(cfg.login) || undefined,
    password: str(cfg.password) || undefined,
  }
}

export type ConnectRegistration = { stop: () => void; applyNow: () => Promise<boolean> }

export async function registerConnect(d: ConnectDeps): Promise<ConnectRegistration> {
  const { ctx } = d
  if (typeof ctx?.integration?.transform !== "function") {
    d.log("this opencode version has no integration API — /connect stays as configured elsewhere")
    return { stop: () => {}, applyNow: async () => false }
  }

  // Replace the key method of the unifreiburg integration with ours: the
  // standard API-key(s) prompt plus the optional uni-login form.
  await ctx.integration.transform((editor: any) => {
    if (typeof editor?.method?.update !== "function") return
    editor.method.update({
      integrationID: UFR_INTEGRATION_ID,
      method: {
        type: "key",
        label: "API keys (comma-separated) + optional uni login",
        form: [
          {
            key: "login",
            title: "Uni login (optional)",
            type: "string",
            placeholder: "fl240@uni-freiburg.de",
            description: "Only needed off campus — the built-in VPN uses it. Leave empty on the uni network.",
          },
          {
            key: "password",
            title: "Uni password (optional)",
            type: "string",
            description: "Stored in the OS keyring, never on disk. Only with a login above.",
          },
        ],
      },
    })
  })

  // Apply a submitted credential once, then watch for changes.
  let lastApplied = ""
  const applyOnce = async (): Promise<boolean> => {
    try {
      const connection = await ctx.integration.connection.active(UFR_INTEGRATION_ID)
      if (!connection) return false
      const cred = (await ctx.integration.connection.resolve(connection)) as CredentialValue
      const sig = JSON.stringify(cred?.configuration ?? {}) + "|" + (cred?.key ?? "")
      if (sig === lastApplied) return false
      lastApplied = sig
      const input = credentialToInput(cred)
      if (!input) {
        d.log("/connect credential has no keys — nothing applied")
        return false
      }
      const r = await applyConnect(input, { paths: d.paths, secrets: d.secrets, log: d.log })
      if (r.errors.length > 0) {
        for (const e of r.errors) d.log(`/connect: ${e}`)
        return false
      }
      await applyKeyChange({ paths: d.paths, fetch: (u, i) => fetch(u, i), log: d.log })
      return true
    } catch (e) {
      d.log(`/connect apply failed: ${(e as Error).message}`)
      return false
    }
  }

  await applyOnce()
  const timer = setInterval(() => void applyOnce(), 60_000)
  ;(timer as { unref?: () => void }).unref?.()
  return {
    stop: () => clearInterval(timer),
    applyNow: applyOnce,
  }
}

export { splitKeys }
