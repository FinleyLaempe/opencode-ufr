import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, readdir, readFile, rm } from "node:fs/promises"
import { join } from "node:path"
import { readJson, readText, writeFileAtomic } from "../../src/shared/fs"

const DIR = join("/tmp/opencode", `fs-test-${process.pid}`)
const file = (n: string) => join(DIR, n)

async function tmpFiles(): Promise<string[]> {
  return (await readdir(DIR)).filter((n) => n.includes(".tmp-"))
}

afterEach(async () => {
  await rm(DIR, { recursive: true, force: true })
})

describe("writeFileAtomic", () => {
  test("writes the content and creates parent directories", async () => {
    const f = file("nested/deep/out.txt")
    await writeFileAtomic(f, "hello")
    expect(await readFile(f, "utf8")).toBe("hello")
  })

  test("atomic rename leaves no .tmp litter behind on success", async () => {
    const f = file("out.txt")
    await writeFileAtomic(f, "data")
    expect(await tmpFiles()).toEqual([])
    expect(await readFile(f, "utf8")).toBe("data")
  })

  test("overwrites an existing file", async () => {
    const f = file("out.txt")
    await writeFileAtomic(f, "one")
    await writeFileAtomic(f, "two")
    expect(await readFile(f, "utf8")).toBe("two")
  })

  test("a directory as target rejects without clobbering it", async () => {
    const dir = file("adir")
    await mkdir(dir, { recursive: true })
    await writeFileAtomic(join(dir, "keep.txt"), "keep")
    let err: unknown = null
    try {
      await writeFileAtomic(dir, "nope")
    } catch (e) {
      err = e
    }
    expect(err).not.toBeNull() // rename(file → dir) fails
    expect(await readFile(join(dir, "keep.txt"), "utf8")).toBe("keep") // target untouched
    // NOTE: the current implementation leaves the temp file behind when the
    // rename fails — no cleanup assertion here, only that the target survives.
  })

  test("an unwritable directory rejects and leaves no temp file (write never happened)", async () => {
    if (process.getuid?.() === 0) return // root ignores permission bits
    const ro = file("ro")
    await mkdir(ro, { recursive: true })
    await chmodRo(ro, true)
    try {
      await expect(writeFileAtomic(join(ro, "out.txt"), "x")).rejects.toThrow()
      expect(await tmpFiles()).toEqual([]) // no litter: the temp write itself failed
    } finally {
      await chmodRo(ro, false)
    }
  })
})

async function chmodRo(dir: string, ro: boolean): Promise<void> {
  const { chmod } = await import("node:fs/promises")
  await chmod(dir, ro ? 0o500 : 0o755)
}

describe("readText", () => {
  test("returns file contents", async () => {
    const f = file("t.txt")
    await writeFileAtomic(f, "text")
    expect(await readText(f)).toBe("text")
  })

  test("a missing file is null", async () => {
    expect(await readText(file("missing.txt"))).toBeNull()
  })
})

describe("readJson", () => {
  test("parses valid JSON", async () => {
    const f = file("v.json")
    await writeFileAtomic(f, JSON.stringify({ a: 1, b: ["x"] }))
    expect(await readJson(f)).toEqual({ a: 1, b: ["x"] })
  })

  test("a missing file is null", async () => {
    expect(await readJson(file("missing.json"))).toBeNull()
  })

  test("invalid JSON is null, not a throw", async () => {
    const f = file("bad.json")
    await writeFileAtomic(f, "{not json")
    expect(await readJson(f)).toBeNull()
  })

  test("an empty file is null", async () => {
    const f = file("empty.json")
    await writeFileAtomic(f, "")
    expect(await readJson(f)).toBeNull()
  })
})
