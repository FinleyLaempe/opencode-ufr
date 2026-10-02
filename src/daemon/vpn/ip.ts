/**
 * Minimal IPv4 layer for the userspace VPN stack.
 *
 * The stack only ever makes outbound TCP connections to a single known host
 * (openwebui.uni-freiburg.de) through a point-to-point tunnel, so this layer
 * deliberately supports just what TCP over that tunnel needs: build IPv4
 * datagrams for TCP segments, parse inbound ones, and hand TCP payloads to the
 * connection state machine. No fragmentation, no options we do not set, no ICMP.
 */

export const IPPROTO_TCP = 6

export type Ipv4 = number // address as a Uint32, e.g. 0x0a0101

export function ipv4ToString(ip: Ipv4): string {
  return [ip >>> 24, (ip >>> 16) & 0xff, (ip >>> 8) & 0xff, ip & 0xff].join(".")
}

export function ipv4Parse(s: string): Ipv4 {
  const parts = s.split(".")
  if (parts.length !== 4) throw new Error(`not an IPv4 address: ${s}`)
  let ip = 0
  for (const p of parts) {
    const n = Number(p)
    if (!Number.isInteger(n) || n < 0 || n > 255) throw new Error(`not an IPv4 address: ${s}`)
    ip = (ip << 8) | n
  }
  return ip >>> 0
}

const u16 = (a: Uint8Array, i: number) => (a[i]! << 8) | a[i + 1]!
const u32 = (a: Uint8Array, i: number) => ((a[i]! << 24) | (a[i + 1]! << 16) | (a[i + 2]! << 8) | a[i + 3]!) >>> 0

/** Header checksum as defined by RFC 768/791: ones' complement of the ones' complement sum. */
export function checksum(data: Uint8Array, start = 0, end = data.length): number {
  let sum = 0
  for (let i = start; i + 1 < end; i += 2) sum += u16(data, i)
  if (end - start > 0 && (end - start) % 2 === 1) sum += data[end - 1]! << 8
  while (sum > 0xffff) sum = (sum & 0xffff) + (sum >> 16)
  return (~sum) & 0xffff
}

export type TcpHeader = {
  srcPort: number
  dstPort: number
  seq: number
  ack: number
  dataOffset: number // bytes from TCP header start to payload
  flags: number
  window: number
}

export const FIN = 0x01
export const SYN = 0x02
export const RST = 0x04
export const PSH = 0x08
export const ACK = 0x10

export const FLAG_NAMES: [number, string][] = [
  [SYN, "SYN"], [ACK, "ACK"], [FIN, "FIN"], [RST, "RST"], [PSH, "PSH"],
]
export function flagsToString(f: number): string {
  return FLAG_NAMES.filter(([bit]) => f & bit).map(([, name]) => name).join("|") || "0"
}

const TCP_HEADER_LEN = 20

export type TcpSegment = { header: TcpHeader; payload: Uint8Array; options?: Uint8Array }

/**
 * Builds a full IPv4+TCP datagram. `segment.header.dataOffset` says how many
 * header bytes to write (20 for a bare header, more for options); the payload
 * length must fit in what the dataOffset promises.
 */
