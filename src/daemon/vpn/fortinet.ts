/**
 * Fortinet SSL-VPN tunnel layer per docs/fortinet-protocol.md:
 * - 0x5050 ("PP") frame framing over the TLS stream (concat + split safe)
 * - HTTP auth → SVPNCOOKIE (tokeninfo-style 2FA supported; HTML-form 2FA is not)
 * - tunnel config XML parsing
 * - the tunnel itself: GET /remote/sslvpn-tunnel, then raw PPP frames on TLS
 */

import tls from "node:tls"

import { PppSession, type PppConfig, type PppOptions } from "./ppp"

// -- framing -----------------------------------------------------------------

export const FRAME_MAGIC = 0x5050
const MAX_FRAME = 16384 + 64 // servers may exceed the MTU; spec says use ≥16 KiB

/** Splits the TLS byte stream into complete tunnel frames (stateful). */
export class FrameReader {
  private buf = new Uint8Array(MAX_FRAME * 2)
  private len = 0

  /** Feed bytes; returns every complete frame contained. */
  push(chunk: Uint8Array): Uint8Array[] {
    if (this.len + chunk.length > this.buf.length) {
      // pathological server: grow
      const grown = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length))
      grown.set(this.buf.subarray(0, this.len))
      this.buf = grown
    }
    this.buf.set(chunk, this.len)
    this.len += chunk.length
    const out: Uint8Array[] = []
    let pos = 0
    for (;;) {
      if (this.len - pos < 6) break
      const total = (this.buf[pos]! << 8) | this.buf[pos + 1]!
      const magic = (this.buf[pos + 2]! << 8) | this.buf[pos + 3]!
      const pppLen = (this.buf[pos + 4]! << 8) | this.buf[pos + 5]!
      if (magic !== FRAME_MAGIC || total - 6 !== pppLen || total < 7) {
        throw new Error(`broken tunnel frame: magic 0x${magic.toString(16)} total ${total} ppp ${pppLen}`)
      }
      if (this.len - pos < total) break // frame split across TLS records: buffer
      out.push(this.buf.slice(pos + 6, pos + total))
      pos += total
    }
    if (pos > 0) {
      this.buf.copyWithin(0, pos, this.len)
      this.len -= pos
    }
    return out
  }
}

/** Wraps one PPP frame into the 6-byte tunnel header. */
export function wrapFrame(ppp: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + ppp.length)
  const total = 6 + ppp.length
  out[0] = total >> 8
  out[1] = total & 0xff
  out[2] = FRAME_MAGIC >> 8
  out[3] = FRAME_MAGIC & 0xff
  out[4] = ppp.length >> 8
  out[5] = ppp.length & 0xff
  out.set(ppp, 6)
  return out
}

// -- auth --------------------------------------------------------------------

export const FORTI_UA = "Mozilla/5.0 SV1"

export class VpnAuthError extends Error {}
export class VpnChallengeError extends Error {
  constructor(readonly kind: "credentials" | "2fa-html-form" | "unsupported", message: string) {
    super(message)
  }
}

export type AuthOutcome = { cookie: string; realm: string }

function formEncode(fields: Record<string, string>): string {
  return Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&")
}

function cookieFrom(res: Response): string | null {
  const candidates = [...(res.headers.getSetCookie?.() ?? []), ...(res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : [])]
  for (const c of candidates) {
    const eq = c.indexOf("=")
    if (!c.startsWith("SVPNCOOKIE") || eq < 0) continue
    const value = c.slice(eq + 1).split(";", 1)[0]?.trim() ?? ""
    // "SVPNCOOKIE=" with an empty value is a deletion, not a session
    if (value === "") continue
    return `SVPNCOOKIE=${value}`
  }
  return null
}

