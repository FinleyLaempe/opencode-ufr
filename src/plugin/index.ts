import { fileURLToPath } from "node:url"
import type { OpencodeStamp } from "../daemon/catalog"
import { daemonRequest } from "../cli/daemon-client"
import { type Paths, resolvePaths } from "../shared/paths"
import { KeyringStore } from "../shared/secrets"
import { VERSION } from "../shared/version"
import { type Conn, ensureDaemon, spawnDaemon } from "./ensure-daemon"
import { registerConnect, UFR_INTEGRATION_ID } from "./connect"
import { toModelInfo } from "./model-info"

const DAEMON_ENTRY = fileURLToPath(new URL("../daemon/main.ts", import.meta.url))

function log(msg: string): void {
  console.warn(`[opencode-ufr] ${msg}`)
}

async function connect(paths: Paths): Promise<Conn> {
  return ensureDaemon({ paths, version: VERSION, spawn: () => spawnDaemon(DAEMON_ENTRY, paths.stateDir) })
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
    log(`${(e as Error).message} — run \`ufr status\``)
    return false
  }
  const list = await fetch(`http://127.0.0.1:${conn.port}/v1/models`, {
    headers: { Authorization: `Bearer ${conn.token}` },
    signal: AbortSignal.timeout(10_000),
  })
    .then(async (r) => (r.ok ? ((await r.json()) as { data: { id: string; opencode: OpencodeStamp }[] }).data : []))
    .catch(() => [])
  if (list.length === 0) {
    // Never register an empty provider: it breaks the whole model picker.
    log("no models available — run `ufr setup`, connect to the uni VPN, then `ufr status` for details")
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

export default {
  id: "opencode-ufr",
  async setup(ctx: any) {
    const options = (ctx?.options ?? {}) as Record<string, unknown>
    const providerId = typeof options.providerId === "string" ? options.providerId : "unifreiburg"
    const providerName = typeof options.providerName === "string" ? options.providerName : "Uni Freiburg"
    const paths = resolvePaths()

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
      secrets: new KeyringStore(),
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
      if (connection) await registerProviderFn()
      else log(`${providerId} not connected — open /connect in opencode to set it up`)
    }

    const beat = setInterval(() => void heartbeat(ctx, paths), 60_000)
    ;(beat as { unref?: () => void }).unref?.()
    return () => {
      clearInterval(beat)
      stopConnect.stop()
    }
  },
}
