export interface SecretStore {
  get(alias: string): Promise<string | null>
  set(alias: string, value: string): Promise<void>
  delete(alias: string): Promise<boolean>
}

export const SERVICE = "opencode-ufr"

export class SecretStoreError extends Error {}

type Backend = {
  get(o: { service: string; name: string }): Promise<string | null>
  set(o: { service: string; name: string; value: string }): Promise<void>
  delete(o: { service: string; name: string }): Promise<boolean>
}

/** UFR keys in the OS keyring: macOS Keychain, Windows Credential Manager, libsecret on Linux. */
export class KeyringStore implements SecretStore {
  constructor(private readonly backend: Backend = Bun.secrets as unknown as Backend) {}

  private async run<T>(what: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn()
    } catch (e) {
      throw new SecretStoreError(
        `OS keyring unavailable while trying to ${what} (${(e as Error).message}). ` +
          "On Linux this needs a Secret Service (gnome-keyring or KWallet) running in your session.",
      )
    }
  }

  get(alias: string): Promise<string | null> {
    return this.run(`read key "${alias}"`, () => this.backend.get({ service: SERVICE, name: alias }))
  }

  async set(alias: string, value: string): Promise<void> {
    if (!value) throw new SecretStoreError("refusing to store an empty key")
    await this.run(`store key "${alias}"`, () => this.backend.set({ service: SERVICE, name: alias, value }))
  }

  delete(alias: string): Promise<boolean> {
    return this.run(`delete key "${alias}"`, () => this.backend.delete({ service: SERVICE, name: alias }))
  }
}

/** In-memory store for tests. */
export class MemoryStore implements SecretStore {
  private readonly m = new Map<string, string>()
  async get(alias: string): Promise<string | null> {
    return this.m.get(alias) ?? null
  }
  async set(alias: string, value: string): Promise<void> {
    this.m.set(alias, value)
  }
  async delete(alias: string): Promise<boolean> {
    return this.m.delete(alias)
  }
}
