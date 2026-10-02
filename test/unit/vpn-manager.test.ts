import { afterEach, describe, expect, test } from "bun:test"
import { VpnManager } from "../../src/daemon/vpn/manager"

let servers: Bun.Server<never>[] = []
afterEach(() => {
  for (const s of servers) s.stop(true)
  servers = []
})

function fakeUfr(o: { type: string; status?: number }) {
  const calls: string[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push(new URL(req.url).pathname)
      const type = o.type
      return new Response(type === "json" ? '{"detail":"Not authenticated"}' : '<title>Zugriff eingeschränkt | VPN erforderlich</title>', {
        status: o.status ?? 200,
        headers: { "content-type": type === "json" ? "application/json" : "text/html" },
      })
    },
  })
  servers.push(server)
  return { server, calls, url: `http://127.0.0.1:${server.port}/api` }
}

function fakeGateway(o: { status: number; body: string; cookie?: string }) {
  const calls: { path: string; status: number }[] = []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const path = new URL(req.url).pathname
      calls.push({ path, status: o.status })
      const headers = new Headers()
      if (o.cookie) headers.append("Set-Cookie", o.cookie)
      return new Response(o.body, { status: o.status, headers })
    },
  })
  servers.push(server)
  return { server, calls, url: `http://127.0.0.1:${server.port}` }
}

const NO_CREDENTIALS = null
const CREDS = { user: "fl240@uni-freiburg.de", pass: "pw" }
const LOG = () => {}

describe("VpnManager", () => {
  test("direct JSON answer → no tunnel, no credentials needed", async () => {
    const ufr = fakeUfr({ type: "json" })
    const m = new VpnManager({ gateway: "https://fortivpn.example", upstreamHost: "x", baseUrl: ufr.url, credentials: NO_CREDENTIALS, log: LOG })
    expect(await m.ensurePath()).toBe("direct")
    expect(m.status.mode).toBe("off")
    expect(m.status.detail).toContain("directly")
  })

  test("VPN page + no login → failed with a clear message", async () => {
    const ufr = fakeUfr({ type: "html" })
    const m = new VpnManager({ gateway: "https://fortivpn.example", upstreamHost: "x", baseUrl: ufr.url, credentials: NO_CREDENTIALS, log: LOG })
    expect(await m.ensurePath()).toBe("failed")
    expect(m.status.mode).toBe("failed")
    expect(m.status.detail).toContain("ufr login add")
  })

  test("VPN page + login + gateway rejects the password → failed, credentials error", async () => {
    const ufr = fakeUfr({ type: "html" })
    const gw = fakeGateway({ status: 405, body: "ret=0" })
    const m = new VpnManager({ gateway: gw.url, upstreamHost: "x", baseUrl: ufr.url, credentials: CREDS, log: LOG })
    expect(await m.ensurePath()).toBe("failed")
    expect(m.status.mode).toBe("failed")
    expect(m.status.detail).toContain("rejected the login")
    expect(gw.calls.some((c) => c.path === "/remote/logincheck")).toBe(true)
  })

  test("mode always skips the direct check entirely", async () => {
    const ufr = fakeUfr({ type: "json" })
    const gw = fakeGateway({ status: 405, body: "ret=0" })
    const m = new VpnManager({ gateway: gw.url, upstreamHost: "x", baseUrl: ufr.url, credentials: CREDS, mode: "always", log: LOG })
    expect(await m.ensurePath()).toBe("failed") // tunnel attempted, login rejected by the fake gw
    expect(ufr.calls).toEqual([]) // UFR was never probed directly
  })

  test("a fresh direct check is cached: repeated calls do not re-probe UFR", async () => {
    const ufr = fakeUfr({ type: "json" })
    const m = new VpnManager({ gateway: "https://fortivpn.example", upstreamHost: "x", baseUrl: ufr.url, credentials: NO_CREDENTIALS, log: LOG })
    await m.ensurePath()
    const after = ufr.calls.length
    expect(after).toBeGreaterThan(0)
    await m.ensurePath()
    await m.ensurePath()
    expect(ufr.calls.length).toBe(after)
  })
})
