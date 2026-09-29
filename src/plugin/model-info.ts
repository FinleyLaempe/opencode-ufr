import type { OpencodeStamp } from "../daemon/catalog"

/** Map a daemon stamp onto opencode's V2 Model.Info shape (as of opencode 2.0.18). */
export function toModelInfo(providerID: string, id: string, s: Omit<OpencodeStamp, "cost"> & { cost?: OpencodeStamp["cost"] }) {
  return {
    id,
    modelID: id,
    providerID,
    name: s.name,
    capabilities: {
      tools: s.tool_call,
      input: s.attachment ? ["text", "image"] : ["text"],
      output: ["text"],
    },
    limit: { context: s.limit.context, output: s.limit.output },
    // Required: Model.snapshot() sorts the whole registry on time.released, so a
    // model without it crashes model resolution for *every* provider. UFR has no
    // release dates; 0 means unknown and keeps the sort deterministic.
    time: { released: 0 },
    // Required as an array even when empty: one entry without variants makes the
    // server reject the whole /model list, and the picker shows nothing.
    variants: [],
    status: "active",
    enabled: true,
    // Always an array with every nested object present: opencode dereferences
    // cost[].cache.read unguarded when it tallies a step, after the model replied.
    cost: [
      {
        input: s.cost?.input ?? 0,
        output: s.cost?.output ?? 0,
        cache: { read: s.cost?.cache_read ?? 0, write: s.cost?.cache_write ?? 0 },
      },
    ],
  }
}
