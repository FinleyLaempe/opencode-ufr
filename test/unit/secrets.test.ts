import { describe, expect, test } from "bun:test"
import { KeyringStore, MemoryStore, SERVICE, SecretStoreError } from "../../src/shared/secrets"

function fakeBackend() {
  const m = new Map<string, string>()
  const calls: string[] = []
  return {
    calls,
    backend: {
      async get(o: { service: string; name: string }) {
        calls.push(`get ${o.service}/${o.name}`)
        return m.get(`${o.service}/${o.name}`) ?? null
      },
      async set(o: { service: string; name: string; value: string }) {
        calls.push(`set ${o.service}/${o.name}`)
        m.set(`${o.service}/${o.name}`, o.value)
      },
      async delete(o: { service: string; name: string }) {
        calls.push(`delete ${o.service}/${o.name}`)
        return m.delete(`${o.service}/${o.name}`)
      },
    },
  }
}

describe("secrets", () => {
  test("MemoryStore round-trips", async () => {
    const s = new MemoryStore()
    await s.set("main", "sk-1")
    expect(await s.get("main")).toBe("sk-1")
    expect(await s.delete("main")).toBe(true)
    expect(await s.get("main")).toBeNull()
  })

  test("KeyringStore uses service opencode-ufr and the alias as name", async () => {
    const { backend, calls } = fakeBackend()
    const s = new KeyringStore(backend)
    await s.set("main", "sk-secret")
    expect(await s.get("main")).toBe("sk-secret")
    expect(calls).toEqual([`set ${SERVICE}/main`, `get ${SERVICE}/main`])
  })

  test("refuses to store an empty key", async () => {
    const s = new KeyringStore(fakeBackend().backend)
    await expect(s.set("main", "")).rejects.toThrow(SecretStoreError)
  })

  test("keyring failures become a clear error without the key value", async () => {
    const broken = {
      get: async () => { throw new Error("no Secret Service") },
      set: async () => { throw new Error("no Secret Service") },
      delete: async () => { throw new Error("no Secret Service") },
    }
    const s = new KeyringStore(broken)
    let err: Error | undefined
    try {
      await s.set("main", "sk-must-not-leak")
    } catch (e) {
      err = e as Error
    }
    expect(err).toBeInstanceOf(SecretStoreError)
    expect(err?.message).toContain("keyring")
    expect(err?.message).toContain("main")
    expect(err?.message).not.toContain("sk-must-not-leak")
  })
})