/** All cookies a response sets, as a "name=value; …" header (SVPNCOOKIE deletions skipped). */
function cookiesFrom(res: Response, existing = ""): string {
  const jar = new Map<string, string>()
  for (const pair of existing.split(";")) {
    const [k, v] = pair.split("=", 2)
    if (k?.trim()) jar.set(k.trim(), v ?? "")
  }
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(";")
    const eq = pair?.indexOf("=") ?? -1
    if (eq <= 0) continue
    const name = pair!.slice(0, eq).trim()
    const value = pair!.slice(eq + 1).trim()
    if (value === "") jar.delete(name) // deletion
    else jar.set(name, value)
  }
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ")
}

/**
 * Full login: GET / (JS redirect + realm), POST /remote/logincheck, optional
 * tokeninfo 2FA round (code via on2fa). Returns the SVPNCOOKIE cookie pair.
 */
export async function authenticate(o: {
  gateway: string // https://fortivpn.uni-freiburg.de
  user: string
  pass: string
  fetch?: typeof fetch
  on2fa?: (challenge: { kind: string; message: string }) => Promise<string> // returns the OTP ("" = FTM push)
  log?: (msg: string) => void
  /** Deadline for the whole login. Without one a gateway that stops answering stalls it forever. */
  signal?: AbortSignal
}): Promise<AuthOutcome> {
  const f = o.fetch ?? fetch
  const log = o.log ?? (() => {})
  const base = o.gateway.replace(/\/$/, "")
  // Fresh connections only: a pooled socket opened before the user's own VPN changed
  // the route is dead, and a request on it is never answered.
  const net = { keepalive: false, signal: o.signal }

  // 1. GET / — follow redirects manually (fetch drops intermediate Set-Cookies),
  //    keep the cookie jar: FortiOS binds the logincheck to the login-page session.
  let realm = ""
  let jar = ""
  let url = `${base}/`
  for (let hops = 0; hops < 5; hops++) {
    const res = await f(url, { headers: { "User-Agent": FORTI_UA, ...(jar ? { Cookie: jar } : {}) }, redirect: "manual", ...net })
    jar = cookiesFrom(res, jar)
    const body = await res.text().catch(() => "")
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location")
      if (!loc) break
      url = new URL(loc, url).toString()
      continue
    }
    const js = /top\.location\s*=\s*"([^"]+)"/.exec(body)?.[1]
      ?? /window\.location\s*=\s*"([^"]+)"/.exec(body)?.[1]
    if (js) {
      url = new URL(js, url).toString()
      continue
    }
    // landed on the login form (or any page): look for the realm
    const realmMatch = /[?&]realm=([^&]+)/.exec(url) ?? /[?&]realm=([^&"']+)/.exec(body)
    if (realmMatch) realm = decodeURIComponent(realmMatch[1]!)
    break
  }
  log(realm ? `login page (realm "${realm}")` : "login page")

  // 2. POST /remote/logincheck (ajax=1 → ret= body; 405 = bad credentials)
  const post = (body: Record<string, string>) =>
    f(`${base}/remote/logincheck`, {
      method: "POST",
      headers: {
        "User-Agent": FORTI_UA,
        "Content-Type": "application/x-www-form-urlencoded",
        ...(jar ? { Cookie: jar } : {}),
      },
      body: formEncode(body),
      redirect: "manual",
      ...net,
    })

  let res = await post({ username: o.user, credential: o.pass, realm, ajax: "1", just_logged_in: "1" })
  jar = cookiesFrom(res, jar)
  let cookie = cookieFrom(res)
  if (cookie) return { cookie, realm }

  // 3. no cookie: ret=/tokeninfo challenge (2FA), or failure
  const body = await res.text().catch(() => "")
  const fields = new Map<string, string>()
  for (const m of body.matchAll(/([a-zA-Z_]+)=([^,&\r\n]*)/g)) fields.set(m[1]!, m[2]!)
  const ret = fields.get("ret")

  if (res.status === 405 || ret === "0") {
    throw new VpnChallengeError("credentials", "the uni VPN rejected the login (wrong user or password)")
  }
  if (fields.has("tokeninfo") || (ret !== undefined && ret !== "1")) {
    const kind = fields.get("tokeninfo") ?? "token"
    const message = fields.get("chal_msg") ?? "one-time code required"
    if (!o.on2fa) throw new VpnChallengeError("2fa-html-form", `2FA challenge (${kind}) but no code prompt configured`)
    const code = await o.on2fa({ kind, message })
    const second: Record<string, string> = { username: o.user, realm }
    if (code === "" && kind === "ftm_push") {
      second.ftmpush = "1" // FortiToken Mobile push instead of a typed code
    } else {
      second.code = code
      second.code2 = ""
    }
    for (const k of ["reqid", "polid", "grp", "portal", "peer"]) {
      if (fields.has(k)) second[k] = fields.get(k)!
    }
    if (fields.has("magic")) second.magic = fields.get("magic")! // must be last
    res = await post(second)
    cookie = cookieFrom(res)
    if (cookie) return { cookie, realm }
    const retry = await res.text().catch(() => "")
    if (res.status === 405 || /ret=0/.test(retry)) {
      throw new VpnChallengeError("credentials", "the uni VPN rejected the one-time code")
    }
    throw new VpnChallengeError("unsupported", `2FA did not conclude (HTTP ${res.status})`)
  }
  throw new VpnChallengeError("unsupported", `unexpected login response (HTTP ${res.status})${body ? `: ${body.slice(0, 120)}` : ""}`)
}

