/**
 * The userspace TCP/IP stack: owns the inner IP the tunnel was assigned,
 * demultiplexes inbound IPv4/TCP datagrams to connections and dials out.
 *
 * One stack per tunnel. Only outbound connections to a single remote host are
 * needed (the gateway daemon's upstream calls), so the connection table is
 * keyed by (remotePort, localPort).
 */

import { type Ipv4, buildDatagram, parseDatagram } from "./ip"
import { TcpConn, freshLocalPort, type TcpOptions } from "./tcp"

export type PacketSink = (pkt: Uint8Array) => void

export type StreamHandlers = {
  open?(): void
  data(chunk: Uint8Array): void
  drain?(): void
  close(hadError: boolean): void
}

export type VpnStream = {
  /** Queue bytes; returns the number of bytes still buffered (0 = drained). */
  write(data: Uint8Array): number
  /** Graceful close after buffered data drains. */
  end(): void
  /** Abort. */
  destroy(): void
}

export class TcpStack {
  private local: Ipv4
  private conns = new Map<string, TcpConn>()

  constructor(
    o: { local: Ipv4; sink: PacketSink; opts?: TcpOptions },
    private readonly log: (msg: string) => void = () => {},
  ) {
    this.local = o.local
    this.opts = o.opts ?? {}
    // Deferring the sink to a microtask makes the wire asynchronous: a send
    // during dial()/flush() can never re-enter the same connection mid-call
    // (the tunnel round trip would otherwise run inside sendSegment).
    this.sink = (pkt) => queueMicrotask(() => o.sink(pkt))
  }

  private opts: TcpOptions
  private sink: PacketSink

  /** Called once IPCP has assigned the tunnel's inner address. */
  setLocal(ip: Ipv4): void {
    this.local = ip
  }

  get innerIp(): Ipv4 {
    return this.local
  }

  get openCount(): number {
    return this.conns.size
  }

  /** Outbound connection. Returns a stream handle; handlers fire as the connection progresses. */
  dial(remote: Ipv4, remotePort: number, h: StreamHandlers): VpnStream {
    if (this.local === 0) throw new Error("tcp stack has no inner address yet (tunnel not established)")
    let localPort = freshLocalPort()
    for (let i = 0; this.conns.has(`${remotePort}:${localPort}`) && i < 100; i++) localPort = freshLocalPort()
    const key = `${remotePort}:${localPort}`
    let conn: TcpConn
    let closed = false
    conn = new TcpConn(
      { local: this.local, remote, localPort, remotePort },
      (pkt) => this.sink(pkt),
      {
        onOpen: () => h.open?.(),
        onData: (_c, data) => h.data(data),
        onDrain: () => h.drain?.(),
        onClose: (c, err) => {
          closed = true
          this.conns.delete(key)
          h.close(err)
          this.log(`tcp ${key} closed${err ? " (error)" : ""}`)
        },
      },
      this.opts,
    )
    this.conns.set(key, conn)
    this.log(`tcp dial ${key} from ${this.local}`)
    conn.dial()
    return {
      write: (data) => {
        if (closed) return 0
        try {
          return conn.write(data)
        } catch {
          return 0
        }
      },
      end: () => {
        try { conn.fin() } catch { /* already closing */ }
      },
      destroy: () => conn.reset(),
    }
  }

  /** Feed one datagram received from the tunnel. */
  receive(pkt: Uint8Array): void {
    const parsed = parseDatagram(pkt)
    if (!parsed) return
    if (parsed.dst !== this.local) return
    const conn = this.conns.get(`${parsed.segment.header.srcPort}:${parsed.segment.header.dstPort}`)
    if (!conn) {
      // no listener: answer RST unless the segment is itself a RST or a bare ACK
      const f = parsed.segment.header.flags
      if (!(f & 0x04) && !(f & 0x10 && parsed.segment.payload.length === 0)) {
        const seg = {
          header: {
            srcPort: parsed.segment.header.dstPort,
            dstPort: parsed.segment.header.srcPort,
            seq: 0,
            ack: parsed.segment.header.seq,
            dataOffset: 20,
            flags: 0x04, // RST
            window: 0,
          },
          payload: new Uint8Array(0),
        }
        this.sink(buildDatagram({ src: this.local, dst: parsed.src, segment: seg }))
      }
      return
    }
    conn.receive(parsed.segment)
  }

  /** Tear everything down (tunnel is going away). */
  closeAll(): void {
    for (const c of this.conns.values()) c.reset()
    this.conns.clear()
  }
}
