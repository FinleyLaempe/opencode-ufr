import { existsSync } from "node:fs"
import { Stats, type SummaryRow } from "../daemon/stats"
import { loadConfig } from "../shared/config"
import { startOfLocalDay } from "../shared/time"
import type { CliDeps } from "./index"

function table(label: string, rows: SummaryRow[], budget: number, showPct: boolean): string {
  if (rows.length === 0) return `${label}: no requests\n`
  const lines = rows.map((r) => {
    const cost = `$${r.costUsd.toFixed(4)}${r.unpriced ? ` +${r.unpriced} unpriced` : ""}`
    const pct = showPct && budget > 0 ? `  ${((r.costUsd / budget) * 100).toFixed(2)}% of $${budget} (est.)` : ""
    return `  ${r.name.padEnd(36)} ${String(r.requests).padStart(6)} req ${String(r.errors).padStart(5)} err ` +
      `${String(r.promptTokens).padStart(11)} in ${String(r.completionTokens).padStart(9)} out  ${cost}${pct}`
  })
  return `${label}\n${lines.join("\n")}\n`
}

export async function cmdStats(d: CliDeps, days: number): Promise<number> {
  if (!existsSync(d.paths.statsDb)) {
    d.io.out("no stats yet — the gateway records requests once opencode uses it\n")
    return 0
  }
  const cfg = await loadConfig(d.paths.configFile)
  const stats = new Stats(d.paths.statsDb)
  try {
    const today = days === 1
    const since = today ? startOfLocalDay(d.now()) : d.now() - days * 86_400_000
    const { byModel, byKey } = stats.summary(since)
    d.io.out(`${today ? "today (since local midnight)" : `last ${days} days`}\n\n`)
    d.io.out(table("per model", byModel, cfg.dailyBudgetUsd, false))
    d.io.out("\n")
    d.io.out(table("per key", byKey, cfg.dailyBudgetUsd, today))
    return 0
  } finally {
    stats.close()
  }
}
