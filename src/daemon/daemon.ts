import { randomBytes } from "node:crypto"
import { mkdir, open, rm, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { loadConfig, saveConfig } from "../shared/config"
import { readJson, readText, writeFileAtomic } from "../shared/fs"
import type { Paths } from "../shared/paths"
import type { SecretStore } from "../shared/secrets"
import { VPN_PASS, VPN_USER } from "../shared/secrets"
import { sleep } from "../shared/sleep"
import { startOfLocalDay } from "../shared/time"
import { VERSION } from "../shared/version"
import { type BreakerState, BreakerRegistry } from "./breaker"
import { type Catalog, EMPTY_CATALOG, buildCatalog, listModels } from "./catalog"
import { type FetchLike, type ModelsSource, loadBundledModels, loadUfrModels } from "./catalog-source"
import type { ModelsFile } from "../shared/models-file"
import { type KeyInfo, KeyPool, type KeySnapshot } from "./keypool"
import { loadProbes, probeContextLimit, saveProbe } from "./probe"
import { type UfrModel } from "./catalog"
import { Router } from "./router"
import { startServer } from "./server"
import { Stats } from "./stats"
import { createTransport } from "./transport"
import { VpnManager } from "./vpn/manager"
import { SlidingWindow } from "./window"

export class AlreadyRunningError extends Error {
  constructor() {
    super("another opencode-ufr daemon is already running")
  }
}

export type StatusJson = {
  version: string
  pid: number
  port: number
  uptimeMs: number
  inFlight: number
  now: number
  upstream: { ok: boolean | null; message: string; at: number }
  keys: KeySnapshot[]
  pool: ReturnType<SlidingWindow["snapshot"]>
  breakers: Record<string, { state: BreakerState; level: number; retryAfterMs: number }>
  catalog: { source: ModelsSource | "none"; ufrSource: "remote" | "cache" | "none"; loadedAt: number; models: number; warnings: string[] }
  vpn: { mode: string; detail: string } | null
  spendToday: Record<string, number>
  dailyBudgetUsd: number
}

export type DaemonOptions = {
  paths: Paths
  secrets: SecretStore
  fetch?: FetchLike
  bundledModelsPath?: string
  now?: () => number
  log?: (m: string) => void
  /** Fixed port (0 = ephemeral, tests). Default: config.port, else the first free port from preferredPort. */
  port?: number
  preferredPort?: number
  exitOnIdle?: boolean
  idleMs?: number
  idleCheckMs?: number
  /** Backoff after UFR's model list failed to load (VPN down, UFR unreachable); the last delay repeats. */
  catalogRetryMs?: number[]
  /** Auto-probe the context limit of unknown models (default: on). */
  probes?: boolean
  onStopped?: () => void
}

export type RunningDaemon = {
  port: number
  token: string
  router: Router
  status: () => StatusJson
  refreshCatalog: () => Promise<void>
  stop: () => Promise<void>
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Nonces this process has minted for locks it currently holds, keyed by lock file
 *  path so releaseLockNonce can forget the right one. Reserved before the lock
 *  file is even created, so a concurrent reader in this same process never sees
 *  committed lock content before its nonce is already known here. */
const heldNonces = new Set<string>()
const nonceByLock = new Map<string, string>()

export type AcquireLockOptions = {
  isAlive?: (pid: number) => boolean
  /** Asked only once a foreign live pid's lock is older than graceMs. */
  confirmDaemon?: (pid: number) => Promise<boolean>
  /** How long a foreign live pid's lock is trusted without confirmation (default 60 s). */
  graceMs?: number
}

/**
 * Exclusive-create lock. A lock is stale — and taken over — when: its content
 * is empty/unparseable and past the just-created window; it names our own pid
 * but a nonce we never issued (the pid was reused since we last held it); its
 * pid is dead; or its pid is foreign, live, past the grace period, and
 * confirmDaemon (when given) says no daemon answers there. A foreign live pid
 * we cannot confirm (no confirmDaemon given) is left alone, as before.
 */
export async function acquireLock(lockFile: string, o: AcquireLockOptions = {}): Promise<boolean> {
  const isAlive = o.isAlive ?? pidAlive
  const graceMs = o.graceMs ?? 60_000
  await mkdir(dirname(lockFile), { recursive: true })
  for (let attempt = 0; attempt < 2; attempt++) {
    const nonce = randomBytes(8).toString("hex")
    heldNonces.add(nonce)
    try {
      const fh = await open(lockFile, "wx")
      await fh.writeFile(`${process.pid} ${nonce}`)
      await fh.close()
      nonceByLock.set(lockFile, nonce)
      return true
    } catch (e) {
      heldNonces.delete(nonce)
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e
      const content = (await readText(lockFile))?.trim() ?? ""
      const [pidStr, existingNonce] = content.split(/\s+/)
      const pid = Number(pidStr)
      const st = await stat(lockFile).catch(() => null)
      const ageMs = st ? Date.now() - st.mtimeMs : Number.POSITIVE_INFINITY
      if (!Number.isInteger(pid) || pid <= 0) {
        if (ageMs < 10_000) return false // being created right now
      } else if (pid === process.pid) {
        if (existingNonce && heldNonces.has(existingNonce)) return false // held by this process
        // else: our own pid, but a nonce we never issued — the pid was reused
      } else if (!isAlive(pid)) {
        // dead pid — stale
      } else if (ageMs < graceMs) {
        return false // a daemon looks to be starting; give it the grace period
      } else if (o.confirmDaemon) {
        if (await o.confirmDaemon(pid)) return false
        // confirmDaemon found no daemon there — stale, take over
      } else {
        return false // no way to verify a foreign live pid — the old, conservative default
      }
      await rm(lockFile, { force: true })
    }
  }
  return false
}

/** Forgets the nonce for a lock this process released, so a later reuse of our
 *  own pid (containers, Windows) is never mistaken for a lock we still hold. */
export function releaseLockNonce(lockFile: string): void {
  const nonce = nonceByLock.get(lockFile)
  if (nonce) heldNonces.delete(nonce)
  nonceByLock.delete(lockFile)
}

/** The local token survives restarts so the provider opencode registered keeps working. */
export async function loadOrCreateToken(file: string): Promise<string> {
  const t = (await readText(file))?.trim()
  if (t && /^[0-9a-f]{64}$/.test(t)) return t
  const token = randomBytes(32).toString("hex")
  await writeFileAtomic(file, token + "\n", 0o600)
  return token
}

export async function startDaemon(o: DaemonOptions): Promise<RunningDaemon> {
  const now = o.now ?? Date.now
  const log = o.log ?? ((m: string) => console.error(`[opencode-ufr] ${m}`))
  const f: FetchLike = o.fetch ?? ((u, i) => fetch(u, i))
  const p = o.paths
  const config = await loadConfig(p.configFile)
  const confirmDaemon = async (pid: number): Promise<boolean> => {
    const saved = (await readJson(p.daemonFile)) as { pid?: number; port?: number } | null
    if (!saved || saved.pid !== pid || typeof saved.port !== "number") return false
    try {
      const res = await fetch(`http://127.0.0.1:${saved.port}/health`, { signal: AbortSignal.timeout(2_000) })
      if (!res.ok) return false
      const body = (await res.json()) as { pid?: number }
      return body.pid === pid
    } catch {
      return false
    }
  }
  if (!(await acquireLock(p.lockFile, { confirmDaemon }))) throw new AlreadyRunningError()

  let stats: Stats | null = null
  let abortStartup = () => {}
  try {
    const token = await loadOrCreateToken(p.tokenFile)

    const keyInfos: KeyInfo[] = []
    for (const alias of config.keys) {
      const secret = await o.secrets.get(alias)
      if (secret) keyInfos.push({ alias, secret })
      else log(`key "${alias}" is in config.json but not in the keyring — skipped`)
    }

    // Built-in VPN ("auto" transport): logs in to the uni Fortinet gateway and
    // tunnels UFR calls through a userspace TCP stack when direct fails.
    let vpn: VpnManager | null = null
    if (config.transport.type === "auto") {
      const [user, pass] = await Promise.all([o.secrets.get(VPN_USER), o.secrets.get(VPN_PASS)])
      vpn = new VpnManager({
        gateway: config.vpn.gateway,
        upstreamHost: new URL(config.upstream.baseUrl).hostname,
        baseUrl: config.upstream.baseUrl,
        credentials: user && pass ? { user, pass } : null,
        mode: config.vpn.mode,
        log,
        fetch: f,
      })
    }
    const transport = createTransport(config.transport, { vpn })
    const keys = new KeyPool(keyInfos, {
      cap: config.limits.keyRpm,
      windowMs: config.limits.keyWindowS * 1000,
      maxWaitMs: config.limits.keyMaxWaitS * 1000,
      now,
    })
    const pool = new SlidingWindow({
      cap: config.limits.poolPerHour,
      windowMs: config.limits.poolWindowS * 1000,
      maxWaitMs: config.limits.poolMaxWaitS * 1000,
      now,
    })
    const breakers = new BreakerRegistry({
      tripThreshold: config.breaker.tripThreshold,
      ladderMs: config.breaker.ladderS.map((s) => s * 1000),
      probeTimeoutMs: config.breaker.probeTimeoutS * 1000,
      now,
    })
    const db = new Stats(p.statsDb)
    stats = db
    db.prune(now() - 90 * 86_400_000)
    pool.seed(db.poolAdmissionsSince(now() - config.limits.poolWindowS * 1000))
    const saved = db.getKv("breakers")
    if (saved) {
      try {
        breakers.restore(JSON.parse(saved))
      } catch {
        log("stored breaker state unreadable — starting closed")
      }
    }

    const timers: ReturnType<typeof setInterval>[] = []
    let stopping = false
    // UFR's model list failed (VPN not up yet, UFR unreachable): retry with backoff
    // (60 s → 120 s → 300 s → 900 s, then every 900 s)
    // so connecting the VPN later needs no daemon restart.
    const retryMs = o.catalogRetryMs ?? [60_000, 120_000, 300_000, 900_000]
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let retries = 0
    const clearCatalogRetry = () => {
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = null
      retries = 0
    }
    abortStartup = () => {
      stopping = true // a failed start must not leave a retry timer behind
      clearCatalogRetry()
    }
    const scheduleCatalogRetry = () => {
      if (stopping || retryTimer) return
      const delay = Math.min(retryMs[Math.min(retries, retryMs.length - 1)]!, 900_000)
      retries++
      retryTimer = setTimeout(() => {
        retryTimer = null
        refreshCatalog().catch((e) => {
          log(`catalog refresh failed: ${(e as Error).message}`)
          scheduleCatalogRetry()
        })
      }, delay)
    }

    const reach: StatusJson["upstream"] = { ok: null, message: "", at: 0 }
    let catalog: Catalog = EMPTY_CATALOG
    let catalogInfo: Omit<StatusJson["catalog"], "models" | "warnings"> = { source: "none", ufrSource: "none", loadedAt: 0 }
    let probeStore = loadProbes((k) => db.getKv(k))
    let probing = false
    /** Measure models UFR serves but models.json does not describe (one at a time, off the hot path). */
    const scheduleProbes = async (ufrModels: UfrModel[], file: ModelsFile): Promise<void> => {
      if (probing || keyInfos.length === 0 || o.probes === false) return
      const unknown = ufrModels
        .map((u) => u.id)
        .filter((id) => file.models[id] === undefined && probeStore[id] === undefined)
      if (unknown.length === 0) return
      probing = true
      try {
        for (const id of unknown.slice(0, 2)) {
          if (stopping) break
          const result = await probeContextLimit({
            model: id,
            baseUrl: config.upstream.baseUrl,
            key: keyInfos[0]!.secret,
            transport,
            log,
          })
          if (result) {
            if (stopping) break
            saveProbe(probeStore, id, result, (k, v) => {
              if (stopping) return
              try { db.setKv(k, v) } catch { /* db already closed */ }
            })
            log(`context probe ${id}: ${result.context} tokens (${result.how})`)
          }
        }
        if (unknown.length > 0) {
          const mf2 = await loadBundledModels({ bundledPath: o.bundledModelsPath })
          catalog = buildCatalog(ufrModels, mf2.file, { allowPaid: config.allowPaid, probes: probeStore })
          catalogInfo = { ...catalogInfo, loadedAt: now() }
        }
      } finally {
        probing = false
      }
    }
    const refreshCatalog = async () => {
      // fixes ship with the package; UFR's live list is fetched through the transport (vpn-aware)
      const mf = await loadBundledModels({ bundledPath: o.bundledModelsPath })
      const ufr = await loadUfrModels({ baseUrl: config.upstream.baseUrl, key: keyInfos[0]?.secret ?? null,
        cachePath: p.ufrModelsCache, fetch: (u, i) => transport.fetch(u, i), log })
      catalog = buildCatalog(ufr.models, mf.file, { allowPaid: config.allowPaid, probes: probeStore })
      catalogInfo = { source: mf.source, ufrSource: ufr.source, loadedAt: now() }
      if (ufr.error) Object.assign(reach, { ok: false, message: ufr.error, at: now() })
      else if (reach.ok !== true) Object.assign(reach, { ok: true, message: "", at: now() })
      for (const w of catalog.warnings) log(w)
      // Keys are read once at start: without one a retry can never succeed.
      if (ufr.error && keyInfos.length > 0) scheduleCatalogRetry()
      else clearCatalogRetry()
      void scheduleProbes(ufr.models, mf.file).catch(() => {}) // must not outlive a shutdown
    }
    await refreshCatalog()

    const router = new Router({
      config,
      catalog: () => catalog,
      keys,
      pool,
      breakers,
      stats: db,
      transport,
      now,
      sleep,
      onUpstream: (ok, message) => Object.assign(reach, { ok, message, at: now() }),
    })

    const startedAt = now()
    let lastActivity = now()
    let port = 0
    const status = (): StatusJson => ({
      version: VERSION,
      pid: process.pid,
      port,
      uptimeMs: now() - startedAt,
      inFlight: router.inFlight,
      now: now(),
      upstream: { ...reach },
      keys: keys.snapshot(),
      pool: pool.snapshot(),
      breakers: breakers.states(),
      catalog: { ...catalogInfo, models: catalog.models.size, warnings: catalog.warnings },
      vpn: vpn ? { mode: vpn.status.mode, detail: vpn.status.detail } : null,
      spendToday: db.spendByKeySince(startOfLocalDay(now())),
      dailyBudgetUsd: config.dailyBudgetUsd,
    })

    let server: ReturnType<typeof startServer> | null = null
    const stop = async () => {
      if (stopping) return
      stopping = true
      for (const t of timers) clearInterval(t)
      clearCatalogRetry()
      try {
        db.setKv("breakers", JSON.stringify(breakers.snapshot()))
      } catch {
        // db already closed
      }
      server?.stop()
      db.close()
      await vpn?.stop()
      await rm(p.daemonFile, { force: true })
      await rm(p.lockFile, { force: true })
      releaseLockNonce(p.lockFile)
      log("stopped")
      o.onStopped?.()
    }

    const fixed = o.port !== undefined || config.port !== null
    const first = o.port ?? config.port ?? o.preferredPort ?? 47300
    for (let candidate = first, i = 0; i < (fixed ? 1 : 20); i++, candidate++) {
      try {
        server = startServer({
          port: candidate,
          token,
          version: VERSION,
          router,
          models: () => listModels(catalog),
          status,
          onActivity: () => {
            lastActivity = now()
          },
          onShutdown: () => void stop(),
        })
        break
      } catch (e) {
        const inUse = /EADDRINUSE|in use/i.test(`${(e as { code?: string }).code ?? ""} ${(e as Error).message}`)
        if (!inUse) throw e
        if (fixed) throw new Error(`port ${candidate} is in use by another program — change "port" in ${p.configFile}`)
      }
    }
    if (!server) throw new Error(`no free port between ${first} and ${first + 19}`)
    port = server.port
    if (!fixed) {
      config.port = port
      await saveConfig(p.configFile, config)
    }
    await writeFileAtomic(p.daemonFile, JSON.stringify({ port, pid: process.pid, version: VERSION, startedAt }) + "\n", 0o600)

    timers.push(setInterval(() => {
      // pick up new UFR models periodically (the fixes file only changes with a plugin update)
      refreshCatalog().catch((e) => log(`catalog refresh failed: ${(e as Error).message}`))
    }, 6 * 3_600_000))
    timers.push(setInterval(() => db.setKv("breakers", JSON.stringify(breakers.snapshot())), 30_000))
    timers.push(setInterval(() => db.prune(now() - 90 * 86_400_000), 86_400_000))
    if (o.exitOnIdle !== false) {
      const idleMs = o.idleMs ?? config.idleShutdownMin * 60_000
      timers.push(setInterval(() => {
        if (now() - lastActivity > idleMs && router.inFlight === 0) void stop()
      }, o.idleCheckMs ?? 30_000))
    }
    log(`listening on 127.0.0.1:${port} with ${keyInfos.length} key(s), ${catalog.models.size} models`)
    return { port, token, router, status, refreshCatalog, stop }
  } catch (e) {
    abortStartup()
    stats?.close()
    await rm(p.lockFile, { force: true })
    releaseLockNonce(p.lockFile)
    throw e
  }
}
