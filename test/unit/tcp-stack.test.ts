import { describe, expect, test } from "bun:test"
import { ACK, FIN, PSH, RST, SYN, buildDatagram, checksum, flagsToString, ipv4Parse, parseDatagram } from "../../src/daemon/vpn/ip"
import { TcpStack } from "../../src/daemon/vpn/stack"
import { VirtualServer, type VirtualServerConn } from "../support/virtual-server"

const CLIENT = ipv4Parse("10.7.0.2")
const SERVER = ipv4Parse("132.230.100.48")
const PORT = 443

type Rig = {
  stack: TcpStack
  server: VirtualServer
  serverConn: () => VirtualServerConn
}

/** Wire both ends together: stack → server → stack. */
function rig(): Rig {
  const server = new VirtualServer(SERVER, PORT, (pkt) => stack.receive(pkt))
  const stack = new TcpStack({ local: CLIENT, sink: (pkt) => server.receive(pkt) }, () => {})
  return {
    stack,
    server,
    serverConn: () => {
      const c = server.conns.values().next().value
      if (!c) throw new Error("no server connection")
      return c
    },
  }
}

function dial(stack: TcpStack) {
  const events = { open: false, data: "", close: null as boolean | null }
  let stream: ReturnType<TcpStack["dial"]> | null = null
  const opened = new Promise<void>((res) => {
    stream = stack.dial(SERVER, PORT, {
      open: () => {
        events.open = true
        res()
      },
      data: (d) => { events.data += new TextDecoder().decode(d) },
      close: (err) => { events.close = err },
    })
  })
  return { opened, events, stream: stream! }
}

