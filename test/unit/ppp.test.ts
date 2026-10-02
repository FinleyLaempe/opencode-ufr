import { describe, expect, test } from "bun:test"
import { PPP_IP, PPP_LCP, PppSession, parsePpp, pppFrame, type PppConfig } from "../../src/daemon/vpn/ppp"
import { parseDatagram, buildDatagram, ipv4Parse } from "../../src/daemon/vpn/ip"
import { VirtualForti, type VirtualFortiOptions } from "../support/virtual-fortinet"

/** Wire a PppSession to a VirtualForti over the 0x5050 framing. */
function rig(o: VirtualFortiOptions = {}) {
  const frames: Uint8Array[] = []
  const forti = new VirtualForti(o, (frame) => {
    frames.push(frame)
    ppp.receive(frame)
  })
  const events: { established: PppConfig | null; dead: string[]; ipIn: Uint8Array[] } = {
    established: null, dead: [], ipIn: [],
  }
  const ppp = new PppSession({
    sendPpp: (frame) => forti.receive(frame),
    onIp: (d) => events.ipIn.push(d),
    onEstablished: (cfg) => { events.established = cfg },
    onDead: (r) => events.dead.push(r),
  }, { dpdS: 1, log: () => {} })
  return { ppp, forti, events, frames }
}

async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("PPP session over a virtual Fortinet", () => {
  test("a dead link drops outgoing IP instead of throwing (regression: the daemon crashed when the user's own VPN toggled)", async () => {
    // The manager's onDead tears the TCP stack down, and resetting an established
    // connection sends an RST into the link that just died — from inside a timer.
    const rst = buildDatagram({
      src: ipv4Parse("10.7.0.2"), dst: ipv4Parse("132.230.100.48"),
      segment: { header: { srcPort: 40000, dstPort: 443, seq: 1, ack: 1, dataOffset: 20, flags: 0x04, window: 0 }, payload: new Uint8Array(0) },
    })
    let died = false
    let thrown: unknown = null
    const forti = new VirtualForti({}, (frame) => ppp.receive(frame))
    const ppp = new PppSession({
      sendPpp: (frame) => forti.receive(frame),
      onIp: () => {},
      onEstablished: () => {},
      onDead: () => {
        died = true
        try { ppp.sendIp(rst) } catch (e) { thrown = e }
      },
    }, { dpdS: 1, log: () => {} })
    ppp.start()
    await until(() => forti.established)
    ppp.close() // the virtual peer never acks: the link dies from its own timer, like the dead-peer path
    await until(() => died, 3_000)
    expect(thrown).toBeNull()
    expect(forti.ipFromClient).toEqual([]) // dropped, not sent
  })

  test("LCP + IPCP negotiation assigns inner IP and DNS, then IP flows both ways", async () => {
    const { ppp, forti, events } = rig({ innerIp: "10.7.0.123", dns: ["132.230.1.1", "132.230.2.2"] })
    ppp.start()
    await until(() => events.established !== null)
    expect(events.established!.innerIp).toBe("10.7.0.123")
    expect(events.established!.dns).toEqual(["132.230.1.1", "132.230.2.2"])
    expect(forti.clientMru).toBe(1400)
    expect(forti.clientMagic).not.toBeNull()

    // client → server IP data
    const dg = buildDatagram({
      src: ipv4Parse("10.7.0.123"), dst: ipv4Parse("132.230.100.48"),
      segment: { header: { srcPort: 1, dstPort: 443, seq: 1, ack: 1, dataOffset: 20, flags: 0x18, window: 1000 }, payload: new Uint8Array(10) },
    })
    ppp.sendIp(dg)
    await until(() => forti.ipFromClient.length === 1)
    expect(forti.ipFromClient[0]).toEqual(dg)

    // server → client IP data
    forti.sendIp(dg)
    await until(() => events.ipIn.length === 1)
    expect(events.ipIn[0]).toEqual(dg)
  })

  test("the server's MRU is adopted as the link MTU", async () => {
    const { ppp, events } = rig({ serverMru: 1350 })
    ppp.start()
    await until(() => events.established !== null)
    expect(events.established!.mru).toBe(1350)
  })

  test("a lost LCP CONFACK is recovered by retransmission", async () => {
    const { ppp, events } = rig({ swallowConfAckIds: [1] }) // server drops our first CONFREQ's ack
    ppp.start()
    // retransmit fires after 3 s with a new id
    await until(() => events.established !== null, 8000)
    expect(events.established).not.toBeNull()
  }, 10_000)

  test("LCP Echo-Request is answered with Echo-Reply carrying our magic", async () => {
    const { ppp, forti, events } = rig()
    ppp.start()
    await until(() => events.established !== null)
    const before = forti.echoReplies
    // the DPD timer (dpdS: 1) will send an echo after 1 s of silence
    await until(() => forti.echoReplies > before, 4000)
  }, 6_000)

  test("IP frames pass through the framing round trip intact", async () => {
    const frame = pppFrame(PPP_IP, new Uint8Array([1, 2, 3, 4, 5]))
    const p = parsePpp(frame)
    expect(p!.proto).toBe(PPP_IP)
    expect([...p!.payload]).toEqual([1, 2, 3, 4, 5])
    const lcp = pppFrame(PPP_LCP, new Uint8Array([1, 2, 0, 4]))
    expect(parsePpp(lcp)!.proto).toBe(PPP_LCP)
  })

  test("PPP frame parser handles the FF03 header and 2-byte protocol", () => {
    const f = pppFrame(PPP_IP, new Uint8Array(3))
    expect(f[0]).toBe(0xff)
    expect(f[1]).toBe(0x03)
    expect(f[2]).toBe(0x00)
    expect(f[3]).toBe(0x21)
    expect(f.length).toBe(7)
  })
})
