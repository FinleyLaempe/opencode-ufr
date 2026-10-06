/**
 * The built-in VPN's lifecycle: decides whether UFR is reachable directly,
 * brings the Fortinet tunnel up when not, and exposes a Transport the daemon
 * routes its UFR calls through. Nothing here touches the system's routing —
 * the tunnel lives entirely inside this process (userspace TCP stack).
 */

import { type Ipv4, ipv4Parse } from "./ip"
import { TcpStack } from "./stack"
import { startProxy, type ProxyHandle } from "./proxy"
import {
  authenticate,
  openTunnel,
  VpnChallengeError,
  type TunnelHandle,
} from "./fortinet"
import type { Transport } from "../transport"

export type VpnState = {
  mode: "off" | "connecting" | "up" | "failed"
  detail: string
  since: number
  innerIp?: string
  proxyPort?: number
  reconnectAttempt?: number
}

const DIRECT_CHECK_CACHE_MS = 60_000
const ESTABLISH_TIMEOUT_MS = 30_000
const LOGIN_TIMEOUT_MS = 15_000
const RECONNECT_BASE_MS = 5_000
const RECONNECT_MAX_MS = 10 * 60_000

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class VpnManager {
  private state: VpnState
  private tunnel: TunnelHandle | null = null
  private stack: TcpStack | null = null
  private proxy: ProxyHandle | null = null
  private remoteIp: Ipv4 | null = null
  private connecting: Promise<"direct" | "vpn" | "failed"> | null = null
  private directCheckedAt = 0
  private directOk = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private stopped = false

  constructor(
    private readonly o: {
      gateway: string // https://fortivpn.uni-freiburg.de
      upstreamHost: string // openwebui.uni-freiburg.de
      baseUrl: string // https://openwebui.uni-freiburg.de/api — for the direct check
      credentials: { user: string; pass: string } | null
      /** "always" skips the direct check: every UFR call goes through the tunnel. */
      mode?: "auto" | "always"
      log: (msg: string) => void
      /** Outgoing direct-leg fetch (injectable for tests). */
      fetch?: FetchFn
      /** Deadline for the gateway login (default 15 s). */
      loginTimeoutMs?: number
    },
    private readonly now: () => number = Date.now,
  ) {
    this.state = { mode: "off", detail: "not checked", since: now() }
  }

  get status(): VpnState {
    return { ...this.state }
  }

  /** UFR transport: through the tunnel when it is up, direct otherwise. */
  transport(): Transport {
    const f = this.o.fetch ?? fetch
    return {
      name: "vpn",
      fetch: async (url, init) => {
        const path = await untilAborted(this.ensurePath(), init?.signal)
        if (path === "vpn") {
          const proxy = this.proxy
          // ensurePath answered "vpn" but teardown nulled the proxy meanwhile:
          // fail fast instead of silently falling through to a direct fetch
          if (!proxy) throw new Error("the vpn tunnel went down while the request was starting — retry")
          return await fetch(url, { ...init, proxy: `http://127.0.0.1:${proxy.port}` } as RequestInit)
        }
        return await f(url, init)
      },
    }
  }

  /**
   * Make sure a working path to UFR exists. Cached direct checks avoid
   * hammering UFR with probes; the tunnel reconnects with backoff when it dies.
   */
  async ensurePath(): Promise<"direct" | "vpn" | "failed"> {
    if (this.stopped) return "failed"
    if (this.state.mode === "up" && this.proxy) return "vpn"
    const cacheFresh = this.now() - this.directCheckedAt < DIRECT_CHECK_CACHE_MS
    if (this.o.mode !== "always" && cacheFresh && this.directOk && this.state.mode !== "connecting") return "direct"
    if (this.connecting) return await this.connecting
    this.connecting = this.connect()
    try {
      return await this.connecting
    } finally {
      this.connecting = null
    }
  }

  private async connect(): Promise<"direct" | "vpn" | "failed"> {
    // 1. is UFR reachable directly? ("always" skips this: tunnel unconditionally)
    if (this.o.mode !== "always") {
      const direct = await this.checkDirect()
      if (direct === "direct") {
        this.setState("off", "UFR reachable directly — tunnel not needed")
        return "direct"
      }
    }
    // 2. tunnel needed — do we have a login?
    if (!this.o.credentials) {
      this.setState("failed", "off campus and no uni login stored — add the uni login in opencode's /connect (Uni Freiburg)")
      return "failed"
    }
    // 3. bring the tunnel up
    try {
      await this.open()
      return "vpn"
    } catch (e) {
      if (this.stopped) return "failed" // shutting down: don't overwrite the stopped state
      const msg = (e as Error).message
      this.setState("failed", msg)
      this.scheduleReconnect(msg)
      return "failed"
    }
  }

  private async checkDirect(): Promise<"direct" | "tunnel-needed"> {
    try {
      const res = await (this.o.fetch ?? fetch)(`${this.o.baseUrl}/models`, {
        headers: { "User-Agent": "opencode-ufr" },
        signal: AbortSignal.timeout(6_000),
        redirect: "manual",
        keepalive: false, // measure the current route, not a socket pooled before it changed
      })
      const type = res.headers.get("content-type") ?? ""
      this.directCheckedAt = this.now()
      if (type.includes("application/json")) {
        this.directOk = true
        return "direct"
      }
      // HTML or anything unexpected: the tunnel is the only path left
      this.directOk = false
      return "tunnel-needed"
    } catch {
      this.directCheckedAt = this.now()
      this.directOk = false
      return "tunnel-needed" // unreachable: try the tunnel before giving up
    }
  }

  private async open(): Promise<void> {
    const creds = this.o.credentials!
    this.setState("connecting", "logging in to the uni VPN")
    const loginMs = this.o.loginTimeoutMs ?? LOGIN_TIMEOUT_MS
    const signal = AbortSignal.timeout(loginMs)
    const { cookie } = await authenticate({
      gateway: this.o.gateway,
      user: creds.user,
      pass: creds.pass,
      log: this.o.log,
      signal,
    }).catch((e) => {
      throw signal.aborted ? new Error(`the uni VPN gateway did not answer within ${Math.ceil(loginMs / 1000)} s`) : e
    })
    // fresh per attempt: the DNS answer can change with the route
    this.remoteIp = await resolveIp(this.o.upstreamHost)

    this.setState("connecting", "negotiating PPP")
    let sendIp: (datagram: Uint8Array) => void = () => {}
    let stackRef: TcpStack | null = null
    const tunnel = await openTunnel({
      gateway: this.o.gateway,
      cookie,
      log: this.o.log,
      onPpp: (ppp) => {
        sendIp = (datagram) => ppp.sendIp(datagram)
      },
      onEstablished: (cfg) => {
        if (this.stopped) return // stop() mid-connect: the tunnel is closed below; don't start the proxy
        // parseTunnelConfig validates innerIp; this is a non-throwing assertion so a
        // malformed value can never surface as a "tunnel framing error"
        let local: Ipv4
        try {
          local = ipv4Parse(cfg.innerIp)
        } catch {
          this.o.log(`tunnel established with an invalid inner ip ("${cfg.innerIp}") — ignored`)
          return
        }
        if (!stackRef) {
          stackRef = new TcpStack({ local, sink: (pkt) => sendIp(pkt), opts: { mss: Math.min(cfg.mru - 40, 1360) } }, this.o.log)
          this.stack = stackRef
          this.proxy = startProxy({ stack: stackRef, remoteIp: this.remoteIp!, log: this.o.log })
          this.o.log(`proxy listening on 127.0.0.1:${this.proxy.port}`)
        } else {
          stackRef.setLocal(local)
        }
        this.reconnectAttempt = 0
        this.setState("up", `tunnel up (inner ip ${cfg.innerIp})`, cfg.innerIp, this.proxy?.port)
      },
      onDead: (reason) => {
        this.teardown()
        if (this.stopped) return
        this.setState("failed", `tunnel died: ${reason}`)
        this.scheduleReconnect(reason)
      },
      onIp: (datagram) => stackRef?.receive(datagram),
    })
    if (this.stopped) {
      // stop() ran while the connect was in flight: the tunnel came up after the
      // teardown — close it instead of leaking a live session
      await tunnel.close()
      throw new Error("stopped")
    }
    this.tunnel = tunnel

    // wait for the XML phase + PPP/ICCP negotiation to finish
    const deadline = Date.now() + ESTABLISH_TIMEOUT_MS
    while (this.state.mode !== "up") {
      if (this.stopped) {
        await tunnel.close()
        throw new Error("stopped")
      }
      if (Date.now() > deadline) {
        await tunnel.close()
        throw new Error("the tunnel did not come up within 30 s")
      }
      if (this.state.mode === "failed") throw new Error(this.state.detail)
      await Bun.sleep(100)
    }
  }

  private teardown(): void {
    this.tunnel = null
    this.stack?.closeAll()
    this.stack = null
    this.proxy?.stop()
    this.proxy = null
  }

  private scheduleReconnect(reason: string): void {
    if (this.reconnectTimer || this.stopped) return
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS)
    this.reconnectAttempt++
    this.o.log(`vpn reconnect in ${Math.round(delay / 1000)} s (${reason})`)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.stopped) return
      void this.ensurePath()
    }, delay)
  }

  private setState(mode: VpnState["mode"], detail: string, innerIp?: string, proxyPort?: number): void {
    this.state = {
      mode,
      detail,
      since: this.state.mode === mode ? this.state.since : this.now(),
      innerIp: innerIp ?? this.state.innerIp,
      proxyPort: proxyPort ?? this.state.proxyPort,
      reconnectAttempt: this.reconnectAttempt || undefined,
    }
  }

  /** Shut everything down (daemon idle shutdown). */
  async stop(): Promise<void> {
    this.stopped = true
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
    const t = this.tunnel
    this.teardown()
    if (t) await t.close()
    this.setState("off", "stopped")
  }
}

/** Waits for a shared attempt, but lets one caller give up on it (the attempt keeps running for the others). */
function untilAborted<T>(p: Promise<T>, signal?: AbortSignal | null): Promise<T> {
  if (!signal) return p
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener("abort", onAbort, { once: true })
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort))
  })
}

const RESOLVE_TIMEOUT_MS = 10_000

/** Resolve the upstream host to an IPv4, with a deadline (a hung resolver must not stall the connect forever). */
async function resolveIp(host: string, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<Ipv4> {
  const { lookup } = await import("node:dns/promises")
  let timer: ReturnType<typeof setTimeout> | null = null
  try {
    const res = await Promise.race([
      lookup(host, { family: 4 }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`DNS lookup for ${host} did not answer within ${Math.ceil(timeoutMs / 1000)} s`)), timeoutMs)
        timer.unref?.()
      }),
    ])
    return ipv4Parse(res.address)
  } finally {
    if (timer) clearTimeout(timer)
  }
}
