import type { Config } from "../shared/config"
import type { VpnManager } from "./vpn/manager"

/**
 * How the daemon reaches UFR. "direct" only uses the OS network (user is on
 * the campus network or their own VPN). "auto" routes through the built-in
 * Fortinet tunnel (userspace TCP stack — no TUN, no routes, no admin rights)
 * whenever UFR is not reachable directly.
 */
export type Transport = { name: string; fetch(url: string, init?: RequestInit): Promise<Response> }

export const directTransport: Transport = { name: "direct", fetch: (url, init) => fetch(url, init) }

export function createTransport(cfg: Config["transport"], o: { vpn?: VpnManager | null } = {}): Transport {
  switch (cfg.type) {
    case "direct":
      return directTransport
    case "auto":
      return o.vpn?.transport() ?? directTransport
  }
}
