/**
 * A virtual Fortinet SSL-VPN peer for PPP tests: implements the server side of
 * the LCP/IPCP dance per docs/fortinet-protocol.md. Feeds/receives complete PPP
 * frames (the 0x5050 tunnel framing is exercised separately in the framing
 * tests).
 */
import {
  CONFACK, CONFNAK, CONFREQ, ECHOREP, ECHOREQ,
  PPP_IP, PPP_LCP, PPP_IPCP,
  type PppConfig,
  parsePpp,
  pppFrame,
} from "../../src/daemon/vpn/ppp"

const u16 = (a: Uint8Array, i: number) => (a[i]! << 8) | a[i + 1]!
const u32 = (a: Uint8Array, i: number) => ((a[i]! << 24) | (a[i + 1]! << 16) | (a[i + 2]! << 8) | a[i + 3]!) >>> 0

type Tlv = { tag: number; data: Uint8Array }

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

function tlvBytes(tag: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + data.length)
  out[0] = tag
  out[1] = 2 + data.length
  out.set(data, 2)
  return out
}

function ncpPacket(code: number, id: number, options: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + options.length)
  out[0] = code
  out[1] = id
  const len = 4 + options.length
  out[2] = len >> 8
  out[3] = len & 0xff
  out.set(options, 4)
  return out
}

function ipv4Bytes(s: string): Uint8Array {
  return new Uint8Array(s.split(".").map((n) => Number(n) & 0xff))
}

function ipv4Str(b: Uint8Array): string {
  return `${b[0]}.${b[1]}.${b[2]}.${b[3]}`
}

export type VirtualFortiOptions = {
  innerIp?: string
  dns?: string[]
  serverMru?: number
  /** Delay CONFACKs (tests retransmit). */
  swallowConfAckIds?: number[]
}

export class VirtualForti {
  readonly framesToClient: Uint8Array[] = []
  readonly ipFromClient: Uint8Array[] = []
  established = false
  clientMru = 0
  clientMagic: number | null = null
  echoReplies = 0

  private nextId = 1
  private magic = 0x12345678
  private ipcpStage = 0 // 0: awaiting first req, 1: awaiting final req

  constructor(
    readonly opts: VirtualFortiOptions = {},
    private readonly deliver: (frame: Uint8Array) => void = () => {}, // to the PppSession
  ) {}

  /** The PppSession's outbound frame. */
  receive(frame: Uint8Array): void {
    const p = parsePpp(frame)
    if (!p) return
    if (p.proto === PPP_IP) {
      this.ipFromClient.push(p.payload)
      return
    }
    if (p.proto !== PPP_LCP && p.proto !== PPP_IPCP) return
    const code = p.payload[0]!
    const id = p.payload[1]!
    const body = p.payload.slice(4)
    if (p.proto === PPP_LCP) this.receiveLcp(code, id, body)
    else this.receiveIpcp(code, id, body)
  }

  private receiveLcp(code: number, id: number, body: Uint8Array): void {
    switch (code) {
      case CONFREQ: {
        const tlvs = parseTlvs(body)
        for (const t of tlvs) {
          if (t.tag === 1 && t.data.length === 2) this.clientMru = u16(t.data, 0)
          if (t.tag === 5 && t.data.length === 4) this.clientMagic = u32(t.data, 0)
        }
        if (this.opts.swallowConfAckIds?.includes(id)) return // simulate loss
        // CONFACK the client's request verbatim
        this.deliver(pppFrame(PPP_LCP, ncpPacket(CONFACK, id, body)))
        // then make our own request (MRU + magic), like the real server
        const opts = [
          tlvBytes(1, new Uint8Array([(this.opts.serverMru ?? 1350) >> 8, (this.opts.serverMru ?? 1350) & 0xff])),
          tlvBytes(5, new Uint8Array([0x12, 0x34, 0x56, 0x78])),
        ]
        this.deliver(pppFrame(PPP_LCP, ncpPacket(CONFREQ, this.nextId, concat(opts))))
        this.nextId = (this.nextId + 1) & 0xff || 1
        return
      }
      case CONFACK:
        // server's own CONFREQ acked — with both sides acked, LCP is open.
        // Real servers then send their own IPCP CONFREQ; the client must ack it.
        this.deliver(pppFrame(PPP_IPCP, ncpPacket(CONFREQ, this.nextId, concat([
          tlvBytes(3, ipv4Bytes("10.7.0.1")),
        ]))))
        this.nextId = (this.nextId + 1) & 0xff || 1
        return
      case ECHOREQ: {
        this.echoReplies++
        this.deliver(pppFrame(PPP_LCP, ncpPacket(ECHOREP, id, new Uint8Array([0x12, 0x34, 0x56, 0x78]))))
        return
      }
      default: return
    }
  }

  private receiveIpcp(code: number, id: number, body: Uint8Array): void {
    switch (code) {
      case CONFREQ: {
        const tlvs = parseTlvs(body)
        const ipOpt = tlvs.find((t) => t.tag === 3)
        const zeroIp = ipOpt && ipOpt.data.every((b) => b === 0)
        if (zeroIp && this.ipcpStage === 0) {
          // NAK with the assigned values
          const ip = this.opts.innerIp ?? "10.7.0.123"
          const dns = this.opts.dns ?? ["132.230.1.1", "132.230.2.2"]
          const opts = [
            tlvBytes(3, ipv4Bytes(ip)),
            tlvBytes(129, ipv4Bytes(dns[0]!)),
            tlvBytes(131, ipv4Bytes(dns[1] ?? dns[0]!)),
          ]
          this.ipcpStage = 1
          this.deliver(pppFrame(PPP_IPCP, ncpPacket(CONFNAK, id, concat(opts))))
          return
        }
        // final request with real values → CONFACK → established
        this.deliver(pppFrame(PPP_IPCP, ncpPacket(CONFACK, id, body)))
        this.markEstablished()
        return
      }
      default: return
    }
  }

  private markEstablished(): void {
    if (this.established) return
    this.established = true
  }

  /** Server pushes an IPv4 datagram to the client. */
  sendIp(datagram: Uint8Array): void {
    this.deliver(pppFrame(PPP_IP, datagram))
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const p of parts) { out.set(p, off); off += p.length }
  return out
}

export type { PppConfig }
