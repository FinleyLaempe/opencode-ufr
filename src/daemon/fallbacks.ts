import type { ModelsFile } from "../shared/models-file"
import type { Model } from "./model"

/**
 * Rate-limit fallbacks from one total order: a model may only fall back to
 * models strictly later in `free_escape_order`. That gives, for free: no
 * cycles, bounded length, and only maintainer-chosen targets. Hand-written
 * lists caused the author's former proxy's 2026-08-20 crash-loop and 2026-08-21 cascade.
 */
export function deriveChains(
  models: Map<string, Model>,
  fb: ModelsFile["fallbacks"],
  opts: { allowPaid: boolean },
): Map<string, string[]> {
  const order = fb.free_escape_order.filter((id) => {
    const t = models.get(id)
    return t !== undefined && (opts.allowPaid || t.tier === "free")
  })
  const chains = new Map<string, string[]>()
  for (const [id, m] of models) {
    if (id === fb.context_hub || !m.tools || !m.hasEntry) continue
    let targets = order.includes(id) ? order.slice(order.indexOf(id) + 1) : order.filter((t) => t !== id)
    targets = targets.filter((t) => !m.vision || models.get(t)!.vision).slice(0, fb.max_targets)
    if (targets.length > 0) chains.set(id, targets)
  }
  return chains
}

/** Context-overflow escapes: anything smaller than the hub may retry on it (one hop). */
export function deriveContextChains(
  models: Map<string, Model>,
  hub: string | null,
  opts: { allowPaid: boolean },
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!hub) return out
  const h = models.get(hub)
  if (!h || (h.tier === "paid" && !opts.allowPaid)) return out
  for (const [id, m] of models) if (id !== hub && m.tools && m.context < h.context) out.set(id, [hub])
  return out
}
