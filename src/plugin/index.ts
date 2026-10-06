import { fileURLToPath } from "node:url"
import type { OpencodeStamp } from "../daemon/catalog"
import { daemonRequest } from "../shared/daemon-client"
import { disconnectAll } from "../shared/keys"
import { type Paths, resolvePaths } from "../shared/paths"
import { KeyringStore, type SecretStore } from "../shared/secrets"
import { VERSION } from "../shared/version"
import { type Conn, ensureDaemon, spawnDaemon } from "./ensure-daemon"
import { registerConnect, UFR_INTEGRATION_ID } from "./connect"
import { toModelInfo } from "./model-info"

const DAEMON_ENTRY = fileURLToPath(new URL("../daemon/main.ts", import.meta.url))
const PDF2MD_SCRIPT = fileURLToPath(new URL("../client/pdf2md.ts", import.meta.url))
const PDF2MD_SKILL = fileURLToPath(new URL("../../skills/pdf2md/SKILL.md", import.meta.url))

/**
 * Registers the pdf2md skill with opencode (V2 plugins can add skills via a
 * transform). The SKILL.md ships with the package; the script path is baked in
 * at registration time because it depends on where npm cached the package.
 */
async function registerSkill(ctx: any): Promise<void> {
  if (typeof ctx?.skill?.transform !== "function") return // older opencode — no skills
  try {
    const raw = await Bun.file(PDF2MD_SKILL).text()
    const content = raw.replace("{{PDF2MD_SCRIPT}}", PDF2MD_SCRIPT)
    await ctx.skill.transform((editor: any) => {
      editor.add({
        id: "ufr-pdf2md",
        name: "PDF to Markdown",
        description:
          "Convert a PDF to clean Markdown using UFR vision models — OCR with tables, math, circuit diagrams, refinement and cross-page table merging, all rate-limit-safe through the local gateway.",
        path: PDF2MD_SKILL,
        content,
      })
    })
    log("registered skill ufr-pdf2md")
  } catch (e) {
    log(`skill registration failed: ${(e as Error).message}`)
  }
}

// opencode takes a request's key from the provider's integration (default: the one with the provider's
// id), and a key credential there replaces settings.apiKey. The /connect credential on "unifreiburg"
// holds the UFR keys, not the gateway token — so link the provider to an integration with no credential.
const GATEWAY_INTEGRATION_ID = "opencode-ufr-gateway"

function log(msg: string): void {
  console.warn(`[opencode-ufr] ${msg}`)
}

async function connect(paths: Paths): Promise<Conn> {
  return ensureDaemon({
    paths,
    version: VERSION,
    spawn: (onError) => spawnDaemon(DAEMON_ENTRY, paths.stateDir, onError),
  })
}

/** Whether this opencode exposes the integration API (needed to see connection state). */
function hasIntegration(ctx: any): boolean {
  return typeof ctx?.integration?.connection?.active === "function"
}

/** Starts the daemon if needed, fetches its models and registers the provider with opencode. */
async function registerProvider(
  ctx: any,
  providerId: string,
  providerName: string,
  paths: Paths,
): Promise<boolean> {
  let conn: Conn
  try {
    conn = await connect(paths)
  } catch (e) {
    log(`${(e as Error).message} — see daemon.log in the opencode-ufr state directory`)
    return false
  }
  const list = await fetch(`http://127.0.0.1:${conn.port}/v1/models`, {
    headers: { Authorization: `Bearer ${conn.token}` },
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (r) => (r.ok ? ((await r.json()) as { data: { id: string; opencode: OpencodeStamp }[] }).data : null))
    .catch(() => null)
  if (list === null) {
    log("gateway unreachable — retrying")
    return false
  }
  if (list.length === 0) {
    // Never register an empty provider: it breaks the whole model picker.
    log("no models available — connect to the uni VPN off campus, then restart opencode")
    return false
  }
  if (typeof ctx?.provider?.transform !== "function") {
    log("this opencode version has no ctx.provider.transform — cannot register the provider")
    return false
  }
  const models = list.map((m) => toModelInfo(providerId, m.id, m.opencode))
  await ctx.provider.transform((editor: any) => {
    editor.add({
      info: {
        id: providerId,
        name: providerName,
        integrationID: GATEWAY_INTEGRATION_ID,
        activation: "enabled",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL: `http://127.0.0.1:${conn.port}/v1`, apiKey: conn.token },
      },
      models,
    })
  })
  log(`registered ${providerId} with ${models.length} models`)
  return true
}

