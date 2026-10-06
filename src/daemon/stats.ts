import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ModelPrice } from "./model"

export type RequestRow = {
  ts: number
  model: string
  keyAlias: string | null
  status: number
  promptTokens: number
  completionTokens: number
  costUsd: number | null
  latencyMs: number
  attempts: number
  errorType: string | null
  poolAdmitted: boolean
}

export type SummaryRow = {
  name: string
  requests: number
  errors: number
  promptTokens: number
  completionTokens: number
  costUsd: number
  unpriced: number
}

/** Prompt tokens are all billed at the input price — UFR has no cache discount. */
export function costUsd(price: ModelPrice | null, promptTokens: number, completionTokens: number): number | null {
  if (!price) return null
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000
}

export class Stats {
  private readonly db: Database

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
    this.db = new Database(path, { create: true })
    if (path !== ":memory:") this.db.exec("PRAGMA journal_mode = WAL")
    this.db.exec(`CREATE TABLE IF NOT EXISTS requests (
      ts INTEGER NOT NULL, model TEXT NOT NULL, key_alias TEXT, status INTEGER NOT NULL,
      prompt_tokens INTEGER NOT NULL, completion_tokens INTEGER NOT NULL, cost_usd REAL,
      latency_ms INTEGER NOT NULL, attempts INTEGER NOT NULL, error_type TEXT, pool_admitted INTEGER NOT NULL)`)
    this.db.exec("CREATE INDEX IF NOT EXISTS requests_ts ON requests(ts)")
    this.db.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)")
  }

  record(r: RequestRow): void {
    this.db
      .query(
        `INSERT INTO requests (ts, model, key_alias, status, prompt_tokens, completion_tokens, cost_usd,
         latency_ms, attempts, error_type, pool_admitted) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.ts, r.model, r.keyAlias, r.status, r.promptTokens, r.completionTokens, r.costUsd,
        Math.round(r.latencyMs), r.attempts, r.errorType, r.poolAdmitted ? 1 : 0)
  }

  /** Admission times for rebuilding the pool window after a restart. */
  poolAdmissionsSince(sinceTs: number): number[] {
    // ts >= like spendByKeySince/summary — "since" is inclusive everywhere
    const rows = this.db.query("SELECT ts FROM requests WHERE pool_admitted = 1 AND ts >= ? ORDER BY ts").all(sinceTs) as { ts: number }[]
    return rows.map((r) => r.ts)
  }

  spendByKeySince(sinceTs: number): Record<string, number> {
    const rows = this.db
      .query("SELECT key_alias AS k, COALESCE(SUM(cost_usd), 0) AS c FROM requests WHERE ts >= ? AND key_alias IS NOT NULL GROUP BY key_alias")
      .all(sinceTs) as { k: string; c: number }[]
    return Object.fromEntries(rows.map((r) => [r.k, r.c]))
  }

  summary(sinceTs: number): { byModel: SummaryRow[]; byKey: SummaryRow[] } {
    const q = (col: string) =>
      this.db
        .query(
          `SELECT ${col} AS name, COUNT(*) AS requests,
             SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END) AS errors,
             SUM(prompt_tokens) AS promptTokens, SUM(completion_tokens) AS completionTokens,
             COALESCE(SUM(cost_usd), 0) AS costUsd,
             SUM(CASE WHEN cost_usd IS NULL AND status < 400 THEN 1 ELSE 0 END) AS unpriced
           FROM requests WHERE ts >= ? GROUP BY ${col} ORDER BY costUsd DESC, requests DESC`,
        )
        .all(sinceTs) as SummaryRow[]
    return { byModel: q("model"), byKey: q("COALESCE(key_alias, '-')") }
  }

  /** Request and token totals in a window, for the live rates in /v1/_status. */
  rates(sinceTs: number): { requests: number; promptTokens: number; completionTokens: number } {
    return this.db
      .query(
        `SELECT COUNT(*) AS requests, COALESCE(SUM(prompt_tokens), 0) AS promptTokens,
           COALESCE(SUM(completion_tokens), 0) AS completionTokens
         FROM requests WHERE ts >= ?`,
      )
      .get(sinceTs) as { requests: number; promptTokens: number; completionTokens: number }
  }

  prune(beforeTs: number): number {
    return this.db.query("DELETE FROM requests WHERE ts < ?").run(beforeTs).changes
  }

  setKv(k: string, v: string): void {
    this.db.query("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v)
  }

  getKv(k: string): string | null {
    const r = this.db.query("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | null
    return r?.v ?? null
  }

  close(): void {
    this.db.close()
  }
}
