import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { type Transport, directTransport } from "../../src/daemon/transport"
import { callUpstream } from "../../src/daemon/upstream"
import { FakeUfr } from "../support/fake-ufr"

let ufr: FakeUfr
beforeEach(() => {
  ufr = FakeUfr.start()
})
afterEach(() => ufr.stop())

const call = (over: Partial<Parameters<typeof callUpstream>[0]> = {}) =>
  callUpstream({
    transport: directTransport,
    baseUrl: ufr.baseUrl,
    key: "key-a",
    body: { model: "glm-5.2-llmlb", messages: [{ role: "user", content: "Hi" }] },
    timeoutMs: 5_000,
    stream: false,
    ...over,
  })

describe("callUpstream", () => {
  test("a JSON 200 is ok", async () => {
    const r = await call()
    expect(r.kind).toBe("ok")
    if (r.kind === "ok") expect(((await r.response.json()) as any).choices[0].message.content).toBe("Hello")
  })

  test("UFR's text/plain 429 is rate_limited", async () => {
    ufr.walled.add("glm-5.2-llmlb")
    const r = await call()
    expect(r.kind).toBe("rate_limited")
    if (r.kind === "rate_limited") expect(r.body).toContain("budget_exceeded")
  })

  test("401 is auth_invalid", async () => {
    expect((await call({ key: "wrong" })).kind).toBe("auth_invalid")
  })

  test("a 400 ExceededBudget body is budget_exhausted with parsed spend and limit", async () => {
    ufr.budgetDeadKeys.add("key-a")
    const r = await call()
    expect(r.kind).toBe("budget_exhausted")
    if (r.kind === "budget_exhausted") {
      expect(r.status).toBe(400)
      expect(r.spend).toBe(24.0425389)
      expect(r.limit).toBe(20.0)
    }
  })

  test("a 400 without the budget marker stays a generic error", async () => {
    ufr.errorModels.set("glm-5.2-llmlb", 400)
    expect(await call()).toMatchObject({ kind: "error", status: 400 })
  })

  test("a context-length 400 is context_overflow", async () => {
    ufr.contextLimitChars.set("glm-5.2-llmlb", 5)
    expect((await call()).kind).toBe("context_overflow")
  })

  test("the off-VPN HTML page with HTTP 200 is unreachable, naming the VPN", async () => {
    ufr.vpnPage = true
    const r = await call()
    expect(r.kind).toBe("unreachable")
    if (r.kind === "unreachable") expect(r.message).toContain("VPN")
  })

  test("a redirect is unreachable but not blamed on the VPN (ruling R12)", async () => {
    const redirecting: Transport = {
      name: "redirecting",
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://login.example/" } }),
    }
    const r = await call({ transport: redirecting })
    expect(r.kind).toBe("unreachable")
    if (r.kind === "unreachable") {
      expect(r.message).toBe("UFR answered with a redirect (HTTP 302) instead of JSON")
      expect(r.message).not.toContain("VPN")
    }
  })

  test("a closed port is unreachable", async () => {
    const r = await call({ baseUrl: "http://127.0.0.1:9/api" })
    expect(r.kind).toBe("unreachable")
  })

  test("a slow UFR becomes a 504 upstream_timeout", async () => {
    ufr.delayMs = 300
    const r = await call({ timeoutMs: 100 })
    expect(r).toMatchObject({ kind: "error", status: 504 })
  })

  test("other errors pass through with their status", async () => {
    ufr.errorModels.set("glm-5.2-llmlb", 500)
    expect(await call()).toMatchObject({ kind: "error", status: 500 })
  })

  test("the caller aborting throws instead of returning a result", async () => {
    ufr.delayMs = 300
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 50)
    await expect(call({ signal: ac.signal })).rejects.toThrow()
  })
})
