import { errorResponse } from "../shared/errors"
import type { Router } from "./router"

export type ServerDeps = {
  port: number
  token: string
  version: string
  router: Router
  models: () => unknown[]
  status: () => unknown
  /** Raw UFR model list + bundled models.json — for scripts that probe every model. */
  catalogData?: () => { ufr: unknown; file: unknown } | null
  onActivity: () => void
  onShutdown: () => void
  /** True once stop() began: new work is fast-failed while in-flight requests drain. */
  draining?: () => boolean
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
      // Once stop() began, fast-fail new chat/relay work instead of admitting
      // requests the drain grace period would tear down at the deadline.
      // /health, /v1/_status and friends keep answering during the drain.
      if ((route === "POST /v1/chat/completions" || route === "POST /v1/_relay") && d.draining?.()) {
        return errorResponse(503, "draining", "the gateway is shutting down — retry shortly")
      }
      // Dashboard polling of _status must not reset the idle timer — only real work does.
      if (route === "GET /v1/_status") return Response.json(d.status())
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
      if (route === "POST /v1/_relay") {
        // Scripts (context probes, pdf2md): one raw upstream call through the
        // central key rotation and soft rate limiting. Streams live forever.
        srv.timeout(req, 0)
        let body: unknown
        try {
          body = await req.json()
        } catch {
          return errorResponse(400, "invalid_request", "body must be JSON")
        }
        if (typeof body !== "object" || body === null || Array.isArray(body)) {
          return errorResponse(400, "invalid_request", "body must be a JSON object")
        }
        return d.router.handleRelay(body as Record<string, unknown>, req.signal)
      }
      if (route === "GET /v1/_catalog") return Response.json(d.catalogData?.() ?? null)
      if (route === "POST /v1/_client/heartbeat") return Response.json({ ok: true })
      if (route === "POST /v1/_shutdown") {
        setTimeout(d.onShutdown, 20)
        return Response.json({ ok: true })
      }
      return errorResponse(404, "not_found", `no route ${route}`)
    },
    // Uncaught throws from the fetch handler (status(), models(), handleChat
    // internals): answer in the gateway's JSON error shape instead of Bun's
    // default HTML 500. Responses already returned — including streams, which
    // surface their own errors — never reach this handler.
    error: (e) => errorResponse(500, "internal_error", `gateway error: ${e instanceof Error ? e.message : String(e)}`),
  })
  return { port: server.port as number, stop: () => server.stop(true) }
}
