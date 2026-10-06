import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

/** Write via a temp file + rename, so readers never see half a file. */
export async function writeFileAtomic(file: string, data: string, mode?: number): Promise<void> {
  await mkdir(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  try {
    await writeFile(tmp, data, mode === undefined ? {} : { mode })
    await rename(tmp, file)
  } catch (e) {
    await rm(tmp, { force: true }) // don't leak the temp file when the write or rename fails
    throw e
  }
}

/** File contents, or null if it does not exist. Other errors propagate. */
export async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8")
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
    throw e
  }
}

/** Parsed JSON, or null if the file is missing or not JSON. */
export async function readJson(file: string): Promise<unknown | null> {
  const text = await readText(file)
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}
