import type { Io } from "../../src/cli/io"

/** Scripted terminal: strings answer prompts, booleans answer confirms, in order. */
export function testIo(answers: (string | boolean)[] = [], o: { isTTY?: boolean } = {}) {
  const out: string[] = []
  const err: string[] = []
  const queue = [...answers]
  const io: Io = {
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    isTTY: o.isTTY ?? false,
    prompt: async (q) => {
      const a = queue.shift()
      if (typeof a !== "string") throw new Error(`test gave no prompt answer for: ${q}`)
      return a
    },
    confirm: async (q) => {
      const a = queue.shift()
      if (typeof a !== "boolean") throw new Error(`test gave no confirm answer for: ${q}`)
      return a
    },
  }
  return { io, out: () => out.join(""), err: () => err.join(""), left: () => queue.length }
}
