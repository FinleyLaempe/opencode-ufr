import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { dirname } from "node:path"

/** Append-only log, rotated to <file>.1 past maxBytes. Callers never pass key values. */
export function createLogger(file: string, maxBytes = 1_000_000): (msg: string) => void {
  mkdirSync(dirname(file), { recursive: true })
  return (msg) => {
    try {
      if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
    } catch {
      // no log file yet
    }
    appendFileSync(file, `${new Date().toISOString()} ${msg}\n`)
  }
}
