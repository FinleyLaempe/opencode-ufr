import { describe, expect, test } from "bun:test"
import { FrameReader, authenticate, parseTunnelConfig, wrapFrame, VpnChallengeError } from "../../src/daemon/vpn/fortinet"

describe("tunnel frame framing (0x5050)", () => {
  test("one complete frame", () => {
    const f = wrapFrame(new Uint8Array([1, 2, 3]))
    expect(f.length).toBe(9)
    expect([f[2], f[3]]).toEqual([0x50, 0x50])
    const frames = new FrameReader().push(f)
    expect(frames.length).toBe(1)
    expect([...frames[0]!]).toEqual([1, 2, 3])
  })

  test("concatenated frames in one TLS record", () => {
    const r = new FrameReader()
    const a = wrapFrame(new Uint8Array([0xaa]))
    const b = wrapFrame(new Uint8Array([0xbb, 0xcc]))
    const frames = r.push(new Uint8Array([...a, ...b]))
    expect(frames.length).toBe(2)
    expect([...frames[0]!]).toEqual([0xaa])
    expect([...frames[1]!]).toEqual([0xbb, 0xcc])
  })

  test("frame split across TLS records", () => {
    const r = new FrameReader()
    const f = wrapFrame(new Uint8Array([1, 2, 3, 4, 5]))
    expect(r.push(f.slice(0, 4))).toEqual([]) // header only, no frame yet
    expect(r.push(f.slice(4, 6))).toEqual([]) // still no ppp_len bytes complete
    const frames = r.push(f.slice(6))
    expect(frames.length).toBe(1)
    expect([...frames[0]!]).toEqual([1, 2, 3, 4, 5])
  })

  test("broken magic throws", () => {
    const r = new FrameReader()
    const f = wrapFrame(new Uint8Array([1]))
    f[2] = 0x99
    expect(() => r.push(f)).toThrow("broken tunnel frame")
  })

  test("a 20 KiB frame survives (spec: ≥16 KiB buffer)", () => {
    const big = new Uint8Array(20_480).fill(7)
    const frames = new FrameReader().push(wrapFrame(big))
    expect(frames.length).toBe(1)
    expect(frames[0]!.length).toBe(20_480)
  })
})

const SPEC_XML = `<?xml version="1.0" encoding="utf-8"?>
<sslvpn-tunnel ver="2" dtls="1" patch="1">
  <dtls-config heartbeat-interval="10" heartbeat-fail-count="10"/>
  <tunnel-method value="ppp"/>
  <ipv4>
    <dns ip="132.230.1.1"/>
    <dns ip="132.230.2.2"/>
    <assigned-addr ipv4="172.16.1.1"/>
    <split-tunnel-info>
      <addr ip="132.230.100.48" mask="255.255.255.255"/>
    </split-tunnel-info>
  </ipv4>
  <idle-timeout val="3600"/>
  <auth-timeout val="18000"/>
</sslvpn-tunnel>`

describe("tunnel config XML", () => {
  test("parses the spec example", () => {
    const c = parseTunnelConfig(SPEC_XML)
    expect(c.innerIp).toBe("172.16.1.1")
    expect(c.dns).toEqual(["132.230.1.1", "132.230.2.2"])
    expect(c.dpdS).toBe(10)
    expect(c.idleTimeoutS).toBe(3600)
    expect(c.authTimeoutS).toBe(18000)
    expect(c.routes).toEqual([{ ip: "132.230.100.48", mask: "255.255.255.255" }])
  })

  test("rejects a non-tunnel document (dead session)", () => {
    expect(() => parseTunnelConfig("<html>login</html>")).toThrow("sslvpn-tunnel")
  })
})

// -- auth against a fake Fortinet -----------------------------------------------

