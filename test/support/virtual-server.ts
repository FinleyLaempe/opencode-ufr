/**
 * A virtual TCP server for stack tests: the server side of the handshake,
 * data exchange and teardown, speaking the same wire format (ip.ts). Drives a
 * TcpStack directly — no network involved. Deliberately minimal: no timers,
 * no retransmit of its own (loss scenarios are driven manually by the test).
 */
import {
  ACK, FIN, PSH, RST, SYN,
  type Ipv4,
  type TcpSegment,
  buildDatagram,
  parseDatagram,
} from "../../src/daemon/vpn/ip"

export class VirtualServerConn {
  established = false
  peerClosed = false
  received: Uint8Array[] = []
  /** Data segments we sent that the client has not acked yet (for loss tests). */
  unackedData: { seq: number; bytes: Uint8Array }[] = []
  private seq: number
  private rcvNext = 0
  private finSent = false
  private dead = false

  constructor(
    readonly client: Ipv4,
    readonly server: Ipv4,
    readonly clientPort: number,
    readonly serverPort: number,
    private readonly sendPkt: (pkt: Uint8Array) => void,
    private readonly onDead: () => void,
  ) {
    this.seq = (Math.floor(Math.random() * 0x7fffffff) | 1) >>> 0
  }

  get totalReceived(): Uint8Array {
    const total = this.received.reduce((n, d) => n + d.length, 0)
    const out = new Uint8Array(total)
    let off = 0
    for (const d of this.received) { out.set(d, off); off += d.length }
    return out
  }

  get dataReceived(): string {
    return new TextDecoder().decode(this.totalReceived)
  }

  /** Server accepts: reply SYN-ACK (MSS 1400) for the client's SYN. */
  accept(syn: TcpSegment): void {
    this.rcvNext = (syn.header.seq + 1) >>> 0
    const opts = new Uint8Array(4)
    opts[0] = 2; opts[1] = 4; opts[2] = 0x05; opts[3] = 0x78 // MSS 1400
    const seg: TcpSegment = {
      header: {
        srcPort: this.serverPort,
        dstPort: this.clientPort,
        seq: this.seq,
        ack: this.rcvNext,
        dataOffset: 24,
        flags: SYN | ACK,
        window: 65535,
      },
      payload: new Uint8Array(0),
      options: opts,
    }
    this.sendPkt(buildDatagram({ src: this.server, dst: this.client, segment: seg }))
    this.seq = (this.seq + 1) >>> 0
    this.established = true
  }

  private send(partial: Partial<TcpSegment["header"]>, payload: Uint8Array): void {
    const seg: TcpSegment = {
      header: {
        srcPort: this.serverPort,
        dstPort: this.clientPort,
        seq: this.seq,
        ack: this.rcvNext,
        dataOffset: 20,
        flags: 0,
        window: 65535,
        ...partial,
      },
      payload,
    }
    this.sendPkt(buildDatagram({ src: this.server, dst: this.client, segment: seg }))
  }

  write(data: Uint8Array): void {
    if (this.dead || !this.established || this.finSent) return
    this.send({ flags: ACK | PSH }, data)
    this.unackedData.push({ seq: this.seq, bytes: data })
    this.seq = (this.seq + data.length) >>> 0
  }

  /** Server closes gracefully (after its data is written). */
  fin(): void {
    if (this.dead || this.finSent) return
    this.finSent = true
    this.send({ flags: FIN | ACK }, new Uint8Array(0))
    this.seq = (this.seq + 1) >>> 0
  }

  /** Resend one previously sent data segment (loss test helper). */
  retransmit(entry: { seq: number; bytes: Uint8Array }): void {
    this.send({ flags: ACK | PSH, seq: entry.seq }, entry.bytes)
  }

  receive(seg: TcpSegment): void {
    if (this.dead) return
    const f = seg.header.flags
    if (f & RST) { this.dead = true; this.onDead(); return }
    if (f & ACK) {
      // forget fully acked data
      this.unackedData = this.unackedData.filter((e) => (e.seq + e.bytes.length) > seg.header.ack)
      if (this.finSent && this.unackedData.length === 0 && seg.header.ack === this.seq && this.peerClosed) {
        this.dead = true
        this.onDead()
      }
    }
    if (f & FIN) {
      this.peerClosed = true
      if (seg.payload.length > 0 && seg.header.seq === this.rcvNext) {
        this.received.push(seg.payload)
        this.rcvNext = (this.rcvNext + seg.payload.length) >>> 0
      }
      this.rcvNext = (this.rcvNext + 1) >>> 0
      this.send({ flags: ACK }, new Uint8Array(0))
      if (this.finSent) { this.dead = true; this.onDead() }
      return
    }
    if (seg.payload.length > 0) {
      if (seg.header.seq === this.rcvNext) {
        this.rcvNext = (this.rcvNext + seg.payload.length) >>> 0
        this.received.push(seg.payload)
        this.send({ flags: ACK }, new Uint8Array(0))
      } else if (seg.header.seq + seg.payload.length <= this.rcvNext) {
        this.send({ flags: ACK }, new Uint8Array(0)) // dup ack for old data
      }
    }
  }
}

/** The peer's half of the wire: feeds datagrams to the stack, receives ours. */
export class VirtualServer {
  readonly conns = new Map<number, VirtualServerConn>() // by client port

  constructor(
    readonly serverIp: Ipv4,
    readonly serverPort: number,
    private readonly deliver: (pkt: Uint8Array) => void, // to the TcpStack
    private readonly onNewConn?: (conn: VirtualServerConn) => void,
  ) {}

  /** A datagram from the stack. */
  receive(pkt: Uint8Array): void {
    const parsed = parseDatagram(pkt)
    if (!parsed || parsed.dst !== this.serverIp || parsed.segment.header.dstPort !== this.serverPort) return
    const seg = parsed.segment
    let conn = this.conns.get(seg.header.srcPort)
    if (!conn) {
      if (!(seg.header.flags & SYN)) return
      conn = new VirtualServerConn(
        parsed.src, this.serverIp, seg.header.srcPort, this.serverPort,
        (p) => this.deliver(p),
        () => this.conns.delete(seg.header.srcPort),
      )
      this.conns.set(seg.header.srcPort, conn)
      conn.accept(seg)
      this.onNewConn?.(conn)
      return
    }
    conn.receive(seg)
  }
}
