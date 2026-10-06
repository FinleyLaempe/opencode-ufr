/**
 * Builds the TUI contribution (src/plugin/tui.tsx) into a self-contained
 * dist/tui.js for publishing.
 *
 * Why precompile: opencode's TUI runtime applies its Solid JSX transform
 * (babel-preset-solid, moduleName "@opentui/solid", generate "universal")
 * only to files OUTSIDE node_modules — and npm plugin installs live inside
 * node_modules. A raw .tsx "./tui" export therefore falls through to Bun's
 * default React JSX transform and the plugin fails to load with
 * "Cannot find package 'react'" (observed on opencode v2.0.23). Compiling
 * with the same transform opencode uses removes JSX entirely, so the
 * artifact loads under any loader that can import plain JS and resolve the
 * peer dependencies (solid-js, @opentui/*).
 */
import babel from "@babel/core"
import presetTS from "@babel/preset-typescript"
import presetSolid from "babel-preset-solid"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const ENTRY = join(ROOT, "src/plugin/tui.tsx")
const OUT = join(ROOT, "dist/tui.js")

/** Resolved at runtime from the host's own dependency tree — never bundled. */
const EXTERNAL = [
  "@opencode/plugin",
  "@opencode/plugin/tui",
  "@opentui/core",
  "@opentui/solid",
  "solid-js",
  "solid-js/web",
  "solid-js/store",
]

export async function buildTui(): Promise<string> {
  const src = await Bun.file(ENTRY).text()
  const transformed = babel.transformSync(src, {
    filename: ENTRY,
    configFile: false,
    babelrc: false,
    presets: [
      [presetTS, {}],
      // Exactly the config opencode's TUI runtime uses for its own Solid code.
      [presetSolid, { moduleName: "@opentui/solid", generate: "universal" }],
    ],
  })
  if (!transformed?.code) throw new Error("babel produced no output for tui.tsx")

  // Bundle the transformed JS (no JSX left) so dist/tui.js has no relative
  // imports that could break once installed somewhere else. The staged file
  // sits beside the source so its ../shared imports resolve during bundling.
  const staged = join(ROOT, "src/plugin/tui.staged.build.js")
  await Bun.write(staged, transformed.code)
  try {
    const result = await Bun.build({
      entrypoints: [staged],
      target: "bun",
      format: "esm",
      external: EXTERNAL,
    })
    if (!result.success) {
      for (const log of result.logs) console.error(log)
      throw new Error("bun build failed for the TUI contribution")
    }
    const js = result.outputs[0]
    if (!js) throw new Error("bun build produced no output for the TUI contribution")
    await Bun.write(OUT, await js.text())
  } finally {
    await Bun.file(staged).delete().catch(() => {})
  }
  return OUT
}

if (import.meta.main) {
  const out = await buildTui()
  console.log(`built ${out}`)
}
