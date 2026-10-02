/**
 * A single userspace TCP connection: the client side of the three-way
 * handshake, data transfer, teardown — plus retransmission.
 *
 * Simplifications (fine for HTTPS through a tunnel to one known server):
 * - we only ever dial out, never accept
 * - inbound segments are processed in order; out-of-order data triggers a
 *   duplicate ACK so the peer retransmits (no reorder buffer)
 * - one retransmission timer per connection, exponential backoff, RST after
 *   too many failed retransmits
 * - the receive window is generous and inbound data is handed to the
 *   application immediately (TLS sockets drain fast; no app backpressure)
 */

import {
  ACK, FIN, PSH, RST, SYN,
  type Ipv4,
  type TcpSegment,
  buildDatagram,
} from "./ip"

export type TcpOptions = {
  mss?: number // max segment size we announce (fits the tunnel MTU)
  rtoMs?: number // initial retransmission timeout
  maxRetransmits?: number // give up (RST) after this many consecutive retransmits
}

export type ConnectionState =
  | "closed"
  | "syn-sent"
  | "established"
  | "fin-wait-1"
  | "fin-wait-2"
  | "time-wait"
  | "close-wait"
  | "last-ack"

export type DialInfo = { local: Ipv4; remote: Ipv4; localPort: number; remotePort: number }

/** What the stack hands to the application on this connection. */
export type TcpEvents = {
  onOpen?: (c: TcpConn) => void
  onData?: (c: TcpConn, data: Uint8Array) => void
  onDrain?: (c: TcpConn) => void
  onClose?: (c: TcpConn, hadError: boolean) => void
}

const DEFAULT_MSS = 1360 // fits a 1400-byte tunnel MTU with IP+TCP headers
const DEFAULT_RTO_MS = 500
const DEFAULT_MAX_RETRANSMITS = 6
const RECV_WINDOW = 65535
const CWND_START = 4 // segments in flight before the first ACK (slow start)
const CWND_MAX = 64

export function freshLocalPort(): number {
  return 32768 + Math.floor(Math.random() * 20000)
}

type QueueEntry = { seq: number; len: number; bytes: Uint8Array } // len counts SYN/FIN as 1

export class TcpConn {
  state: ConnectionState = "closed"
  readonly localPort: number

  private seq: number // next byte we will send (SND.NXT)
  private acked: number // last byte the peer acknowledged (SND.UNA)
  private rcvNext = 0 // next byte we expect from the peer (RCV.NXT)
  private peerWindow = 0
  private peerMss = 536
  private outQueue: QueueEntry[] = [] // not yet sent
  private flightQueue: QueueEntry[] = [] // sent, not yet acked (retransmit source)
  private earlyQueue: Uint8Array[] = [] // application data written while syn-sent
  private cwnd = CWND_START // congestion window in segments (slow start)
  private dupAcks = 0
  private finQueued = false
  private finSent = false
  private closeFired = false
  private peerFinSeen = false
  private retransmits = 0
  private rto: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private errored = false
  private dead = false

  constructor(
    readonly info: DialInfo,
    private readonly sendPkt: (pkt: Uint8Array) => void,
    private readonly events: TcpEvents,
    private readonly opts: TcpOptions,
  ) {
    this.localPort = info.localPort
    const isn = (Math.floor(Math.random() * 0x7fffffff) | 1) >>> 0
    this.seq = isn
    this.acked = isn
    this.rto = opts.rtoMs ?? DEFAULT_RTO_MS
  }

  // -- outbound ------------------------------------------------------------

  /** Start the connection (active open). */
  dial(): void {
    if (this.state !== "closed") throw new Error(`dial: connection is ${this.state}`)
    this.state = "syn-sent"
    const opts = new Uint8Array(4) // MSS option (kind 2, len 4)
    opts[0] = 2; opts[1] = 4
    opts[2] = (this.opts.mss ?? DEFAULT_MSS) >> 8
    opts[3] = (this.opts.mss ?? DEFAULT_MSS) & 0xff
    this.sendSegment({ flags: SYN }, new Uint8Array(0), 1, opts)
    this.seq = (this.seq + 1) >>> 0
    this.armRto()
  }

  /** Queue application data (sliced to fit the tunnel MTU and the peer's MSS). Returns buffered bytes now queued.
   *  Data written before the handshake completes is buffered and sent once established. */
  write(data: Uint8Array): number {
    if (this.state === "syn-sent") {
      this.earlyQueue.push(data)
      return this.earlyQueue.reduce((n, d) => n + d.length, 0)
    }
    if (this.state !== "established" && this.state !== "close-wait") throw new Error(`write: connection is ${this.state}`)
    if (this.finQueued) throw new Error("write after fin")
    for (const early of this.earlyQueue.splice(0)) this.writeEstablished(early)
    return this.writeEstablished(data)
  }

