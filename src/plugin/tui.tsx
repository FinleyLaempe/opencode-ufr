/**
 * TUI contribution: live gateway throughput in opencode's sidebar. Loaded by
 * opencode's CLI because package.json exports "./tui" — the server plugin
 * (index.ts) needs no changes for this to load.
 *
 * Polls GET /v1/_status every second and appends one line to the right
 * panel: req/s and tok/s over the gateway's rolling 60 s window. Status
 * polls don't reset the daemon's idle timer (see server.ts), so leaving the
 * panel open never keeps the gateway alive.
 */
import { Plugin } from "@opencode/plugin/tui"
import { createSignal, onCleanup, onMount, Show } from "solid-js"
import { daemonRequest } from "../shared/daemon-client"
import { resolvePaths, type Paths } from "../shared/paths"

/** The rates block of GET /v1/_status (see StatusJson in daemon.ts). */
type Rates = {
  windowMs: number
  requests: number
  reqPerSec: number
  tokensInPerSec: number
  tokensOutPerSec: number
}

const POLL_MS = 1_000

/** 6743 → "6.7k" — prompt traffic through opencode dwarfs output. */
function fmtTokens(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(1)}k` : String(v)
}

function RatesLine(props: { paths: Paths }) {
  const [rates, setRates] = createSignal<Rates | null>(null)
  let busy = false
  const poll = async () => {
    if (busy) return
    busy = true
    try {
      const res = await daemonRequest(props.paths, (u, i) => fetch(u, i), "/v1/_status")
      if (!res?.ok) {
        setRates(null) // daemon down, restarting or new token — the line hides
        return
      }
      const j = (await res.json()) as { rates?: Rates }
      setRates(j.rates ?? null)
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
    const r = rates()
    if (!r) return null
    return `UFR ${r.reqPerSec} req/s · ${fmtTokens(r.tokensOutPerSec)} tok/s out · ${fmtTokens(r.tokensInPerSec)} tok/s in`
  }
  return (
    <Show when={label()}>
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
