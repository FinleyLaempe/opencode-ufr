/**
 * PPP over the Fortinet SSL-VPN tunnel (RFC 1661 framing, no HDLC), following
 * docs/fortinet-protocol.md.
 *
 * The client only needs: LCP (MRU + magic, no auth — the SVPNCOOKIE did that),
 * IPCP (solicit inner IPv4 + DNS), Echo keepalives (DPD) and IP data frames.
 * Everything else is rejected or ignored defensively.
 */

export const PPP_IP = 0x0021
export const PPP_LCP = 0xc021
export const PPP_IPCP = 0x8021
export const PPP_CCP = 0x80fd

export const CONFREQ = 1
export const CONFACK = 2
export const CONFNAK = 3
export const CONFREJ = 4
export const TERMREQ = 5
export const TERMACK = 6
export const PROTREJ = 8
export const ECHOREQ = 9
export const ECHOREP = 10

// LCP option tags
const LCP_MRU = 1
const LCP_MAGIC = 5
// IPCP option tags
const IPCP_IPADDR = 3
const IPCP_DNS1 = 129
const IPCP_DNS2 = 131

const RETRANSMIT_MS = 3_000
const TERM_WAIT_MS = 1_000

export type PppConfig = { innerIp: string; dns: string[]; mru: number }

export type PppEvents = {
  /** PPP frame outbound (the tunnel layer wraps it). */
  sendPpp(frame: Uint8Array): void
  /** IPv4 datagram received from the tunnel (protocol 0x0021). */
  onIp(datagram: Uint8Array): void
  /** Negotiation finished; the stack can dial. */
  onEstablished(cfg: PppConfig): void
  /** The link died (DPD timeout, TERMREQ, or framing error). */
  onDead(reason: string): void
}

export type PppOptions = {
  mru?: number // what we announce and assume as link MTU
  dpdS?: number // DPD interval in seconds (from the XML config)
  log?: (msg: string) => void
}

type Tlv = { tag: number; data: Uint8Array }

const u16 = (a: Uint8Array, i: number) => (a[i]! << 8) | a[i + 1]!

function tlvBytes(tag: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + data.length)
  out[0] = tag
  out[1] = 2 + data.length
  out.set(data, 2)
  return out
}

function parseTlvs(data: Uint8Array): Tlv[] {
  const out: Tlv[] = []
  let i = 0
  while (i + 2 <= data.length) {
    const len = data[i + 1]!
    if (len < 2 || i + len > data.length) break
    out.push({ tag: data[i]!, data: data.slice(i + 2, i + len) })
    i += len
  }
  return out
}

/** Builds a complete PPP frame: FF 03 | protocol | payload. */
export function pppFrame(proto: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length)
  out[0] = 0xff
  out[1] = 0x03
  out[2] = proto >> 8
  out[3] = proto & 0xff
  out.set(payload, 4)
  return out
}

/** Splits a PPP frame into protocol + payload; null if malformed. */
export function parsePpp(frame: Uint8Array): { proto: number; payload: Uint8Array } | null {
  let i = 0
  if (frame.length >= 2 && frame[0] === 0xff && frame[1] === 0x03) i = 2
  if (frame.length < i + 2) return null
  // protocol field: 2 bytes when the first byte is even (PFC never negotiated, but parse defensively)
  let proto: number
  if (frame[i]! & 1) {
    proto = frame[i]!
    i += 1
  } else {
    proto = u16(frame, i)
    i += 2
  }
  return { proto, payload: frame.slice(i) }
}

function ncpPacket(code: number, id: number, options: Uint8Array): Uint8Array {
  const len = 4 + options.length
  const out = new Uint8Array(len)
  out[0] = code
  out[1] = id
  out[2] = len >> 8
  out[3] = len & 0xff
  out.set(options, 4)
  return out
}

export class PppSession {
  private mru: number
  private dpdMs: number
  private magic = (Math.floor(Math.random() * 0xffffffff) | 1) >>> 0
  private nextId = 1
  private peerMagic: number | null = null
  private lcpAckSent = false
  private lcpAckReceived = false
  private ipcpAckSent = false
  private ipcpAckReceived = false
  private innerIp = ""
  private dns: string[] = []
  private ourConfReq: Uint8Array | null = null // pending LCP CONFREQ (for retransmit)
  private ourConfReqId = 0
  private ipcpReq: Uint8Array | null = null
  private ipcpReqId = 0
  private retransmitTimer: ReturnType<typeof setTimeout> | null = null
  private dpdTimer: ReturnType<typeof setInterval> | null = null
  private lastReceivedAt = Date.now()
  private echoOutstanding = false
  private termWait: ReturnType<typeof setTimeout> | null = null
  private dead = false
  private log: (msg: string) => void

