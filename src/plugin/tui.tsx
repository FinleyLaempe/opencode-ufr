/**
 * @jsxImportSource @opentui/solid
 *
 * TUI contribution: live gateway throughput in opencode's sidebar. Loaded by
 * opencode's CLI because package.json exports "./tui" — the server plugin
 * (index.ts) needs no changes for this to load.
 *
 * Polls GET /v1/_status every second and appends lines to the right panel:
 * one compact line per pool key (alias, $ spent today or the real spend from
 * UFR's budget error, daily budget in USD, why it is blocked) above the
 * per-minute rates line (raw counts of the gateway's rolling 60 s window).
 * Status polls don't reset the daemon's idle timer (see server.ts),
 * so leaving the panel open never keeps the gateway alive.
 */
import { Plugin } from "@opencode/plugin/tui"
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import { daemonRequest } from "../shared/daemon-client"
import { resolvePaths, type Paths } from "../shared/paths"

/** The rates block of GET /v1/_status (see StatusJson in daemon.ts). */
type Rates = {
  windowMs: number
  /** Raw window counts — a 60 s window, so these ARE the per-minute numbers. */
  requests: number
  reqPerSec: number
  tokensInPerSec: number
  tokensOutPerSec: number
}

/** Per-key line of GET /v1/_status (KeySnapshot in keypool.ts). */
type KeyStatus = {
  alias: string
  used: number
  cap: number
  blockedForMs: number
  blockedBy: "budget" | "rate" | null
  invalid: boolean
  /** Real spend/limit parsed from UFR's ExceededBudget error; present only
   *  while a budget block with parsed data is active (see keypool.ts). */
  budgetSpend?: number
  budgetLimit?: number
}

/** GET /v1/_status — only the fields the sidebar consumes. */
type Status = {
  rates?: Rates
  keys?: KeyStatus[]
  spendToday?: Record<string, number>
  dailyBudgetUsd?: number
}

const POLL_MS = 1_000

/** 6743 → "6.7k" — prompt traffic through opencode dwarfs output. */
function fmtTokens(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}

/** 0.4166 → "$0.42" — money is always shown with 2 decimals. */
function fmtMoney(v: number): string {
  return `$${v.toFixed(2)}`
}

/**
 * One compact line per pool key: `k1 $0.42/$20.00`, with the reason appended when
 * the key is unusable — `budget` (daily cap hit, resets at local midnight),
 * `rate` (bucket 429 cool-down) or `invalid` (transient 401). A key blocked by
 * the real ExceededBudget error shows UFR's parsed numbers instead of today's
 * estimate: `k1 $24.04/$20.00 budget` — spend data is the more actionable info,
 * so it wins over the `invalid` suffix (which is then just appended). A key with
 * no entry in spendToday renders as $0.00; healthy keys render too, the user
 * asked to see every key.
 */
function keyLine(k: KeyStatus, s: Status): string {
  // Parsed budget numbers come straight from UFR's error body; the fallback is
  // today's local spend estimate against the configured daily budget.
  const spend = k.budgetSpend ?? s.spendToday?.[k.alias] ?? 0
  const limit = k.budgetLimit ?? s.dailyBudgetUsd ?? 0
  let line = `${k.alias} ${fmtMoney(spend)}/${fmtMoney(limit)}`
  if (k.budgetSpend !== undefined) line += " budget"
  else if (k.invalid) line += " invalid"
  else if (k.blockedBy === "budget") line += " budget"
  else if (k.blockedBy === "rate") line += " rate"
  // Spend data outranks the transient-invalid suffix, but invalid stays visible.
  if (k.budgetSpend !== undefined && k.invalid) line += " invalid"
  return line
}

/** Budget-exhausted keys render red; everything else keeps the default color. */
function keyColor(k: KeyStatus): string | undefined {
  return k.blockedBy === "budget" ? "red" : undefined
}

function RatesLine(props: { paths: Paths }) {
  const [status, setStatus] = createSignal<Status | null>(null)
  let busy = false
  const poll = async () => {
    if (busy) return
    busy = true
    try {
      const res = await daemonRequest(props.paths, (u, i) => fetch(u, i), "/v1/_status")
      if (!res?.ok) {
        setStatus(null) // daemon down, restarting or new token — the lines hide
        return
      }
      setStatus((await res.json()) as Status)
    } finally {
      busy = false
    }
  }
  let timer: ReturnType<typeof setInterval> | undefined
  onMount(() => {
    void poll()
    timer = setInterval(() => void poll(), POLL_MS)
  })
  onCleanup(() => clearInterval(timer))
  const label = () => {
    const r = status()?.rates
    if (!r) return null
    // The daemon's rates window is exactly 60 s, so the raw request count IS
    // req/min; the per-second token numbers ×60 give the same window counts
    // (daemon.ts rounds them, invisible at fmtTokens precision).
    const perMin = (perSec: number) => Math.round(perSec * 60)
    return `UFR ${r.requests} req/min · ${fmtTokens(perMin(r.tokensOutPerSec))} tok/min out · ${fmtTokens(perMin(r.tokensInPerSec))} tok/min in`
  }
  return (
    <Show when={status()}>
      <For each={status()!.keys ?? []}>
        {(k) => (
          <text fg={keyColor(k)}>{keyLine(k, status()!)}</text>
        )}
      </For>
      <text>{label()}</text>
    </Show>
  )
}

export default Plugin.define({
  id: "opencode-ufr.stats",
  setup(context) {
    const paths = resolvePaths()
    return context.ui.slot({
      append: "sidebar.content",
      render: () => <RatesLine paths={paths} />,
    })
  },
})
