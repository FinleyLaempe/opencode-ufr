import { resolvePaths } from "../shared/paths"
import { KeyringStore } from "../shared/secrets"
import { AlreadyRunningError, startDaemon } from "./daemon"
import { createLogger } from "./log"

const paths = resolvePaths()
const log = createLogger(paths.logFile)
try {
  const d = await startDaemon({ paths, secrets: new KeyringStore(), log, onStopped: () => process.exit(0) })
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void d.stop())
} catch (e) {
  if (e instanceof AlreadyRunningError) {
    log("another daemon is already running — exiting")
    process.exit(0)
  }
  log(`fatal: ${(e as Error).message}`)
  process.exit(1)
}