  private writeEstablished(data: Uint8Array): number {
    const segSize = Math.min(this.peerMss, this.opts.mss ?? DEFAULT_MSS)
    for (let i = 0; i < data.length; i += segSize) {
      this.outQueue.push({ seq: this.seq, len: 0, bytes: data.slice(i, i + segSize) })
      this.seq = (this.seq + Math.min(segSize, data.length - i)) >>> 0
    }
    this.flush()
    return this.buffered
  }

  /** Graceful close: FIN after queued data drains. */
  fin(): void {
    if (this.dead || this.finQueued) return
    this.finQueued = true
    this.flush()
  }

  /** Abort: RST and drop everything. */
  reset(): void {
    if (this.dead) return
    if (this.state !== "syn-sent" || this.rcvNext !== 0) {
      this.sendSegment({ flags: RST, ack: this.rcvNext }, new Uint8Array(0), 0)
    }
    this.finish()
  }

  get buffered(): number {
    return this.outQueue.reduce((n, e) => n + e.bytes.length, 0) + this.flightBytes()
  }

  // -- inbound -------------------------------------------------------------

  /** Feed one inbound segment (already parsed, addressed to this connection). */
  receive(seg: TcpSegment): void {
    if (this.dead) return
    const f = seg.header.flags

    if (f & RST) {
      this.errored = true
      this.finish()
      return
    }

    if (this.state === "syn-sent") {
      if (!(f & SYN)) return
      this.rcvNext = (seg.header.seq + 1) >>> 0
      this.peerWindow = seg.header.window || 1
      this.readMss(seg)
      if (f & ACK) {
        this.processAck(seg.header.ack, seg.header.window) // acks our SYN: drops it from the queue
        this.state = "established"
        this.events.onOpen?.(this)
        this.sendSegment({ flags: ACK }, new Uint8Array(0), 0)
        // application data may have been written while we were syn-sent
        if (this.earlyQueue.length > 0) {
          for (const early of this.earlyQueue.splice(0)) this.writeEstablished(early)
        } else {
          this.flush()
        }
      } else {
        // simultaneous open — reply SYN-ACK
        const opts = new Uint8Array(4)
        opts[0] = 2; opts[1] = 4
        opts[2] = (this.opts.mss ?? DEFAULT_MSS) >> 8
        opts[3] = (this.opts.mss ?? DEFAULT_MSS) & 0xff
        this.sendSegment({ flags: SYN | ACK }, new Uint8Array(0), 1, opts)
      }
      return
    }

    if (f & SYN) return // stray retransmitted SYN after handshake
    if (f & ACK) this.processAck(seg.header.ack, seg.header.window)

    // drop data we have already seen (retransmissions while our ACK was lost)
    const segEnd = (seg.header.seq + seg.payload.length + (f & FIN ? 1 : 0)) >>> 0
    if (segEnd <= this.rcvNext) return
    if (seg.header.seq !== this.rcvNext) {
      // gap: duplicate-ACK so the peer retransmits what we are missing
      this.sendSegment({ flags: ACK }, new Uint8Array(0), 0)
      return
    }

    if (seg.payload.length > 0) {
      this.rcvNext = (this.rcvNext + seg.payload.length) >>> 0
      this.events.onData?.(this, seg.payload)
      this.sendSegment({ flags: ACK }, new Uint8Array(0), 0) // ack the data
    }

    if (f & FIN) {
      this.rcvNext = (this.rcvNext + 1) >>> 0
      this.peerFinSeen = true
      this.sendSegment({ flags: ACK }, new Uint8Array(0), 0)
      if (this.state === "established" || this.state === "fin-wait-2") {
        const wasEstablished = this.state === "established"
        this.state = "close-wait"
        if (!wasEstablished) this.finish() // our FIN was already acked: done
        else this.fireClose(false) // peer closed first; app may still write, then fin()
      }
      return
    }

    this.flush()
  }

  // -- internals -----------------------------------------------------------

  private sendSegment(partial: Partial<TcpSegment["header"]>, payload: Uint8Array, queueLen: number, options?: Uint8Array): void {
    const header = {
      srcPort: this.info.localPort,
      dstPort: this.info.remotePort,
      seq: this.seq,
      ack: this.rcvNext,
      dataOffset: options ? 20 + options.length : 20,
      flags: 0,
      window: RECV_WINDOW,
      ...partial,
    }
    const seg: TcpSegment = { header, payload, options }
    const bytes = buildDatagram({ src: this.info.local, dst: this.info.remote, segment: seg })
    this.sendPkt(bytes)
    if (queueLen > 0) this.flightQueue.push({ seq: this.seq, len: queueLen, bytes }) // sent: tracks in flight
  }

