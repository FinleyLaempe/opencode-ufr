import { BreakerRegistry } from "../../src/daemon/breaker"
import { buildCatalog, parseUfrModels } from "../../src/daemon/catalog"
import { KeyPool } from "../../src/daemon/keypool"
import { Router } from "../../src/daemon/router"
import { Stats } from "../../src/daemon/stats"
import { type Transport, directTransport } from "../../src/daemon/transport"
import { SlidingWindow } from "../../src/daemon/window"
import { type Config, mergeConfig } from "../../src/shared/config"
import { FakeClock } from "./clock"
import { FakeUfr, type FakeUfrOptions } from "./fake-ufr"
import { TEST_MODELS_FILE, UFR_RAW_MODELS } from "./models"

/** A Router wired to a fake UFR and a fake clock; sleeps advance the clock instantly. */
export function routerEnv(o: { keys?: string[]; config?: Record<string, unknown>; ufr?: FakeUfrOptions; transport?: Transport } = {}) {
  const ufr = FakeUfr.start({ bucket: 1_000, ...o.ufr })
  const clock = new FakeClock(Date.now())
  const config: Config = mergeConfig({ ...o.config, upstream: { baseUrl: ufr.baseUrl, requestTimeoutS: 10 } })
  const keys = new KeyPool(
    (o.keys ?? ["key-a", "key-b", "key-c"]).map((secret, i) => ({ alias: `k${i + 1}`, secret })),
    { cap: config.limits.keyRpm, windowMs: config.limits.keyWindowS * 1000, maxWaitMs: config.limits.keyMaxWaitS * 1000, now: clock.now },
  )
  const pool = new SlidingWindow({
    cap: config.limits.poolPerHour,
    windowMs: config.limits.poolWindowS * 1000,
    maxWaitMs: config.limits.poolMaxWaitS * 1000,
    now: clock.now,
  })
  const breakers = new BreakerRegistry({
    tripThreshold: config.breaker.tripThreshold,
    ladderMs: config.breaker.ladderS.map((s) => s * 1000),
    probeTimeoutMs: config.breaker.probeTimeoutS * 1000,
    now: clock.now,
  })
  const catalog = buildCatalog(parseUfrModels(UFR_RAW_MODELS), TEST_MODELS_FILE, { allowPaid: config.allowPaid })
  const stats = new Stats(":memory:")
  const sleeps: number[] = []
  const reach: { ok: boolean; message: string }[] = []
  const router = new Router({
    config,
    catalog: () => catalog,
    keys,
    pool,
    breakers,
    stats,
    transport: o.transport ?? directTransport,
    now: clock.now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw new Error("aborted")
      sleeps.push(ms)
      clock.advance(ms)
    },
    onUpstream: (ok, message) => reach.push({ ok, message }),
  })
  const chat = (body: Record<string, unknown>, signal?: AbortSignal) =>
    router.handleChat({ messages: [{ role: "user", content: "Hi" }], ...body }, signal)
  return { ufr, clock, config, keys, pool, breakers, catalog, stats, router, chat, sleeps, reach, stop: () => ufr.stop() }
}

export async function errorOf(res: Response): Promise<{ type: string; message: string }> {
  return ((await res.json()) as { error: { type: string; message: string } }).error
}