async function until(fn: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("userspace TCP stack", () => {
  test("handshake, echo round trip, clean FIN both ways", async () => {
    const { stack, serverConn } = rig()
    const d = dial(stack)
    await d.opened
    expect(d.events.open).toBe(true)

    d.stream.write(new TextEncoder().encode("hello over the tunnel"))
    await until(() => serverConn().dataReceived === "hello over the tunnel")
    serverConn().write(new TextEncoder().encode("hi, tunnel here"))
    await until(() => d.events.data === "hi, tunnel here")

    serverConn().fin() // server closes first
    d.stream.end() // client follows
    await until(() => d.events.close === false)
    expect(d.events.close).toBe(false)
  })

  test("large transfer is sliced to the announced MSS and reassembled in order", async () => {
    const { stack, serverConn } = rig()
    const d = dial(stack)
    await d.opened
    const payload = "x".repeat(50_000)
    d.stream.write(new TextEncoder().encode(payload))
    await until(() => serverConn().dataReceived.length === payload.length)
    expect(serverConn().dataReceived).toBe(payload)
    expect(serverConn().received.every((c) => c.length <= 1360)).toBe(true)
  })

  test("server push + server FIN closes the stream without error", async () => {
    const { stack, serverConn } = rig()
    const d = dial(stack)
    await d.opened
    serverConn().write(new TextEncoder().encode("goodbye"))
    serverConn().fin()
    await until(() => d.events.data === "goodbye" && d.events.close !== null)
    expect(d.events.close).toBe(false)
  })

  test("RST from the server surfaces as an errored close", async () => {
    const { stack, serverConn } = rig()
    const d = dial(stack)
    await d.opened
    const rst = {
      header: {
        srcPort: PORT, dstPort: serverConn().clientPort,
        seq: 0, ack: 0, dataOffset: 20, flags: RST, window: 0,
      },
      payload: new Uint8Array(0),
    }
    stack.receive(buildDatagram({ src: SERVER, dst: CLIENT, segment: rst }))
    await until(() => d.events.close !== null)
    expect(d.events.close).toBe(true)
  })

  test("out-of-order data is dropped with a duplicate ACK, then completed by retransmit", async () => {
    // manual rig so the test controls the wire order server → stack
    const wire: Uint8Array[] = []
    const server = new VirtualServer(SERVER, PORT, (p) => wire.push(p))
    const stack = new TcpStack({ local: CLIENT, sink: (p) => server.receive(p) }, () => {})
    const events = { data: "", close: null as boolean | null }
    const opened = new Promise<void>((res) => {
      stack.dial(SERVER, PORT, {
        open: () => res(),
        data: (d) => { events.data += new TextDecoder().decode(d) },
        close: (e) => { events.close = e },
      })
    })
    // handshake: SYN-ACK lands on the controlled wire; feed it back ourselves
    await until(() => wire.length >= 1)
    stack.receive(wire[0]!)
    await opened

    const enc = new TextEncoder()
    const conn = server.conns.values().next().value!
    conn.write(enc.encode("AAAA"))
    conn.write(enc.encode("BBBB"))
    // wire now holds [synack, dataA, dataB]; take the two data segments
    const dataSegs = wire.slice(1)
      .map((p) => parseDatagram(p)!)
      .filter((x) => x && x.segment.payload.length > 0)
    expect(dataSegs.length).toBe(2)
    // deliver them swapped: B first (gap!), then A
    stack.receive(buildDatagram({ src: SERVER, dst: CLIENT, segment: dataSegs[1]!.segment }))
    stack.receive(buildDatagram({ src: SERVER, dst: CLIENT, segment: dataSegs[0]!.segment }))
    await until(() => events.data === "AAAA") // A arrived; B was dropped on the gap
    // server still has B unacked → retransmit it; the retransmit lands on the
    // controlled wire too, so feed it through
    const b = conn.unackedData.find((e) => new TextDecoder().decode(e.bytes) === "BBBB")!
    conn.retransmit(b)
    await until(() => wire.length >= 4)
    stack.receive(wire[wire.length - 1]!)
    await until(() => events.data === "AAAABBBB")
    expect(events.close).toBeNull()
  })

  test("a black-hole peer is given up on after the retransmit budget", async () => {
    const sent: Uint8Array[] = []
    const stack = new TcpStack({ local: CLIENT, sink: (p) => sent.push(p), opts: { rtoMs: 30, maxRetransmits: 6 } }, () => {})
    const events = { close: null as boolean | null }
    stack.dial(SERVER, PORT, { data: () => {}, close: (e) => { events.close = e } })
    await until(() => sent.length >= 1) // SYN on the wire
    await until(() => events.close !== null, 9000) // SYN retransmits, then error close
    expect(events.close).toBe(true)
    expect(sent.length).toBeGreaterThanOrEqual(6) // initial SYN + retransmits
  }, 12_000)

  test("wire format: the SYN carries MSS option and correct header fields", async () => {
    const sent: Uint8Array[] = []
    const stack = new TcpStack({ local: CLIENT, sink: (p) => sent.push(p) }, () => {})
    stack.dial(SERVER, PORT, { data: () => {}, close: () => {} })
    await until(() => sent.length >= 1)
    const parsed = parseDatagram(sent[0]!)
    expect(parsed).not.toBeNull()
    expect(parsed!.src).toBe(CLIENT)
    expect(parsed!.dst).toBe(SERVER)
    expect(parsed!.segment.header.flags & SYN).toBe(SYN)
    expect(parsed!.segment.header.dstPort).toBe(PORT)
    expect(parsed!.segment.options).toBeDefined()
    expect(parsed!.segment.options![2]! << 8 | parsed!.segment.options![3]!).toBe(1360) // announced MSS
  })

  test("flagsToString renders the usual suspects", () => {
    expect(flagsToString(SYN | ACK)).toBe("SYN|ACK")
    expect(flagsToString(FIN | ACK | PSH)).toBe("ACK|FIN|PSH")
    expect(flagsToString(0)).toBe("0")
  })

  test("built datagrams carry valid IP and TCP checksums (regression: src/dst written after checksum)", () => {
    const pkt = buildDatagram({
      src: CLIENT, dst: SERVER,
      segment: {
        header: { srcPort: 40000, dstPort: 443, seq: 1, ack: 2, dataOffset: 24, flags: SYN | ACK, window: 1000 },
        payload: new Uint8Array(5),
        options: new Uint8Array([2, 4, 5, 0x50]),
      },
    })
    // IP header: checksum field included, the whole header must sum to zero
    expect(checksum(pkt.subarray(0, 20))).toBe(0)
    // TCP: pseudo-header (src, dst, zero, proto, tcp length) + tcp header + payload
    const tcpLen = pkt.length - 20
    const pseudo = new Uint8Array(12 + tcpLen)
    pseudo.set(pkt.subarray(12, 20), 0)
    pseudo[9] = 6
    pseudo[10] = tcpLen >> 8
    pseudo[11] = tcpLen & 0xff
    pseudo.set(pkt.subarray(20), 12)
    expect(checksum(pseudo)).toBe(0)
  })
})
