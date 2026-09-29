import { createInterface } from "node:readline/promises"
import type { Readable, Writable } from "node:stream"

export type Io = {
  out(s: string): void
  err(s: string): void
  prompt(question: string, o?: { secret?: boolean }): Promise<string>
  confirm(question: string): Promise<boolean>
}

export function terminalIo(): Io {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    prompt: (q, o) => (o?.secret ? (process.stdin.isTTY ? readSecret(q) : readPipedSecret(q)) : readLine(q)),
    confirm: async (q) => /^(y|yes|j|ja)$/i.test((await readLine(`${q} [y/N] `)).trim()),
  }
}

async function readLine(q: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await rl.question(q)
  } finally {
    rl.close()
  }
}

/**
 * A secret piped in (stdin not a TTY): read one line with readline in non-terminal
 * mode, which never writes the line back. The question goes to stderr, not to the
 * output that readLine's terminal mode would echo the key into.
 */
export function readPipedSecret(q: string, input: Readable = process.stdin, err: Writable = process.stderr): Promise<string> {
  err.write(q)
  const rl = createInterface({ input, terminal: false })
  return new Promise((resolve) => {
    let done = false
    const finish = (line: string) => {
      if (done) return
      done = true
      rl.close()
      err.write("\n")
      resolve(line)
    }
    rl.once("line", finish)
    rl.once("close", () => finish(""))
  })
}

/** Read one line without echo — for API keys. */
function readSecret(q: string): Promise<string> {
  process.stdout.write(q)
  const stdin = process.stdin
  return new Promise((resolve) => {
    let buf = ""
    const finish = () => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.off("data", onData)
      process.stdout.write("\n")
      resolve(buf)
    }
    const onData = (d: Buffer) => {
      for (const ch of d.toString("utf8")) {
        if (ch === "\r" || ch === "\n") return finish()
        if (ch === "\u0003") {
          stdin.setRawMode(false)
          process.exit(130)
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1)
        else buf += ch
      }
    }
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("data", onData)
  })
}