  constructor(private readonly ev: PppEvents, o: PppOptions = {}) {
    this.mru = o.mru ?? 1400
    this.dpdMs = (o.dpdS ?? 10) * 1000
    this.log = o.log ?? (() => {})
  }

  get established(): boolean {
    return this.lcpAckSent && this.lcpAckReceived && this.ipcpAckSent && this.ipcpAckReceived
  }

  get config(): PppConfig {
    return { innerIp: this.innerIp, dns: [...this.dns], mru: this.mru }
  }

  /** Kick off negotiation: LCP CONFREQ (MRU + magic). */
  start(): void {
    this.sendLcpConfReq()
    this.startDpd()
  }

  private sendLcpConfReq(): void {
    const options = concat([tlvBytes(LCP_MRU, u16be(this.mru)), tlvBytes(LCP_MAGIC, u32be(this.magic))])
    this.ourConfReq = ncpPacket(CONFREQ, this.nextId, options)
    this.ourConfReqId = this.nextId
    this.nextId = (this.nextId + 1) & 0xff || 1
    this.ev.sendPpp(pppFrame(PPP_LCP, this.ourConfReq))
    this.armRetransmit()
  }

  /** IPCP CONFREQ: zeros to solicit before the NAK, assigned values after it. */
  private buildIpcpOptions(): Uint8Array {
    const ip = this.innerIp ? parseIpv4(this.innerIp) : new Uint8Array(4)
    const opts = [tlvBytes(IPCP_IPADDR, ip)]
    if (this.dns.length > 0) {
      for (let i = 0; i < Math.min(2, this.dns.length); i++) {
        opts.push(tlvBytes(i === 0 ? IPCP_DNS1 : IPCP_DNS2, parseIpv4(this.dns[i]!)))
      }
    } else {
      opts.push(tlvBytes(IPCP_DNS1, new Uint8Array(4)), tlvBytes(IPCP_DNS2, new Uint8Array(4)))
    }
    return concat(opts)
  }

  private sendIpcpConfReq(): void {
    if (!this.lcpOpen() || this.ipcpAckReceived) return
    const options = this.buildIpcpOptions()
    this.ipcpReq = ncpPacket(CONFREQ, this.nextId, options)
    this.ipcpReqId = this.nextId
    this.nextId = (this.nextId + 1) & 0xff || 1
    this.ev.sendPpp(pppFrame(PPP_IPCP, this.ipcpReq))
    this.armRetransmit()
  }

  private armRetransmit(): void {
    if (this.retransmitTimer) clearTimeout(this.retransmitTimer)
    this.retransmitTimer = setTimeout(() => {
      this.retransmitTimer = null
      if (this.dead) return
      if (this.ourConfReq && !this.lcpAckReceived) {
        this.log("lcp confreq timed out — retransmitting with a fresh id")
        this.sendLcpConfReq() // new id per spec (ppp.c:891-901)
      } else if (this.ipcpReq && !this.ipcpAckReceived) {
        this.log("ipcp confreq timed out — retransmitting with a fresh id")
        this.sendIpcpConfReq()
      }
    }, RETRANSMIT_MS)
  }