// -- tunnel config XML ---------------------------------------------------------

export type TunnelConfig = {
  innerIp: string
  dns: string[]
  dpdS: number
  idleTimeoutS: number
  authTimeoutS: number
  routes: { ip: string; mask: string }[]
}

function attr(xml: string, tag: string, attribute: string): string | null {
  const re = new RegExp(`<${tag}[^>]*\\b${attribute}=["']([^"']*)["']`, "i")
  return re.exec(xml)?.[1] ?? null
}

export function parseTunnelConfig(xml: string): TunnelConfig {
  if (!/<sslvpn-tunnel/i.test(xml)) {
    throw new VpnAuthError("tunnel config: response is not a sslvpn-tunnel document (session dead?)")
  }
  const dns = [...xml.matchAll(/<dns[^>]*\bip=["']([^"']*)["']/gi)].map((m) => m[1]!)
  const routes = [...xml.matchAll(/<addr[^>]*\bip=["']([^"']*)["'][^>]*\bmask=["']([^"']*)["']/gi)].map((m) => ({ ip: m[1]!, mask: m[2]! }))
  return {
    innerIp: attr(xml, "assigned-addr", "ipv4") ?? "",
    dns,
    dpdS: Number(attr(xml, "dtls-config", "heartbeat-interval") ?? "10"),
    idleTimeoutS: Number(attr(xml, "idle-timeout", "val") ?? "0"),
    authTimeoutS: Number(attr(xml, "auth-timeout", "val") ?? "0"),
    routes,
  }
}

export async function fetchTunnelConfig(o: {
  gateway: string
  cookie: string
  fetch?: typeof fetch
}): Promise<TunnelConfig> {
  const f = o.fetch ?? fetch
  const res = await f(`${o.gateway.replace(/\/$/, "")}/remote/fortisslvpn_xml?dual_stack=1`, {
    headers: { "User-Agent": FORTI_UA, Cookie: o.cookie },
    redirect: "manual",
  })
  const text = await res.text().catch(() => "")
  if (res.status !== 200 || /\/remote\/login/.test(res.headers.get("location") ?? "")) {
    throw new VpnAuthError("tunnel config fetch failed — session invalid (HTTP " + res.status + ")")
  }
  return parseTunnelConfig(text)
}

// -- the tunnel ----------------------------------------------------------------

