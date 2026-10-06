import { describe, expect, test } from "bun:test"
import { ipv4Parse } from "../../src/daemon/vpn/ip"
import { TcpStack } from "../../src/daemon/vpn/stack"
import { startProxy } from "../../src/daemon/vpn/proxy"
import { VirtualServer } from "../support/virtual-server"

const CLIENT = ipv4Parse("10.7.0.2")
const SERVER = ipv4Parse("132.230.100.48")

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error("condition not met in time")
    await Bun.sleep(5)
  }
}

describe("the CONNECT proxy through the userspace stack", () => {
  test("CONNECT is answered 200 and bytes flow both ways", async () => {
    const server = new VirtualServer(SERVER, 443, (p) => stack.receive(p), (conn) => {
      // echo server: reply once the request arrived
      const check = setInterval(() => {
        if (conn.dataReceived.includes("PING")) {
          clearInterval(check)
          conn.write(new TextEncoder().encode("PONG"))
          conn.fin()
        }
      }, 5)
    })
    const stack = new TcpStack({ local: CLIENT, sink: (p) => server.receive(p) }, () => {})
    const proxy = startProxy({ stack, remoteIp: SERVER })

    type ClientState = { chunks: string[]; notify: () => void }
    const state: ClientState = { chunks: [], notify: () => {} }
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
      socket: {
        data(_sock, chunk) {
          state.chunks.push(new TextDecoder().decode(chunk))
          state.notify()
        },
      },
    })
    socket.data = state as never

    const text = () => state.chunks.join("")
    socket.write(new TextEncoder().encode("CONNECT openwebui.uni-freiburg.de:443 HTTP/1.1\r\nHost: openwebui.uni-freiburg.de:443\r\n\r\n"))
    await until(() => text().includes("200 Connection established"))
    socket.write(new TextEncoder().encode("PING"))
    await until(() => text().includes("PONG"))
    socket.end()
    proxy.stop()
  })

  test("foreign hosts are refused", async () => {
    const server = new VirtualServer(SERVER, 443, (p) => stack.receive(p))
    const stack = new TcpStack({ local: CLIENT, sink: (p) => server.receive(p) }, () => {})
    const proxy = startProxy({ stack, remoteIp: SERVER })
    const got: string[] = []
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
      socket: {
        data(_s, chunk) { got.push(new TextDecoder().decode(chunk)) },
      },
    })
    socket.write(new TextEncoder().encode("CONNECT evil.example.com:443 HTTP/1.1\r\n\r\n"))
    await until(() => got.join("").includes("403"))
    socket.end()
    proxy.stop()
  })

  test("lookalike domains that merely contain the suffix are refused (regression: evil-uni-freiburg.de passed endsWith)", async () => {
    const server = new VirtualServer(SERVER, 443, (p) => stack.receive(p))
    const stack = new TcpStack({ local: CLIENT, sink: (p) => server.receive(p) }, () => {})
    const proxy = startProxy({ stack, remoteIp: SERVER })
    const got: string[] = []
    const socket = await Bun.connect({
      hostname: "127.0.0.1",
      port: proxy.port,
      socket: {
        data(_s, chunk) { got.push(new TextDecoder().decode(chunk)) },
      },
    })
    socket.write(new TextEncoder().encode("CONNECT evil-uni-freiburg.de:443 HTTP/1.1\r\n\r\n"))
    await until(() => got.join("").includes("403"))
    socket.end()
    proxy.stop()
  })
})
