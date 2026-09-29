import { fileURLToPath } from "node:url"
import type { OpencodeStamp } from "../daemon/catalog"
import { type Paths, resolvePaths } from "../shared/paths"
import { VERSION } from "../shared/version"
import { type Conn, ensureDaemon, spawnDaemon } from "./ensure-daemon"
import { toModelInfo } from "./model-info"

const DAEMON_ENTRY = fileURLToPath(new URL("../daemon/main.ts", import.meta.url))

function log(msg: string): void {
  console.warn(`[opencode-ufr] ${msg}`)
}

async function connect(paths: Paths): Promise<Conn> {
  return ensureDaemon({ paths, version: VERSION, spawn: () => spawnDaemon(DAEMON_ENTRY, paths.stateDir) })
}

async function heartbeat(conn: Conn, paths: Paths): Promise<void> {
  const ok = await fetch(`http://127.0.0.1:${conn.port}/v1/_client/heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${conn.token}` },
    signal: AbortSignal.timeout(5_000),
  })
    .then((r) => r.ok)
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

    let conn: Conn
    try {
      conn = await connect(paths)
    } catch (e) {
      log(`${(e as Error).message} — run \`ufr status\``)
      return
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
      return
    }
    if (typeof ctx?.provider?.transform !== "function") {
      log("this opencode version has no ctx.provider.transform — cannot register the provider")
      return
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
    const beat = setInterval(() => void heartbeat(conn, paths), 60_000)
    ;(beat as { unref?: () => void }).unref?.()
    return () => clearInterval(beat)
  },
}
