import { parseArgs } from "node:util"
import type { FetchLike } from "../daemon/catalog-source"
import { type Paths, resolvePaths } from "../shared/paths"
import { KeyringStore, type SecretStore } from "../shared/secrets"
import { cmdCatalogDiff } from "./catalog"
import { type Io, terminalIo } from "./io"
import { cmdKeys } from "./keys"
import { cmdSetup } from "./setup"
import { cmdStats } from "./stats"
import { cmdStatus } from "./status"
import { cmdStop } from "./stop"

export type CliDeps = {
  paths: Paths
  secrets: SecretStore
  io: Io
  fetch: FetchLike
  now: () => number
  runOpencode: (args: string[]) => Promise<number>
}

const HELP = `ufr — opencode-ufr gateway

  ufr setup                        guided first-run setup
  ufr keys add <alias>             store a UFR API key in the OS keyring
  ufr keys list | remove <alias> | test [alias]
  ufr status                       gateway, keys, limits, breakers, spend today
  ufr stats [--days N]             requests, tokens and cost (default: today)
  ufr catalog diff                 UFR's model list vs. models.json
  ufr stop                         stop the gateway (opencode starts it again)

UFR needs the uni VPN off campus: https://wiki.uni-freiburg.de/rz/doku.php?id=vpn
`

async function runOpencode(args: string[]): Promise<number> {
  const p = Bun.spawn(["opencode", ...args], { stdio: ["inherit", "inherit", "inherit"] })
  return await p.exited
}

export async function main(argv: string[], partial: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = {
    paths: resolvePaths(),
    secrets: new KeyringStore(),
    io: terminalIo(),
    fetch: (u, i) => fetch(u, i),
    now: Date.now,
    runOpencode,
    ...partial,
  }
  const [cmd, ...rest] = argv
  try {
    switch (cmd) {
      case "setup":
        return await cmdSetup(d)
      case "keys":
        return await cmdKeys(d, rest)
      case "status":
        return await cmdStatus(d)
      case "stats": {
        const { values } = parseArgs({ args: rest, options: { days: { type: "string", default: "1" } } })
        const days = Number(values.days)
        if (!Number.isFinite(days) || days <= 0) {
          d.io.err("--days must be a positive number\n")
          return 2
        }
        return await cmdStats(d, days)
      }
      case "catalog":
        if (rest[0] === "diff") return await cmdCatalogDiff(d)
        d.io.err("usage: ufr catalog diff\n")
        return 2
      case "stop":
        return await cmdStop(d)
      case undefined:
      case "help":
      case "--help":
      case "-h":
        d.io.out(HELP)
        return 0
      default:
        d.io.err(`unknown command: ${cmd}\n\n${HELP}`)
        return 2
    }
  } catch (e) {
    d.io.err(`error: ${(e as Error).message}\n`)
    return 1
  }
}