  private startDpd(): void {
    if (this.dpdTimer) clearInterval(this.dpdTimer)
    this.lastReceivedAt = Date.now()
    this.echoOutstanding = false
    this.dpdTimer = setInterval(() => {
      if (this.dead) return
      const silentMs = Date.now() - this.lastReceivedAt
      if (silentMs >= 2 * this.dpdMs) {
        this.kill("dead peer: no data for " + Math.round(silentMs / 1000) + "s")
        return
      }
      if (silentMs >= this.dpdMs && !this.echoOutstanding) {
        this.echoOutstanding = true
        const payload = u32be(this.magic)
        this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(ECHOREQ, this.nextId, payload)))
        this.nextId = (this.nextId + 1) & 0xff || 1
      }
    }, Math.min(this.dpdMs / 2, 5_000))
  }

  /** The tunnel layer calls this for every inbound PPP frame AND for DPD feeding. */
  receive(frame: Uint8Array): void {
    if (this.dead) return
    this.lastReceivedAt = Date.now()
    this.echoOutstanding = false
    const p = parsePpp(frame)
    if (!p) return this.kill("malformed PPP frame")
    switch (p.proto) {
      case PPP_LCP: return this.receiveLcp(p.payload)
      case PPP_IPCP: return this.receiveIpcp(p.payload)
      case PPP_IP: return this.ev.onIp(p.payload)
      case PPP_CCP: return this.sendProtRej(PPP_CCP) // no compression, per spec quirk 13
      default: return // unknown protocol: ignore (IP6CP etc.)
    }
  }

  private receiveLcp(payload: Uint8Array): void {
    if (payload.length < 4) return this.kill("short LCP packet")
    const code = payload[0]!
    const id = payload[1]!
    const body = payload.slice(4)
    switch (code) {
      case CONFACK:
        if (this.ourConfReq && id === this.ourConfReqId) {
          this.lcpAckReceived = true
          this.ourConfReq = null
          if (this.retransmitTimer) { clearTimeout(this.retransmitTimer); this.retransmitTimer = null }
          this.log("lcp opened (our confreq acked)")
          this.maybeEstablish()
          this.sendIpcpConfReq()
        }
        return
      case CONFREQ: return this.answerServerConfReq(id, body)
      case CONFNAK: return this.nakLcp(id, body)
      case ECHOREQ: {
        if (!this.lcpOpen()) return
        this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(ECHOREP, id, u32be(this.magic))))
        return
      }
      case ECHOREP: return // nothing to do; DPD fed above
      case TERMREQ: {
        const reason = new TextDecoder().decode(body).trim()
        this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(TERMACK, id, new Uint8Array(0))))
        return this.kill(`server terminated the link${reason ? `: ${reason}` : ""}`)
      }
      case TERMACK:
        if (this.termWait) { clearTimeout(this.termWait); this.termWait = null }
        return this.kill("link terminated")
      default: return // CODEREJ/DISCREQ etc.: ignore
    }
  }

  private lcpOpen(): boolean {
    return this.lcpAckSent && this.lcpAckReceived
  }

  private answerServerConfReq(id: number, body: Uint8Array): void {
    const tlvs = parseTlvs(body)
    const accept: Uint8Array[] = []
    const reject: Tlv[] = []
    let serverMru: number | null = null
    for (const t of tlvs) {
      if (t.tag === LCP_MRU && t.data.length === 2) {
        serverMru = u16(t.data, 0)
        accept.push(tlvBytes(LCP_MRU, t.data))
      } else if (t.tag === LCP_MAGIC && t.data.length === 4) {
        this.peerMagic = u32(t.data, 0)
        accept.push(tlvBytes(LCP_MAGIC, t.data))
      } else {
        reject.push(t) // ASYNCMAP and anything else: Fortinet gets a CONFREJ (spec §4.3)
      }
    }
    if (reject.length > 0) {
      const options = concat(reject.map((t) => [new Uint8Array([t.tag, t.data.length + 2]), t.data]).flat())
      this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(CONFREJ, id, options)))
    } else {
      this.lcpAckSent = true
      this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(CONFACK, id, body)))
      if (serverMru && serverMru !== this.mru) {
        // adopt the server's final word on the link MTU (spec: accept after one coax)
        this.mru = serverMru
      }
      this.maybeEstablish()
      this.sendIpcpConfReq()
    }
  }

  private nakLcp(id: number, body: Uint8Array): void {
    // one-shot coax: server nak'd our MRU — accept its suggestion verbatim
    const tlvs = parseTlvs(body)
    const mru = tlvs.find((t) => t.tag === LCP_MRU && t.data.length === 2)
    if (mru) {
      this.mru = u16(mru.data, 0)
      this.log(`lcp mru coerced to ${this.mru}`)
      this.ourConfReq = null
      this.sendLcpConfReq()
    }
  }

  private receiveIpcp(payload: Uint8Array): void {
    if (payload.length < 4) return
    const code = payload[0]!
    const id = payload[1]!
    const body = payload.slice(4)
    switch (code) {
      case CONFACK:
        if (this.ipcpReq && id === this.ipcpReqId) {
          this.ipcpAckReceived = true
          this.ipcpReq = null
          if (this.retransmitTimer) { clearTimeout(this.retransmitTimer); this.retransmitTimer = null }
          this.log(`ipcp opened (inner ip ${this.innerIp})`)
          this.maybeEstablish()
        }
        return
      case CONFNAK: {
        // the server hands out the real values here
        const tlvs = parseTlvs(body)
        const ip = tlvs.find((t) => t.tag === IPCP_IPADDR && t.data.length === 4)
        if (ip) this.innerIp = ipv4Str(ip.data)
        for (const t of tlvs) {
          if ((t.tag === IPCP_DNS1 || t.tag === IPCP_DNS2) && t.data.length === 4) {
            const d = ipv4Str(t.data)
            if (!this.dns.includes(d)) this.dns.push(d)
          }
        }
        this.log(`ipcp nak: inner ip ${this.innerIp}, dns ${this.dns.join(", ")}`)
        // re-request with the assigned values (spec §4.5: REQ → NAK → REQ → ACK)
        this.sendIpcpConfReq()
        return
      }
      case CONFREQ: {
        // server-side IPCP request: ack it verbatim (we requested nothing special)
        this.ipcpAckSent = true
        this.ev.sendPpp(pppFrame(PPP_IPCP, ncpPacket(CONFACK, id, body)))
        this.maybeEstablish()
        return
      }
      case TERMREQ: {
        const reason = new TextDecoder().decode(body).trim()
        this.ev.sendPpp(pppFrame(PPP_IPCP, ncpPacket(TERMACK, id, new Uint8Array(0))))
        return this.kill(`server terminated IPCP${reason ? `: ${reason}` : ""}`)
      }
      default: return
    }
  }

  private maybeEstablish(): void {
    if (this.established) {
      this.log(`ppp established: inner ip ${this.innerIp}, dns ${this.dns.join(", ") || "none"}, mru ${this.mru}`)
      this.ev.onEstablished(this.config)
    }
  }

  private sendProtRej(proto: number): void {
    const info = new Uint8Array(4)
    info[0] = proto >> 8
    info[1] = proto & 0xff
    this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(PROTREJ, this.nextId, info)))
    this.nextId = (this.nextId + 1) & 0xff || 1
  }

  /** Send an IPv4 datagram into the tunnel (protocol 0x0021). A dead link drops it, like a
   *  downed interface: teardown sends RSTs from timers and socket handlers, where a throw kills the daemon. */
  sendIp(datagram: Uint8Array): void {
    if (this.dead) return
    this.ev.sendPpp(pppFrame(PPP_IP, datagram))
  }

  /** Clean teardown: TERMREQ, wait ≤1 s for TERMACK, then signal dead. */
  close(): void {
    if (this.dead) return
    this.ev.sendPpp(pppFrame(PPP_LCP, ncpPacket(TERMREQ, this.nextId, new Uint8Array(0))))
    this.nextId = (this.nextId + 1) & 0xff || 1
    this.termWait = setTimeout(() => this.kill("closed"), TERM_WAIT_MS)
  }

  private kill(reason: string): void {
    if (this.dead) return
    this.dead = true
    if (this.retransmitTimer) { clearTimeout(this.retransmitTimer); this.retransmitTimer = null }
    if (this.dpdTimer) { clearInterval(this.dpdTimer); this.dpdTimer = null }
    if (this.termWait) { clearTimeout(this.termWait); this.termWait = null }
    this.log(`ppp dead: ${reason}`)
    this.ev.onDead(reason)
  }

  destroy(): void {
    this.dead = true
    if (this.retransmitTimer) { clearTimeout(this.retransmitTimer); this.retransmitTimer = null }
    if (this.dpdTimer) { clearInterval(this.dpdTimer); this.dpdTimer = null }
    if (this.termWait) { clearTimeout(this.termWait); this.termWait = null }
  }
}

// -- small helpers ---------------------------------------------------------

const u32 = (a: Uint8Array, i: number) => ((a[i]! << 24) | (a[i + 1]! << 16) | (a[i + 2]! << 8) | a[i + 3]!) >>> 0

function u16be(n: number): Uint8Array {
  return new Uint8Array([(n >> 8) & 0xff, n & 0xff])
}

function u32be(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff])
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

function ipv4Str(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
}

function parseIpv4(s: string): Uint8Array {
  const parts = s.split(".").map(Number)
  return new Uint8Array(parts.map((n) => n & 0xff))
}