/**
 * Keeps the daemon alive while the provider is connected. When the connection
 * was removed in opencode, the daemon must stay down — the watcher wipes the
 * keys and opencode no longer offers the provider.
 */
export async function heartbeat(ctx: any, paths: Paths): Promise<void> {
  if (hasIntegration(ctx)) {
    const active = await ctx.integration.connection.active(UFR_INTEGRATION_ID).catch(() => undefined)
    if (!active) return
  }
  const ok = await daemonRequest(paths, (u, i) => fetch(u, i), "/v1/_client/heartbeat", "POST")
    .then((r) => r?.ok ?? false)
    .catch(() => false)
  // Port and token are stable, so a restarted daemon serves the provider we already registered.
  if (!ok) await connect(paths).catch((e) => log(`gateway restart failed: ${(e as Error).message}`))
}

/**
 * The plugin entry point. `inject.secrets` exists for tests only — production
 * always uses the OS keyring.
 */
export async function setupPlugin(ctx: any, inject: { secrets?: SecretStore } = {}): Promise<() => void> {
  const options = (ctx?.options ?? {}) as Record<string, unknown>
  const providerId = typeof options.providerId === "string" ? options.providerId : "unifreiburg"
  const providerName = typeof options.providerName === "string" ? options.providerName : "Uni Freiburg"
  const paths = resolvePaths()
  const secrets = inject.secrets ?? new KeyringStore()

  let registered = false
  const registerProviderFn = async (): Promise<boolean> => {
    if (registered) return true
    registered = await registerProvider(ctx, providerId, providerName, paths)
    return registered
  }

  // /connect integration first: it is the only way to connect when no
  // provider is registered yet, so it must exist even while disconnected.
  const stopConnect = await registerConnect({
    ctx,
    paths,
    secrets,
    log,
    register: registerProviderFn,
    providerRegistered: false,
  }).catch((e) => {
    log(`/connect integration failed: ${(e as Error).message}`)
    return { stop: () => {}, applyNow: async () => false }
  })

  // The provider is registered only while the integration is connected:
  // removing it in opencode must remove the models too.
  if (!hasIntegration(ctx)) {
    await registerProviderFn() // old opencode without the integration API — register as before
  } else {
    const connection = await ctx.integration.connection.active(UFR_INTEGRATION_ID).catch(() => undefined)
    if (connection) {
      // Registering can block ~80 s (daemon boot + watcher retries) — never
      // stall opencode startup: run the first registration in the background;
      // the /connect watcher (polling every few seconds) completes it if needed.
      log("unifreiburg connected — registering the provider in the background")
      void registerProviderFn().catch((e) => log(`provider registration failed: ${(e as Error).message}`))
    } else {
      // A removal while opencode was closed leaves the keyring untouched (the
      // watcher only sees the transition while opencode runs) — wipe it here.
      // A failing loadConfig (a broken config.json) must not reject setupPlugin:
      // the plugin still has to load so /connect can repair the setup.
      const r = await disconnectAll({ paths, secrets, fetch: (u, i) => fetch(u, i), log }).catch((e) => {
        log(`cleanup of the removed connection failed: ${(e as Error).message}`)
        return { removed: [], loginRemoved: false }
      })
      if (r.removed.length > 0 || r.loginRemoved) {
        log(`unifreiburg was removed in opencode — wiped what was left: ${r.removed.join(", ")}${r.loginRemoved ? " + uni login" : ""}`)
      }
      log(`${providerId} not connected — open /connect in opencode to set it up`)
    }
  }

  // The pdf2md skill is independent of the connection state — register it always.
  await registerSkill(ctx)

  // One heartbeat at a time: a slow one (daemon boot) must not pile up or race the /connect watcher.
  let beating = false
  const beat = setInterval(() => {
    if (beating) return
    beating = true
    void heartbeat(ctx, paths).finally(() => {
      beating = false
    })
  }, 60_000)
  ;(beat as { unref?: () => void }).unref?.()
  return () => {
    clearInterval(beat)
    stopConnect.stop()
  }
}

export default {
  id: "opencode-ufr",
  async setup(ctx: any) {
    return setupPlugin(ctx)
  },
}
