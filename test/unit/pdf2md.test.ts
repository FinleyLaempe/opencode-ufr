import { describe, expect, test } from "bun:test"
import { apiChat, crossPageMerge, refineLoop, stripCodeFences } from "../../src/client/pdf2md"
import type { RelayCall } from "../../src/client/pdf2md"

/** A RelayCall stub driven by a scripted queue of results. */
const scripted = (results: ((model: string, messages: unknown, maxTokens: number) => { status: number; body: string; retryAfterMs?: number })[]) => {
  const seen: { model: string; maxTokens: number; prompt: string }[] = []
  const call: RelayCall = async (model, messages, maxTokens) => {
    seen.push({ model, maxTokens, prompt: JSON.stringify(messages).slice(0, 100) })
    if (seen.length > results.length) throw new Error("script exhausted")
    return results[seen.length - 1]!(model, messages, maxTokens)
  }
  return { call, seen }
}

const okBody = (content: string) => JSON.stringify({ choices: [{ message: { content }, finish_reason: "stop" }] })

/** A 1x1 PNG — imageToB64 only reads bytes, the stub never looks at content. */
const PNG_1X1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

const withPng = async (): Promise<string> => {
  const { mkdtemp } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const png = join(await mkdtemp(join(tmpdir(), "pdf2md-test-")), "page.png")
  await Bun.write(png, PNG_1X1)
  return png
}

describe("apiChat", () => {
  test("returns the content of a successful call", async () => {
    const { call } = scripted([() => ({ status: 200, body: okBody("Hello") })])
    expect(await apiChat(call, "m", [{ role: "user", content: "hi" }])).toBe("Hello")
  })

  test("429 waits for the relay's retry-after, then succeeds", async () => {
    const { call, seen } = scripted([
      () => ({ status: 429, body: "walled", retryAfterMs: 1 }),
      () => ({ status: 200, body: okBody("recovered") }),
    ])
    expect(await apiChat(call, "m", [{ role: "user", content: "hi" }])).toBe("recovered")
    expect(seen).toHaveLength(2)
  })

  test("finish=length doubles the token budget and retries", async () => {
    const { call, seen } = scripted([
      () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }] }) }),
      (model, _m, maxTokens) => ({ status: 200, body: okBody(maxTokens === 16384 ? "full" : "short") }),
    ])
    expect(await apiChat(call, "m", [{ role: "user", content: "hi" }], { maxTokens: 8192 })).toBe("full")
    expect(seen[1]!.maxTokens).toBe(16384)
  })

  test("classification: falls back to reasoning_content when content is empty", async () => {
    const { call } = scripted([
      () => ({ status: 200, body: JSON.stringify({ choices: [{ message: { content: "", reasoning_content: "the answer is DIAGRAM" }, finish_reason: "stop" }] }) }),
    ])
    expect(await apiChat(call, "m", [{ role: "user", content: "hi" }], { allowReasoningFallback: true })).toBe("the answer is DIAGRAM")
  })

  test("gives up after 3 attempts with the last error", async () => {
    const { call } = scripted(Array.from({ length: 4 }, () => () => ({ status: 500, body: "boom" })))
    expect(apiChat(call, "m", [{ role: "user", content: "hi" }])).rejects.toThrow(/after 3 attempts.*500/)
  })
})

describe("stripCodeFences", () => {
  test("strips an outermost markdown fence", () => {
    expect(stripCodeFences("```markdown\n# Hi\n```\n")).toBe("# Hi")
  })
  test("keeps inner code blocks", () => {
    const md = "```markdown\n# Hi\n\n```\ncode\n```\n```"
    expect(stripCodeFences(md)).toBe("# Hi\n\n```\ncode\n```")
  })
  test("leaves unfenced text and non-wrapping fences alone", () => {
    expect(stripCodeFences("# Hi")).toBe("# Hi")
    expect(stripCodeFences("```\ncode\n```\n\nmore")).toBe("```\ncode\n```\n\nmore")
  })
})

describe("refineLoop", () => {
  test("stops when a round produces no change", async () => {
    const png = await withPng()
    const { call, seen } = scripted(Array.from({ length: 5 }, () => () => ({ status: 200, body: okBody("same") })))
    expect(await refineLoop(call, png, "draft")).toBe("same")
    expect(seen).toHaveLength(2) // round 1 changed the text, round 2 saw no change and stopped
  })

  test("keeps the previous markdown when a round collapses", async () => {
    const png = await withPng()
    const { call } = scripted([
      () => ({ status: 200, body: okBody("x") }), // much shorter than the draft → suspicious, keep original
      () => ({ status: 200, body: okBody("x") }),
    ])
    expect(await refineLoop(call, png, "a long draft markdown", 1)).toBe("a long draft markdown")
  })
})

describe("crossPageMerge", () => {
  test("single page is returned unchanged without a model call", async () => {
    const { call, seen } = scripted([])
    expect(await crossPageMerge(call, ["# Page 1"])).toBe("# Page 1")
    expect(seen).toHaveLength(0)
  })

  test("multiple pages go to the refine model in one call", async () => {
    const { call, seen } = scripted([() => ({ status: 200, body: okBody("# merged") })])
    expect(await crossPageMerge(call, ["# P1", "# P2"])).toBe("# merged")
    expect(seen).toHaveLength(1)
  })

  test("a failing merge falls back to the unmerged join", async () => {
    // three 500s = apiChat's full retry ladder without sleeps (only 429/503/network sleep)
    const { call } = scripted([() => ({ status: 500, body: "boom" }), () => ({ status: 500, body: "boom" }), () => ({ status: 500, body: "boom" })])
    expect(await crossPageMerge(call, ["# P1", "# P2"])).toBe("# P1\n\n---\n\n# P2")
  })
})
