import { daemonRequest } from "./daemon-client"
import type { CliDeps } from "./index"

export async function cmdStop(d: CliDeps): Promise<number> {
  const res = await daemonRequest(d.paths, d.fetch, "/v1/_shutdown", "POST")
  d.io.out(res?.ok ? "gateway stopping — opencode starts it again when needed\n" : "gateway not running\n")
  return 0
}
