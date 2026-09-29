import { loadConfig } from "../shared/config"
import { VPN_MESSAGE } from "../shared/vpn"
import type { CliDeps } from "./index"
import { addKey, applyKeyChange } from "./keys"
import { checkChat } from "./ufr-check"

const PROBE_MODEL = "gemma-4-31b-llmlb" // free and fast; one call with max_tokens 1
// Not on npm yet — install straight from GitHub. Switch to "opencode-ufr" once it is on npm.
const PLUGIN_SPEC = "github:FinleyLaempe/opencode-ufr"

export async function cmdSetup(d: CliDeps): Promise<number> {
  const io = d.io
  io.out("opencode-ufr setup\n\nYou need a UFR API key (Open WebUI → Settings → Account → API keys) and,\n" +
    "off campus, a connection to the uni VPN. One key per UFR account.\n\n")
  let cfg = await loadConfig(d.paths.configFile)
  let added = false
  for (;;) {
    const fallback = cfg.keys.length === 0 ? "main" : `key${cfg.keys.length + 1}`
    const alias = (await io.prompt(`alias for this key [${fallback}]: `)).trim() || fallback
    if ((await addKey(d, alias)) === 0) added = true
    else io.err("key not added\n")
    cfg = await loadConfig(d.paths.configFile)
    if (!(await io.confirm("add a key from another UFR account?"))) break
  }
  if (added) await applyKeyChange(d)
  if (cfg.keys.length === 0) {
    io.err("no key configured — run `ufr setup` again\n")
    return 1
  }
  const key = await d.secrets.get(cfg.keys[0]!)
  const r = key ? await checkChat(d.fetch, cfg.upstream.baseUrl, key, PROBE_MODEL) : "unreachable"
  if (r === "vpn") io.out(`\n${VPN_MESSAGE}\nThe plugin works as soon as the VPN is up.\n`)
  else if (r === "ok" || r === "rate_limited") io.out("\nUFR chat reachable.\n")
  else io.out(`\nUFR chat check: ${r}\n`)
  if (await io.confirm(`register the plugin with opencode now (\`opencode plugin add ${PLUGIN_SPEC}\`)?`)) {
    const code = await d.runOpencode(["plugin", "add", PLUGIN_SPEC])
    if (code !== 0) io.err(`opencode plugin add exited with ${code} — add "${PLUGIN_SPEC}" to "plugins" in opencode.json yourself\n`)
  }
  io.out("\ndone. Start opencode; `ufr status` shows the gateway.\n")
  return 0
}
