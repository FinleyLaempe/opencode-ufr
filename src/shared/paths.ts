import { homedir } from "node:os"
import { join } from "node:path"

export type Paths = {
  configDir: string
  stateDir: string
  cacheDir: string
  dataDir: string
  configFile: string
  daemonFile: string
  tokenFile: string
  lockFile: string
  logFile: string
  statsDb: string
  modelsCache: string
  modelsEtag: string
  ufrModelsCache: string
}

const APP = "opencode-ufr"

export function resolvePaths(
  env: Record<string, string | undefined> = process.env,
  platform: string = process.platform,
  home: string = homedir(),
): Paths {
  let configDir: string, stateDir: string, cacheDir: string, dataDir: string
  if (env.OPENCODE_UFR_HOME) {
    const base = env.OPENCODE_UFR_HOME
    configDir = join(base, "config")
    stateDir = join(base, "state")
    cacheDir = join(base, "cache")
    dataDir = join(base, "data")
  } else if (platform === "win32") {
    const roaming = env.APPDATA ?? join(home, "AppData", "Roaming")
    const local = env.LOCALAPPDATA ?? join(home, "AppData", "Local")
    configDir = join(roaming, APP)
    stateDir = join(local, APP, "state")
    cacheDir = join(local, APP, "cache")
    dataDir = join(local, APP, "data")
  } else {
    configDir = join(env.XDG_CONFIG_HOME ?? join(home, ".config"), APP)
    stateDir = join(env.XDG_STATE_HOME ?? join(home, ".local", "state"), APP)
    cacheDir = join(env.XDG_CACHE_HOME ?? join(home, ".cache"), APP)
    dataDir = join(env.XDG_DATA_HOME ?? join(home, ".local", "share"), APP)
  }
  return {
    configDir,
    stateDir,
    cacheDir,
    dataDir,
    configFile: join(configDir, "config.json"),
    daemonFile: join(stateDir, "daemon.json"),
    tokenFile: join(stateDir, "token"),
    lockFile: join(stateDir, "daemon.lock"),
    logFile: join(stateDir, "daemon.log"),
    statsDb: join(dataDir, "stats.db"),
    modelsCache: join(cacheDir, "models.json"),
    modelsEtag: join(cacheDir, "models.etag"),
    ufrModelsCache: join(cacheDir, "ufr-models.json"),
  }
}