export function buildDatagram(o: {
  src: Ipv4
  dst: Ipv4
  segment: TcpSegment
  ttl?: number
  ident?: number
}): Uint8Array {
  const { segment } = o
  const total = 20 + segment.header.dataOffset + segment.payload.length
  const pkt = new Uint8Array(total)
  const v = pkt
  v[0] = 0x40 | (20 >> 2) // version 4, IHL 5 (no IP options)
  v[1] = 0 // DSCP/ECN
  v[2] = total >> 8
  v[3] = total & 0xff
  const ident = (o.ident ?? 0) & 0xffff
  v[4] = ident >> 8
  v[5] = ident & 0xff
  v[6] = 0x40 // don't fragment
  v[7] = 0 // fragment offset 0
  v[8] = o.ttl ?? 64
  v[9] = IPPROTO_TCP
  // source/destination
  v[12] = o.src >>> 24; v[13] = (o.src >>> 16) & 0xff; v[14] = (o.src >>> 8) & 0xff; v[15] = o.src & 0xff
  v[16] = o.dst >>> 24; v[17] = (o.dst >>> 16) & 0xff; v[18] = (o.dst >>> 8) & 0xff; v[19] = o.dst & 0xff
  // header checksum over the 20 IP header bytes with the checksum field zero
  v[10] = 0
  v[11] = 0
  const csum = checksum(v, 0, 20)
  v[10] = csum >> 8
  v[11] = csum & 0xff
  // TCP header
  const t = segment.header
  const off = 20
  v[off] = t.srcPort >> 8
  v[off + 1] = t.srcPort & 0xff
  v[off + 2] = t.dstPort >> 8
  v[off + 3] = t.dstPort & 0xff
  v[off + 4] = (t.seq >>> 24) & 0xff; v[off + 5] = (t.seq >>> 16) & 0xff; v[off + 6] = (t.seq >>> 8) & 0xff; v[off + 7] = t.seq & 0xff
  v[off + 8] = (t.ack >>> 24) & 0xff; v[off + 9] = (t.ack >>> 16) & 0xff; v[off + 10] = (t.ack >>> 8) & 0xff; v[off + 11] = t.ack & 0xff
  v[off + 12] = t.dataOffset << 2
  v[off + 13] = t.flags
  v[off + 14] = t.window >> 8
  v[off + 15] = t.window & 0xff
  // checksum + urgent pointer (we never send urgent data)
  v[off + 16] = 0
  v[off + 17] = 0
  v[off + 18] = 0
  v[off + 19] = 0
  // TCP options live inside the header region (dataOffset = 20 + options.length)
  if (segment.options && segment.options.length > 0) {
    if (segment.header.dataOffset !== 20 + segment.options.length) {
      throw new Error(`dataOffset ${segment.header.dataOffset} does not match options length ${segment.options.length}`)
    }
    v.set(segment.options, off + 20)
  }
  v.set(segment.payload, off + segment.header.dataOffset)
  // TCP pseudo-header checksum (RFC 9293) over header (incl. options) + payload
  const pseudo = new Uint8Array(12 + segment.header.dataOffset + segment.payload.length)
  pseudo[0] = o.src >>> 24; pseudo[1] = (o.src >>> 16) & 0xff; pseudo[2] = (o.src >>> 8) & 0xff; pseudo[3] = o.src & 0xff
  pseudo[4] = o.dst >>> 24; pseudo[5] = (o.dst >>> 16) & 0xff; pseudo[6] = (o.dst >>> 8) & 0xff; pseudo[7] = o.dst & 0xff
  pseudo[8] = 0
  pseudo[9] = IPPROTO_TCP
  pseudo[10] = (segment.header.dataOffset + segment.payload.length) >> 8
  pseudo[11] = (segment.header.dataOffset + segment.payload.length) & 0xff
  pseudo.set(v.subarray(off, off + segment.header.dataOffset + segment.payload.length), 12)
  const tcsum = checksum(pseudo)
  v[off + 16] = tcsum >> 8
  v[off + 17] = tcsum & 0xff
  return pkt
}

/** Parses an inbound IPv4 datagram; returns null for anything that is not a TCP segment for us. */
export function parseDatagram(pkt: Uint8Array): { src: Ipv4; dst: Ipv4; segment: TcpSegment } | null {
  if (pkt.length < 40) return null
  if (pkt[0]! >> 4 !== 4) return null
  const ihl = (pkt[0]! & 0x0f) * 4
  if (ihl < 20 || pkt.length < ihl + 20) return null
  if (pkt[9] !== IPPROTO_TCP) return null
  const src = u32(pkt, 12)
  const dst = u32(pkt, 16)
  const off = ihl
  const dataOffset = (pkt[off + 12]! >> 4) * 4
  if (dataOffset < 20 || pkt.length < off + dataOffset) return null
  return {
    src,
    dst,
    segment: {
      header: {
        srcPort: u16(pkt, off),
        dstPort: u16(pkt, off + 2),
        seq: u32(pkt, off + 4),
        ack: u32(pkt, off + 8),
        dataOffset,
        flags: pkt[off + 13]!,
        window: u16(pkt, off + 14),
      },
      payload: pkt.subarray(off + dataOffset),
      options: dataOffset > 20 ? pkt.subarray(off + 20, off + dataOffset) : undefined,
    },
  }
}
