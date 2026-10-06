/**
 * A localhost HTTP CONNECT proxy that carries TCP connections through the
 * userspace tunnel. The daemon's upstream fetches use Bun's fetch `proxy`
 * option (verified: absolute-form requests to the proxy) — TLS stays
 * end-to-end, the proxy just moves bytes.
 */

import { type Ipv4 } from "./ip"
import { TcpStack } from "./stack"

type ConnState = {
  buf: Uint8Array[]
  stream: ReturnType<TcpStack["dial"]> | null
}

export type ProxyHandle = {
  port: number
  stop(): void
}

export function startProxy(o: {
  stack: TcpStack
  remoteIp: Ipv4
  allowedHostSuffix?: string // default: uni-freiburg.de — the tunnel carries nothing else
  allowedPorts?: number[]
  log?: (msg: string) => void
}): ProxyHandle {
  const log = o.log ?? (() => {})
  const allowedPorts = o.allowedPorts ?? [443]
  const suffix = (o.allowedHostSuffix ?? "uni-freiburg.de").toLowerCase()
  const conns = new Map<object, ConnState>()

  const server = Bun.listen({
    hostname: "127.0.0.1",
    port: 0,
    socket: {
      open(socket) {
        conns.set(socket, { buf: [], stream: null })
      },
      data(socket, chunk) {
        const state = conns.get(socket)
        if (!state) return
        if (state.stream) {
          // tunnel established: raw bytes flow through the userspace TCP stack
          state.stream.write(chunk)
          return
        }
        state.buf.push(chunk)
        const head = Buffer.concat(state.buf.map((c) => Buffer.from(c)))
        const end = head.indexOf("\r\n\r\n")
        if (end === -1) return
        const request = head.subarray(0, end).toString()
        const m = /^CONNECT\s+(\S+):(\d+)\s+HTTP\/1\.[01]$/i.exec(request.split("\r\n")[0] ?? "")
        if (!m) {
          socket.write("HTTP/1.1 400 Bad Request\r\n\r\n")
          socket.end()
          return
        }
        const port = Number(m[2])
        const host = m[1]!.toLowerCase()
        // exact match or a subdomain — a bare endsWith would let evil-uni-freiburg.de through
        if (!allowedPorts.includes(port) || (host !== suffix && !host.endsWith(`.${suffix}`))) {
          // the tunnel only carries traffic to the uni host
          log(`proxy: refusing CONNECT ${m[1]}:${port}`)
          socket.write("HTTP/1.1 403 Forbidden\r\n\r\n")
          socket.end()
          return
        }
        socket.write("HTTP/1.1 200 Connection established\r\n\r\n")
        try {
          const stream = o.stack.dial(o.remoteIp, port, {
            data: (d) => socket.write(d),
            close: (hadError) => {
              log(`proxy: tunnel side closed${hadError ? " (error)" : ""}`)
              socket.end()
            },
          })
          state.stream = stream
          log(`proxy: CONNECT ${m[1]}:${port} dialed through the tunnel`)
        } catch (e) {
          log(`proxy: dial failed: ${(e as Error).message}`)
          socket.write("HTTP/1.1 502 Bad Gateway\r\n\r\n")
          socket.end()
        }
      },
      close(socket) {
        const state = conns.get(socket)
        conns.delete(socket)
        state?.stream?.end()
      },
      error(socket, err) {
        const state = conns.get(socket)
        conns.delete(socket)
        state?.stream?.destroy()
        log(`proxy: socket error: ${err.message}`)
      },
    },
  })

  return {
    port: server.port,
    stop: () => server.stop(true),
  }
}
