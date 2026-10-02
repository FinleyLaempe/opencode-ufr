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
  fetchTunnelConfig,
  openTunnel,
  VpnChallengeError,
  type TunnelHandle,
} from "./fortinet"
import type { Transport } from "../transport"
import { isVpnPage } from "../../shared/vpn"

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
        const path = await this.ensurePath()
        if (path === "vpn" && this.proxy) {
          return await fetch(url, { ...init, proxy: `http://127.0.0.1:${this.proxy.port}` } as RequestInit)
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
      this.setState("failed", "off campus and no uni login stored — run `ufr login add <user>`")
      return "failed"
    }
    // 3. bring the tunnel up
    try {
      await this.open()
      return "vpn"
    } catch (e) {
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
      })
      const type = res.headers.get("content-type") ?? ""
      this.directCheckedAt = this.now()
      if (type.includes("application/json")) {
        this.directOk = true
        return "direct"
      }
      if (type.includes("text/html")) {
        const html = await res.text().catch(() => "")
        this.directOk = false
        return isVpnPage(html) ? "tunnel-needed" : "tunnel-needed"
      }
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
    const { cookie } = await authenticate({
      gateway: this.o.gateway,
      user: creds.user,
      pass: creds.pass,
      log: this.o.log,
    })
    if (this.remoteIp === null) this.remoteIp = await resolveIp(this.o.upstreamHost)

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
        if (!stackRef) {
          stackRef = new TcpStack({ local: ipv4Parse(cfg.innerIp), sink: (pkt) => sendIp(pkt), opts: { mss: Math.min(cfg.mru - 40, 1360) } }, this.o.log)
          this.stack = stackRef
          this.proxy = startProxy({ stack: stackRef, remoteIp: this.remoteIp!, log: this.o.log })
          this.o.log(`proxy listening on 127.0.0.1:${this.proxy.port}`)
        } else {
          stackRef.setLocal(ipv4Parse(cfg.innerIp))
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
    this.tunnel = tunnel

    // wait for the XML phase + PPP/ICCP negotiation to finish
    const deadline = Date.now() + ESTABLISH_TIMEOUT_MS
    while (this.state.mode !== "up") {
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

async function resolveIp(host: string): Promise<Ipv4> {
  const { lookup } = await import("node:dns/promises")
  const res = await lookup(host, { family: 4 })
  return ipv4Parse(res.address)
}
