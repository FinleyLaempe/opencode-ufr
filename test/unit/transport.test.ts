import { describe, expect, test } from "bun:test"
import { createTransport, directTransport } from "../../src/daemon/transport"
import type { Transport } from "../../src/daemon/transport"

const fakeVpnTransport: Transport = {
  name: "vpn",
  fetch: () => Promise.resolve(new Response("via-vpn")),
}

const vpn = { transport: () => fakeVpnTransport } as NonNullable<Parameters<typeof createTransport>[1]>["vpn"]

describe("createTransport", () => {
  test('type "direct" returns the direct transport', () => {
    expect(createTransport({ type: "direct" })).toBe(directTransport)
    // an offered vpn is ignored for direct
    expect(createTransport({ type: "direct" }, { vpn })).toBe(directTransport)
  })

  test('type "auto" with a vpn returns the vpn\'s transport', () => {
    expect(createTransport({ type: "auto" }, { vpn })).toBe(fakeVpnTransport)
  })

  test('type "auto" without a vpn falls back to direct', () => {
    expect(createTransport({ type: "auto" })).toBe(directTransport)
    expect(createTransport({ type: "auto" }, { vpn: null })).toBe(directTransport)
    expect(createTransport({ type: "auto" }, {})).toBe(directTransport)
  })

  test("the returned vpn transport really fetches through the vpn object", async () => {
    const t = createTransport({ type: "auto" }, { vpn })
    expect(t.name).toBe("vpn")
    expect(await (await t.fetch("http://x/")).text()).toBe("via-vpn")
  })

  test("an unknown type falls through the exhaustive switch (no match → undefined)", () => {
    const bogus = { type: "carrier-pigeon" } as unknown as Parameters<typeof createTransport>[0]
    expect(createTransport(bogus, { vpn })).toBeUndefined()
  })
})