export type TunnelHandle = {
  readonly config: TunnelConfig
  readonly ppp: PppSession
  /** Clean teardown: PPP TERMREQ, close TLS, logout. */
  close(): Promise<void>
}

export async function openTunnel(o: {
  gateway: string
  cookie: string
  /** Called as soon as the PPP session exists (before negotiation starts). */
  onPpp?: (ppp: PppSession) => void
  onEstablished: (cfg: PppConfig) => void
  onDead: (reason: string) => void
  onIp: (datagram: Uint8Array) => void
  pppOptions?: PppOptions
  log?: (msg: string) => void
}): Promise<TunnelHandle> {
  const log = o.log ?? (() => {})
  const url = new URL(o.gateway)
  const host = url.hostname
  const port = Number(url.port) || 443

  let socket: import("node:tls").TLSSocket | null = null
  let reader = new FrameReader()
  let closed = false
  let config: TunnelConfig | null = null
  let ppp: PppSession | null = null

  // -- raw HTTP response reader over the tunnel socket (XML phase) ------------
  let httpBuf = Buffer.alloc(0)
  let phase: "xml" | "tunnel" = "xml"

  const fail = (msg: string): void => {
    if (closed) return
    closed = true
    ppp?.destroy()
    socket?.end()
    log(`tunnel failed: ${msg}`)
    o.onDead(msg)
  }

  const handleXmlData = (chunk: Uint8Array): void => {
    httpBuf = Buffer.concat([httpBuf, Buffer.from(chunk)])
    const headEnd = httpBuf.indexOf("\r\n\r\n")
    if (headEnd === -1) return
    const head = httpBuf.subarray(0, headEnd).toString()
    const status = Number(/^HTTP\/[\d.]+ (\d+)/.exec(head)?.[1] ?? 0)
    const bodyStart = headEnd + 4
    const chunked = /transfer-encoding:\s*chunked/i.test(head)
    let body: Buffer | null = null
    let rest: Buffer | null = null
    if (chunked) {
      // dechunk incrementally; complete when the terminal chunk arrives
      const bodyBuf = httpBuf.subarray(bodyStart)
      let out = Buffer.alloc(0)
      let pos = 0
      for (;;) {
        const nl = bodyBuf.indexOf("\r\n", pos)
        if (nl === -1) return // wait for more
        const size = parseInt(bodyBuf.subarray(pos, nl).toString(), 16)
        if (Number.isNaN(size)) return fail("broken chunked body in tunnel config response")
        if (size === 0) { rest = bodyBuf.subarray(pos + 5); break } // skip "0\r\n\r\n"
        if (bodyBuf.length < pos + nl + 2 + size + 2) return // wait for more
        out = Buffer.concat([out, bodyBuf.subarray(nl + 2, nl + 2 + size)])
        pos = nl + 2 + size + 2
      }
      body = out
    } else {
      const cl = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0)
      if (httpBuf.length < bodyStart + cl) return // wait for more
      body = httpBuf.subarray(bodyStart, bodyStart + cl)
      rest = httpBuf.subarray(bodyStart + cl)
    }
    if (status !== 200) return fail(`tunnel config request failed (HTTP ${status}) — session invalid?`)
    if (status === 200 && /\/remote\/login/i.test(head)) return fail("tunnel config redirected to login — session invalid")
    config = parseTunnelConfig((body as Buffer).toString())
    log(`tunnel config: inner ip ${config.innerIp}, dns ${config.dns.join(", ") || "none"}, dpd ${config.dpdS}s`)
    // switch into tunnel phase: leftover bytes belong to the tunnel response
    httpBuf = Buffer.from(rest as Buffer)
    phase = "tunnel"
    socket?.write(
      `GET /remote/sslvpn-tunnel HTTP/1.1\r\n` +
      `Host: ${host}${port === 443 ? "" : `:${port}`}\r\n` +
      `User-Agent: ${FORTI_UA}\r\n` +
      `Cookie: ${o.cookie}\r\n` +
      `\r\n`,
    )
    startPpp()
  }

  const startPpp = (): void => {
    ppp = new PppSession(
      {
        sendPpp: (frame) => {
          if (socket && !closed) socket.write(wrapFrame(frame))
        },
        onIp: o.onIp,
        onEstablished: o.onEstablished,
        onDead: (reason) => {
          if (!closed) {
            closed = true
            socket?.end()
            o.onDead(reason)
          }
        },
      },
      { dpdS: config?.dpdS ?? 10, ...o.pppOptions, log },
    )
    o.onPpp?.(ppp)
    log("tunnel requested — waiting for PPP negotiation")
    ppp.start()
    if (httpBuf.length > 0) {
      // bytes that arrived between the XML response and the tunnel request
      feedTunnel(httpBuf)
      httpBuf = Buffer.alloc(0)
    }
  }

  const feedTunnel = (chunk: Uint8Array): void => {
    if (!sawTunnelBytes) {
      sawTunnelBytes = true
      // Success = silence (frames begin); an HTTP response here means refusal.
      if (chunk.length >= 5 && new TextDecoder().decode(chunk.slice(0, 5)) === "HTTP/") {
        const status = /^HTTP\/[\d.]+ (\d+)/.exec(new TextDecoder().decode(chunk.slice(0, 32)))?.[1]
        fail(`the gateway refused tunnel mode (HTTP ${status ?? "?"}) — tunnel not allowed for this account`)
        return
      }
    }
    try {
      for (const frame of reader.push(chunk)) ppp?.receive(frame)
    } catch (e) {
      fail(`tunnel framing error: ${(e as Error).message}`)
    }
  }
  let sawTunnelBytes = false

  socket = tls.connect({
    host,
    port,
    servername: host,
    ALPNProtocols: ["http/1.1"], // the tunnel speaks HTTP/1.1 then switches to PPP frames
    rejectUnauthorized: true,
  })
  socket.on("data", (chunk: Buffer) => {
    if (closed) return
    if (phase === "xml") return handleXmlData(new Uint8Array(chunk))
    feedTunnel(new Uint8Array(chunk))
  })
  socket.on("error", (err: Error) => {
    if (!closed) {
      closed = true
      ppp?.destroy()
      o.onDead(`tunnel socket error: ${err.message}`)
    }
  })
  socket.on("close", () => {
    if (!closed) {
      closed = true
      ppp?.destroy()
      o.onDead("tunnel closed by server")
    }
  })

  socket.write(
    `GET /remote/fortisslvpn_xml?dual_stack=1 HTTP/1.1\r\n` +
    `Host: ${host}${port === 443 ? "" : `:${port}`}\r\n` +
    `User-Agent: ${FORTI_UA}\r\n` +
    `Cookie: ${o.cookie}\r\n` +
    `\r\n`,
  )
  // The manager waits for onEstablished; the PPP negotiation happens
  // on this one connection, exactly like openconnect's.

  const close = async (): Promise<void> => {
    if (closed) return
    ppp?.close() // TERMREQ; onDead fires ≤1 s later (or immediately on TERMACK)
    await Bun.sleep(50)
    closed = true
    socket?.end()
    try {
      await fetch(`${o.gateway.replace(/\/$/, "")}/remote/logout`, {
        headers: { "User-Agent": FORTI_UA, Cookie: o.cookie },
        redirect: "manual",
        keepalive: false,
        signal: AbortSignal.timeout(5_000), // a reconnect and the daemon's shutdown wait for this
      })
    } catch { /* best effort */ }
  }

  // config is filled in by the XML phase; expose a getter
  return {
    get config(): TunnelConfig {
      return config ?? { innerIp: "", dns: [], dpdS: 10, idleTimeoutS: 0, authTimeoutS: 0, routes: [] }
    },
    get ppp(): PppSession {
      return ppp!
    },
    close,
  }
}
