import { errorResponse } from "../shared/errors"
import type { Router } from "./router"

export type ServerDeps = {
  port: number
  token: string
  version: string
  router: Router
  models: () => unknown[]
  status: () => unknown
  onActivity: () => void
  onShutdown: () => void
}

export function startServer(d: ServerDeps): { port: number; stop: () => void } {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: d.port,
    idleTimeout: 30,
    fetch: async (req, srv) => {
      const url = new URL(req.url)
      if (req.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true, version: d.version, pid: process.pid })
      }
      if (req.headers.get("authorization") !== `Bearer ${d.token}`) {
        return errorResponse(401, "unauthorized", "missing or wrong local gateway token")
      }
      d.onActivity()
      const route = `${req.method} ${url.pathname}`
      if (route === "GET /v1/models") return Response.json({ object: "list", data: d.models() })
      if (route === "POST /v1/chat/completions") {
        srv.timeout(req, 0) // glm-5.2 can think for minutes before the first byte
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return errorResponse(400, "invalid_request", "body must be JSON")
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return errorResponse(400, "invalid_request", "body must be a JSON object")
        }
        return d.router.handleChat(body as Record<string, unknown>, req.signal)
      }
      if (route === "POST /v1/_client/heartbeat") return Response.json({ ok: true })
      if (route === "GET /v1/_status") return Response.json(d.status())
      if (route === "POST /v1/_shutdown") {
        setTimeout(d.onShutdown, 20)
        return Response.json({ ok: true })
      }
      return errorResponse(404, "not_found", `no route ${route}`)
    },
  })
  return { port: server.port as number, stop: () => server.stop(true) }
}