  private flush(): void {
    let inFlight = this.flightBytes()
    let sent = false
    const limit = Math.min(Math.max(this.peerWindow, 1), this.cwnd * this.effMss())
    while (this.outQueue.length > 0) {
      const e = this.outQueue[0]!
      if (inFlight + e.bytes.length > limit) break
      const header = {
        srcPort: this.info.localPort,
        dstPort: this.info.remotePort,
        seq: e.seq,
        ack: this.rcvNext,
        dataOffset: 20,
        flags: ACK | PSH,
        window: RECV_WINDOW,
      }
      this.sendPkt(buildDatagram({ src: this.info.local, dst: this.info.remote, segment: { header, payload: e.bytes } }))
      inFlight += e.bytes.length
      sent = true
      this.flightQueue.push(this.outQueue.shift()!)
    }
    if (sent) this.armRto()
    if (this.finQueued && this.buffered === 0) this.maybeSendFin()
    if (this.buffered === 0) this.events.onDrain?.(this)
  }

  private effMss(): number {
    return Math.min(this.peerMss, this.opts.mss ?? DEFAULT_MSS)
  }

  private flightBytes(): number {
    return this.flightQueue.reduce((n, e) => n + e.bytes.length, 0)
  }

  private maybeSendFin(): void {
    if (this.finSent || this.flightQueue.some((e) => e.len > 0)) return // FIN already in flight
    this.finSent = true
    this.sendSegment({ flags: FIN | ACK }, new Uint8Array(0), 1)
    this.seq = (this.seq + 1) >>> 0
    if (this.state === "established") this.state = "fin-wait-1"
    else if (this.state === "close-wait") this.state = "last-ack"
    this.armRto()
  }

  private readMss(seg: TcpSegment): void {
    const opts = seg.options
    if (!opts) return
    let i = 0
    while (i < opts.length) {
      const kind = opts[i]!
      if (kind === 0) break // end of options
      const len = opts[i + 1] ?? 0
      if (len < 2 || i + len > opts.length) break
      if (kind === 2 && len === 4) this.peerMss = Math.max((opts[i + 2]! << 8) | opts[i + 3]!, 216)
      i += len
    }
  }

  private processAck(ack: number, window: number): void {
    if (window > 0) this.peerWindow = window
    const unacked = this.unacked
    const newly = (ack - this.acked) >>> 0
    if (newly === 0 || newly > unacked) {
      // duplicate ACK: the peer is missing something after `acked`
      if (unacked > 0 && ++this.dupAcks >= 3) {
        this.dupAcks = 0
        this.cwnd = Math.max(Math.floor(this.cwnd / 2), CWND_START) // multiplicative decrease
        const first = this.flightQueue[0]!
        if (first) this.sendPkt(first.bytes) // fast retransmit, no RTO wait
      }
      return
    }
    this.dupAcks = 0
    // slow start: one segment of window per acked segment, bounded by the peer window
    this.cwnd = Math.min(Math.ceil(this.cwnd + newly / this.effMss()), CWND_MAX)
    this.acked = ack
    this.retransmits = 0
    this.rto = this.opts.rtoMs ?? DEFAULT_RTO_MS
    // drop fully acknowledged entries from the flight queue
    while (this.flightQueue.length > 0) {
      const e = this.flightQueue[0]!
      if ((e.seq + e.len) >>> 0 > ack || (e.len === 0 && e.seq + e.bytes.length > ack)) break
      this.flightQueue.shift()
    }
    if (this.flightQueue.length === 0 && this.unacked === 0) {
      if (this.timer) { clearTimeout(this.timer); this.timer = null }
    }
    if (this.state === "fin-wait-1" && this.unacked === 0) this.state = "fin-wait-2"
    if (this.state === "last-ack" && this.unacked === 0) { this.finish(); return }
    this.flush()
  }

  get unacked(): number {
    return (this.seq - this.acked) >>> 0
  }

  private armRto(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.onRto(), this.rto)
    this.timer.unref?.()
  }

  private onRto(): void {
    this.timer = null
    if (this.dead || this.unacked === 0) return
    this.retransmits++
    if (this.retransmits >= (this.opts.maxRetransmits ?? DEFAULT_MAX_RETRANSMITS)) {
      this.errored = true
      this.finish()
      return
    }
    this.rto = Math.min(this.rto * 2, 5_000)
    this.cwnd = CWND_START // collapse the window: the burst was too much
    this.dupAcks = 0
    // true go-back-N: resend EVERY unacked segment, not just the first —
    // a burst can lose several at once, one-per-RTO would never recover
    for (const e of this.flightQueue) {
      this.sendPkt(e.bytes)
    }
    this.armRto()
  }

  private fireClose(hadError: boolean): void {
    if (this.closeFired) return
    this.closeFired = true
    this.events.onClose?.(this, hadError)
  }

  private finish(): void {
    if (this.dead) return
    this.dead = true
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.state = "closed"
    this.fireClose(this.errored)
  }
}
