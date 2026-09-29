import type { Config } from "../shared/config"

/**
 * How the daemon reaches UFR. v1 only has `direct` — the user is on the uni VPN
 * or campus network. The built-in VPN (planned, later) implements this same
 * interface; nothing else in the daemon calls fetch towards UFR.
 */
export type Transport = { name: string; fetch(url: string, init: RequestInit): Promise<Response> }

export const directTransport: Transport = { name: "direct", fetch: (url, init) => fetch(url, init) }

export function createTransport(cfg: Config["transport"]): Transport {
  switch (cfg.type) {
    case "direct":
      return directTransport
  }
}
