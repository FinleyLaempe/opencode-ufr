import { describe, expect, test } from "bun:test"
import { parseLimitFromBody, probeContextLimit, type ProbeResult } from "../../src/daemon/probe"
import type { Transport } from "../../src/daemon/transport"

/** A transport whose fetch runs a handler over the parsed request body. */
function fakeTransport(handler: (body: Record<string, unknown>) => Promise<Response>): Transport {
  return {
    name: "fake",
    fetch: async (_url, init) => handler(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>),
  }
}

const named = (n: number) =>
  JSON.stringify({
    error: { message: `litellm.ContextWindowExceededError: This model's maximum context length is ${n} tokens.` },
  })

const ok = (promptTokens: number) => JSON.stringify({ usage: { prompt_tokens: promptTokens } })

const run = (transport: Transport, sizes: number[] = [1000, 2000]): Promise<ProbeResult> =>
  probeContextLimit({ model: "m-llmlb", baseUrl: "http://ufr/api", key: "k", transport, sizes, log: () => {} })

describe("parseLimitFromBody", () => {
  test("extracts the named limit from the known error shapes", () => {
    expect(parseLimitFromBody(named(8192))).toBe(8192)
    expect(parseLimitFromBody("maximum context length of 4096 tokens exceeded")).toBe(4096)
    expect(parseLimitFromBody("context window is 2048")).toBe(2048)
  })

  test("returns null without a number or below the 1024 floor", () => {
    expect(parseLimitFromBody("no number here")).toBeNull()
    expect(parseLimitFromBody(named(512))).toBeNull()
    expect(parseLimitFromBody("")).toBeNull()
  })
})

describe("probeContextLimit", () => {
  test("a 400 naming the limit is the answer, first rung only", async () => {
    const t = fakeTransport(async () => new Response(named(8192), { status: 400 }))
    expect(await run(t, [1000])).toEqual({ context: 8192, how: "error-named" })
  })

  test("400 WITHOUT a named limit: no accepted rung → null (retry later, nothing learned)", async () => {
    const t = fakeTransport(async () => new Response("bad request", { status: 400 }))
    expect(await run(t)).toBeNull()
  })

  test("400 WITHOUT a named limit after an accepted rung → that rung is the floor", async () => {
    const t = fakeTransport(async (body) => {
      const len = (body.messages as { content: string }[])[0]!.content.length
      if (len < 6000) return new Response(ok(900), { status: 200 }) // small rung accepted
      return new Response("bad request", { status: 400 }) // big rung rejected, unnamed
    })
    expect(await run(t)).toEqual({ context: 900, how: "accepted-floor" })
  })

  test("413 without a named limit behaves like 400 (ladder ceiling)", async () => {
    const t = fakeTransport(async () => new Response("payload too large", { status: 413 }))
    expect(await run(t)).toBeNull()
  })

  test("a transport error with no floor → null", async () => {
    const t = fakeTransport(async () => {
      throw new Error("tunnel down")
    })
    expect(await run(t)).toBeNull()
  })

  test("a transport error after an accepted rung → the floor survives", async () => {
    let calls = 0
    const t = fakeTransport(async (body) => {
      calls++
      if (calls === 1) return new Response(ok(1000), { status: 200 })
      throw new Error("tunnel down")
    })
    expect(await run(t)).toEqual({ context: 1000, how: "accepted-floor" })
  })

  test("429 is not a context answer → null", async () => {
    const t = fakeTransport(async () => new Response("budget exceeded", { status: 429 }))
    expect(await run(t)).toBeNull()
  })

  test("500 is not a context answer → null", async () => {
    const t = fakeTransport(async () => new Response("boom", { status: 500 }))
    expect(await run(t)).toBeNull()
  })

  test("every rung accepted → the last rung's usage is the floor", async () => {
    const t = fakeTransport(async () => new Response(ok(2000), { status: 200 }))
    expect(await run(t, [1000, 2000])).toEqual({ context: 2000, how: "accepted-floor" })
  })

  test("an accepted rung without usage falls back to the requested size", async () => {
    const t = fakeTransport(async () => new Response("{}", { status: 200 }))
    expect(await run(t, [1500])).toEqual({ context: 1500, how: "accepted-floor" })
  })
})