function fakeForti(o: {
  cookie?: string
  status?: number
  body?: string
  seen?: { path: string; body: string; cookie: string | null }[]
} = {}) {
  const seen = o.seen ?? []
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      const body = o.body ?? ""
      seen.push({ path: url.pathname, body: "", cookie: req.headers.get("cookie") })
      const headers = new Headers()
      if (o.cookie) headers.append("Set-Cookie", o.cookie)
      return new Response(body, { status: o.status ?? 200, headers })
    },
  })
  return { server, seen, url: `http://127.0.0.1:${server.port}` }
}

describe("authenticate", () => {
  test("success: returns the SVPNCOOKIE verbatim", async () => {
    const f = fakeForti({ cookie: "SVPNCOOKIE=abc%2Fdef+ghi; path=/; HttpOnly" })
    const r = await authenticate({ gateway: f.url, user: "xx0000@uni-freiburg.de", pass: "pw" })
    expect(r.cookie).toBe("SVPNCOOKIE=abc%2Fdef+ghi")
    expect(r.realm).toBe("")
    expect(f.seen.map((s) => s.path)).toEqual(["/", "/remote/logincheck"])
    f.server.stop(true)
  })

  test("405 means bad credentials", async () => {
    const f = fakeForti({ status: 405, body: "ret=0" })
    expect(authenticate({ gateway: f.url, user: "u", pass: "wrong" })).rejects.toThrow("rejected the login")
    f.server.stop(true)
  })

  test("tokeninfo 2FA: parrots the challenge fields back and gets the cookie", async () => {
    const seen: { path: string; body: string; cookie: string | null }[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/remote/logincheck") {
          const body = await req.text()
          seen.push({ path: url.pathname, body, cookie: req.headers.get("cookie") })
          if (!body.includes("code=")) {
            return new Response("ret=6,reqid=42,polid=1,grp=students,portal=sslvpn,peer=px,magic=ab12,tokeninfo=ftm_token,chal_msg=Enter+code", { headers: new Headers() })
          }
          return new Response("", { headers: new Headers({ "Set-Cookie": "SVPNCOOKIE=after2fa; path=/" }) })
        }
        seen.push({ path: url.pathname, body: "", cookie: null })
        return new Response("")
      },
    })
    const r = await authenticate({
      gateway: `http://127.0.0.1:${server.port}`,
      user: "xx0000@uni-freiburg.de",
      pass: "pw",
      on2fa: async () => "123456",
    })
    expect(r.cookie).toBe("SVPNCOOKIE=after2fa")
    const second = seen.find((s) => s.body.includes("code=123456"))!
    expect(second).toBeDefined()
    expect(second.body).toContain("reqid=42")
    expect(second.body).toContain("grp=students")
    expect(second.body).toContain("portal=sslvpn")
    expect(second.body).toContain("peer=px")
    expect(second.body).toContain("magic=ab12")
    server.stop(true)
  })

  test("every login request opens a fresh connection (regression: a pooled socket that died with the old route stalled the reconnect)", async () => {
    // Answers the first request on each TCP connection, then goes silent on it —
    // what a kept-alive socket looks like after the user's own VPN changed the route.
    const answered = new WeakSet<object>()
    const server = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        data(s, chunk) {
          if (answered.has(s)) return
          answered.add(s)
          const login = new TextDecoder().decode(chunk).startsWith("POST /remote/logincheck")
          s.write(login
            ? "HTTP/1.1 200 OK\r\nSet-Cookie: SVPNCOOKIE=fresh; path=/\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
            : "HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n")
        },
      },
    })
    try {
      const r = await authenticate({ gateway: `http://127.0.0.1:${server.port}`, user: "u", pass: "p", signal: AbortSignal.timeout(3_000) })
      expect(r.cookie).toBe("SVPNCOOKIE=fresh")
    } finally {
      server.stop(true)
    }
  })

  test("without on2fa a token challenge is a clear error", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("ret=6,tokeninfo=ftm_token", { headers: new Headers() }),
    })
    await expect(authenticate({ gateway: `http://127.0.0.1:${server.port}`, user: "u", pass: "p" }))
      .rejects.toThrow(VpnChallengeError)
    server.stop(true)
  })
})
