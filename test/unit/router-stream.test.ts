import { afterEach, describe, expect, test } from "bun:test"
import { routerEnv } from "../support/router-env"

let env: ReturnType<typeof routerEnv> | null = null
const setup = () => (env = routerEnv())
afterEach(() => {
  env?.stop()
  env = null
})

const GLM = "glm-5.2-llmlb"

describe("Router, streaming", () => {
  test("passes UFR's SSE through and records the usage chunk", async () => {
    const e = setup()
    const res = await e.chat({ model: GLM, stream: true })
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    const text = await res.text()
    expect(text).toContain('"Hel"')
    expect(text).toContain('"lo"')
    expect(text.trim().endsWith("data: [DONE]")).toBe(true)
    expect(e.ufr.calls[0]!.body.stream_options).toEqual({ include_usage: true })
    expect(e.stats.summary(0).byModel[0]).toMatchObject({ promptTokens: 10, completionTokens: 2 })
  })

  test("keeps the client's own stream_options", async () => {
    const e = setup()
    await (await e.chat({ model: GLM, stream: true, stream_options: { foo: 1 } })).text()
    expect(e.ufr.calls[0]!.body.stream_options).toEqual({ foo: 1, include_usage: true })
  })

  test("falls back before the first byte", async () => {
    const e = setup()
    e.ufr.walled.add(GLM)
    const res = await e.chat({ model: GLM, stream: true })
    expect(res.status).toBe(200)
    await res.text()
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM, GLM, "gemma-4-31b-llmlb"])
  })

  test("cancelling the stream aborts the upstream request", async () => {
    const e = setup()
    e.ufr.streamChunkDelayMs = 1_000
    const res = await e.chat({ model: GLM, stream: true })
    const reader = res.body!.getReader()
    await reader.read()
    await reader.cancel()
    await Bun.sleep(300)
    expect(e.ufr.calls[0]!.aborted).toBe(true)
    expect(e.stats.summary(0).byModel[0]!.requests).toBe(1)
  })

  test("the live meter counts streamed output while the stream is still running", async () => {
    const e = setup()
    e.ufr.streamChunkDelayMs = 200
    const res = await e.chat({ model: GLM, stream: true })
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let seen = ""
    while (!seen.includes('"Hel"')) seen += dec.decode((await reader.read()).value)
    // mid-stream: an estimate is already there, the request itself is not counted yet
    expect(e.meter.sum(60_000).tokensOut).toBeGreaterThan(0)
    expect(e.meter.sum(60_000).requests).toBe(0)
    while (!(await reader.read()).done) {}
    // done: the estimate is corrected to UFR's real usage (fake: 10 prompt, 2 completion)
    expect(e.meter.sum(60_000)).toEqual({ requests: 1, tokensIn: 10, tokensOut: 2 })
  })

  test("a mid-stream upstream failure errors the client and records stream_error", async () => {
    const e = setup()
    e.ufr.failStreamAfterBytes = 20
    const res = await e.chat({ model: GLM, stream: true })
    expect(res.status).toBe(200)
    const reader = res.body!.getReader()
    expect((await reader.read()).done).toBe(false) // some bytes arrive first
    await expect(reader.read()).rejects.toThrow() // then the stream dies
    expect(e.router.inFlight).toBe(0)
    // Stats has no raw-row accessor — read the recorded error_type directly.
    const rows = (e.stats as any).db.query("SELECT error_type FROM requests").all() as { error_type: string | null }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]!.error_type).toBe("stream_error")
  })
})

describe("Router, reasoning retry", () => {
  test("a reasoning-starved answer is retried once without reasoning", async () => {
    const e = setup()
    e.ufr.reasoningOnly.add(GLM)
    const res = await e.chat({ model: GLM })
    expect(((await res.json()) as any).choices[0].message.content).toBe("Hello")
    expect(e.ufr.calls).toHaveLength(2)
    expect(e.ufr.calls[1]!.body.reasoning_effort).toBe("none")
    expect(e.stats.summary(0).byModel[0]).toMatchObject({ requests: 1, promptTokens: 20, completionTokens: 4 })
  })

  test("a retry that falls back prices each call at its own model", async () => {
    const e = setup()
    e.ufr.reasoningOnly.add(GLM)
    e.ufr.wallAfterFirst.add(GLM)
    const res = await e.chat({ model: GLM })
    expect(res.status).toBe(200)
    expect(e.ufr.calls.map((c) => c.model)).toEqual([GLM, GLM, GLM, "gemma-4-31b-llmlb"])
    const row = e.stats.summary(0).byModel[0]!
    expect(row).toMatchObject({ requests: 1, promptTokens: 20, completionTokens: 4 })
    // GLM's own call: (10+2) tok * $0.40/Mtok; the fallback GEMMA call is free — not the fallback's
    // price applied to both, and not 0 for the whole row.
    expect(row.costUsd).toBeCloseTo((10 + 2) * 0.4 / 1_000_000, 12)
  })

  test("an open stream counts as in flight until it ends", async () => {
    const e = setup()
    const res = await e.chat({ model: GLM, stream: true })
    expect(e.router.inFlight).toBe(1)
    await res.text()
    expect(e.router.inFlight).toBe(0)
  })

  test("streams are never retried for reasoning", async () => {
    const e = setup()
    e.ufr.reasoningOnly.add(GLM)
    await (await e.chat({ model: GLM, stream: true })).text()
    expect(e.ufr.calls).toHaveLength(1)
  })
})
