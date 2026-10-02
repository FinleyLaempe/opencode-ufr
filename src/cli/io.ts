import { createInterface } from "node:readline/promises"
import type { Readable, Writable } from "node:stream"

export type Io = {
  out(s: string): void
  err(s: string): void
  isTTY: boolean
  prompt(question: string, o?: { secret?: boolean }): Promise<string>
  confirm(question: string): Promise<boolean>
}

export function terminalIo(): Io {
  return {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
    isTTY: process.stdin.isTTY === true,
    prompt: (q, o) => (o?.secret ? (process.stdin.isTTY ? readSecret(q) : readPipedSecret(q)) : readLine(q)),
    // Non-interactive sessions (scripts, pipes) can never answer a question:
    // treat a confirm as "no" immediately instead of waiting on stdin forever.
    confirm: async (q) =>
      process.stdin.isTTY === true && /^(y|yes|j|ja)$/i.test((await readLine(`${q} [y/N] `)).trim()),
  }
}

/** Testable variant: answers one prompt from a closed/ended stream with "" instead of hanging. */
export function readLineFrom(q: string, input: Readable, output: Writable): Promise<string> {
  return readLine(q, input, output)
}

async function readLine(
  q: string,
  input: Readable = process.stdin,
  output: Writable = process.stdout,
): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    // Resolve on close as well: with stdin already at EOF (piped input exhausted,
    // no terminal) question() would otherwise never settle and hang the CLI.
    return await new Promise<string>((resolve) => {
      rl.once("close", () => resolve(""))
      rl.question(q).then(resolve, () => resolve(""))
    })
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
