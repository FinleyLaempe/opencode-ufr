import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type DaemonOptions, type RunningDaemon, startDaemon } from "../../src/daemon/daemon"
import { mergeConfig, saveConfig } from "../../src/shared/config"
import { resolvePaths } from "../../src/shared/paths"
import { MemoryStore } from "../../src/shared/secrets"
import { FakeUfr } from "./fake-ufr"
import { TEST_MODELS_FILE } from "./models"

/** An isolated home (OPENCODE_UFR_HOME layout), a fake UFR and a way to start daemons in-process. */
export async function daemonEnv(o: { keys?: Record<string, string>; config?: Record<string, unknown> } = {}) {
  const home = await mkdtemp(join(tmpdir(), "ufr-home-"))
  const paths = resolvePaths({ OPENCODE_UFR_HOME: home })
  const ufr = FakeUfr.start()
  const keys = o.keys ?? { main: "key-a", alt: "key-b" }
  const secrets = new MemoryStore()
  for (const [alias, value] of Object.entries(keys)) await secrets.set(alias, value)
  const bundled = join(home, "bundled-models.json")
  await Bun.write(bundled, JSON.stringify(TEST_MODELS_FILE))
  await saveConfig(
    paths.configFile,
    mergeConfig({
      keys: Object.keys(keys),
      upstream: { baseUrl: ufr.baseUrl },
      catalog: { url: `${ufr.baseUrl}/no-such-models.json` },
      ...o.config,
    }),
  )
  const running: RunningDaemon[] = []
  const start = async (extra: Partial<DaemonOptions> = {}) => {
    const d = await startDaemon({ paths, secrets, bundledModelsPath: bundled, port: 0, exitOnIdle: false, probes: false, log: () => {}, ...extra })
    running.push(d)
    return d
  }
  const api = (d: RunningDaemon, path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${d.port}${path}`, { ...init, headers: { Authorization: `Bearer ${d.token}`, "Content-Type": "application/json" } })
  const cleanup = async () => {
    for (const d of running) await d.stop()
    ufr.stop()
    await rm(home, { recursive: true, force: true })
  }
  return { home, paths, ufr, secrets, bundled, start, api, cleanup }
}
