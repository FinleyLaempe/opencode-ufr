import type { UfrModel } from "../daemon/catalog"
import { BUNDLED_MODELS, loadBundledModels, loadUfrModels } from "../daemon/catalog-source"
import { loadConfig } from "../shared/config"
import type { ModelsFile } from "../shared/models-file"
import type { CliDeps } from "./index"

export function diffCatalog(ufr: UfrModel[], file: ModelsFile) {
  const served = new Set(ufr.map((u) => u.id))
  const aliasSpellings = new Set(Object.keys(file.aliases))
  const canonical = ufr.filter((u) => !aliasSpellings.has(u.id))
  return {
    added: canonical.filter((u) => !file.models[u.id]).map((u) => u.id),
    gone: Object.keys(file.models).filter((id) => !served.has(id)),
    vision: canonical
      .filter((u) => file.models[u.id]?.vision !== undefined && file.models[u.id]!.vision !== u.vision)
      .map((u) => ({ id: u.id, ufr: u.vision, ours: file.models[u.id]!.vision! })),
    unpriced: canonical.filter((u) => !file.models[u.id]?.price).map((u) => u.id),
  }
}

export async function cmdCatalogDiff(d: CliDeps): Promise<number> {
  const cfg = await loadConfig(d.paths.configFile)
  const alias = cfg.keys[0]
  const key = alias ? await d.secrets.get(alias) : null
  if (!key) {
    d.io.err("catalog diff needs a key — run `ufr keys add <alias>`\n")
    return 1
  }
  const log = (m: string) => d.io.err(`${m}\n`)
  const mf = await loadBundledModels({ bundledPath: BUNDLED_MODELS })
  const ufr = await loadUfrModels({ baseUrl: cfg.upstream.baseUrl, key, cachePath: d.paths.ufrModelsCache, fetch: d.fetch, log })
  if (ufr.source !== "remote") {
    d.io.err(`cannot read UFR's live model list: ${ufr.error}\n`)
    return 1
  }
  const diff = diffCatalog(ufr.models, mf.file)
  d.io.out(`models.json from ${mf.source}, ${ufr.models.length} models at UFR\n`)
  for (const id of diff.added) d.io.out(`+ ${id}  (new at UFR, no models.json entry)\n`)
  for (const id of diff.gone) d.io.out(`- ${id}  (in models.json, no longer at UFR)\n`)
  for (const v of diff.vision) d.io.out(`~ ${v.id}  vision: UFR says ${v.ufr}, models.json says ${v.ours}\n`)
  for (const id of diff.unpriced) d.io.out(`$ ${id}  (no price — cost unknown)\n`)
  if (!diff.added.length && !diff.gone.length) d.io.out("no models added or removed\n")
  return diff.added.length || diff.gone.length ? 1 : 0
}
