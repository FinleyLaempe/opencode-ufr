import { UFR_RAW_MODELS } from "./models"

/** UFR's real 429 body (2026-09-28), served as text/plain like UFR does. */
export const BUDGET_BODY = JSON.stringify(
  {
    error: {
      message:
        "You have exceeded your daily budget, or are sending too many requests per minute! \n For extended access to our frontier models please contact ki@rz.uni-freiburg.de.",
      type: "budget_exceeded",
      code: 429,
    },
  },
  null,
  4,
)

/** What UFR serves on every path when the caller is not on the VPN — with HTTP 200. */
export const VPN_PAGE =
  '<!DOCTYPE html><html lang="de"><head><title>Zugriff eingeschränkt | VPN erforderlich | Open WebUI</title></head><body>VPN</body></html>'

export type FakeUfrOptions = { keys?: string[]; bucket?: number; windowMs?: number; models?: unknown[] }
export type FakeCall = { key: string; model: string; stream: boolean; body: Record<string, any>; at: number; aborted: boolean }

const text429 = () => new Response(BUDGET_BODY, { status: 429, headers: { "content-type": "text/plain; charset=utf-8" } })

/** A local stand-in for openwebui.uni-freiburg.de/api with UFR's measured behaviour. */
export class FakeUfr {
  calls: FakeCall[] = []
  walled = new Set<string>()
  rateLimitedKeys = new Set<string>()
  contextLimitChars = new Map<string, number>()
  reasoningOnly = new Set<string>()
  /** Models in this set answer normally on their first call, then are walled (429) on every call after. */
  wallAfterFirst = new Set<string>()
  errorModels = new Map<string, number>()
  delayMs = 0
  streamChunkDelayMs = 0
  vpnPage = false
  private readonly admissions = new Map<string, number[]>()
  private server!: ReturnType<typeof Bun.serve>

  private constructor(private readonly o: Required<FakeUfrOptions>) {}

  static start(o: FakeUfrOptions = {}): FakeUfr {
    const f = new FakeUfr({
      keys: o.keys ?? ["key-a", "key-b", "key-c"],
      bucket: o.bucket ?? 20,
      windowMs: o.windowMs ?? 60_000,
      models: o.models ?? UFR_RAW_MODELS,
    })
    f.server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, fetch: (req) => f.handle(req) })
    return f
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.server.port}/api`
  }

  stop(): void {
    this.server.stop(true)
  }

  callsFor(model: string): FakeCall[] {
    return this.calls.filter((c) => c.model === model)
  }

  private async handle(req: Request): Promise<Response> {
    if (this.vpnPage) return new Response(VPN_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } })
    const url = new URL(req.url)
    const key = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "")
    if (!this.o.keys.includes(key)) return Response.json({ detail: "Invalid API key" }, { status: 401 })
    if (req.method === "GET" && url.pathname === "/api/models") return Response.json({ data: this.o.models })
    if (req.method !== "POST" || url.pathname !== "/api/chat/completions") return new Response("not found", { status: 404 })

    const body = (await req.json()) as Record<string, any>
    const priorCallsToModel = this.calls.filter((c) => c.model === String(body.model)).length
    const call: FakeCall = { key, model: String(body.model), stream: body.stream === true, body, at: Date.now(), aborted: false }
    this.calls.push(call)
    req.signal.addEventListener("abort", () => {
      call.aborted = true
    })

    const walledNow = this.walled.has(call.model) || (this.wallAfterFirst.has(call.model) && priorCallsToModel >= 1)
    if (this.rateLimitedKeys.has(key) || walledNow) return text429()
    const now = Date.now()
    const recent = (this.admissions.get(key) ?? []).filter((t) => t > now - this.o.windowMs)
    if (recent.length >= this.o.bucket) {
      this.admissions.set(key, recent) // rejected requests do not count
      return text429()
    }
    recent.push(now)
    this.admissions.set(key, recent)

    const status = this.errorModels.get(call.model)
    if (status) return Response.json({ error: { message: `fake ${status}`, code: status } }, { status })
    const limit = this.contextLimitChars.get(call.model)
    if (limit !== undefined && JSON.stringify(body.messages).length > limit) {
      return Response.json(
        { error: { message: `This model's maximum context length is ${limit} tokens.`, type: "BadRequestError", code: 400 } },
        { status: 400 },
      )
    }
    if (this.delayMs) await Bun.sleep(this.delayMs)

    const starved = this.reasoningOnly.has(call.model) && body.reasoning_effort !== "none"
    const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }
    if (!call.stream) {
      return Response.json({
        id: "chatcmpl-fake",
        object: "chat.completion",
        model: call.model,
        choices: [
          {
            index: 0,
            message: starved ? { role: "assistant", content: "", reasoning_content: "thinking" } : { role: "assistant", content: "Hello" },
            finish_reason: starved ? "length" : "stop",
          },
        ],
        usage,
      })
    }

    const enc = new TextEncoder()
    const chunk = (o: unknown) => enc.encode(`data: ${JSON.stringify(o)}\n\n`)
    const includeUsage = body.stream_options?.include_usage === true
    const delay = this.streamChunkDelayMs
    const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", model: call.model }
    const stream = new ReadableStream<Uint8Array>({
      async start(ctl) {
        ctl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }))
        for (const piece of ["Hel", "lo"]) {
          if (delay) await Bun.sleep(delay)
          if (call.aborted) return
          ctl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: { content: piece } }] }))
        }
        ctl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }))
        // UFR's usage chunk keeps one choice with an empty delta (seen 2026-09-28)
        if (includeUsage) ctl.enqueue(chunk({ ...base, choices: [{ index: 0, delta: {} }], usage }))
        ctl.enqueue(enc.encode("data: [DONE]\n\n"))
        ctl.close()
      },
      cancel() {
        call.aborted = true // the client (our router) went away mid-stream
      },
    })
    return new Response(stream, { headers: { "content-type": "text/event-stream" } })
  }
}
