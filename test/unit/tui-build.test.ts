import { describe, expect, test } from "bun:test"
import { buildTui } from "../../scripts/build-tui"

/**
 * opencode's TUI runtime only applies its Solid JSX transform to files
 * OUTSIDE node_modules, but npm plugin installs live inside node_modules —
 * so the ./tui export must ship precompiled JS, never raw .tsx. A raw .tsx
 * falls through to Bun's default React JSX transform and the plugin fails
 * with "Cannot find package 'react'" (observed on opencode v2.0.23).
 */
describe("tui build artifact", () => {
  test("compiles to self-contained JS with no JSX runtime imports", async () => {
    const out = await buildTui()
    const code = await Bun.file(out).text()

    // No JSX may be left for the loader to compile: any react/jsx-runtime
    // import would fail exactly like the raw .tsx did.
    expect(code).not.toMatch(/\breact\b/)
    expect(code).not.toMatch(/jsx-?(dev-)?runtime/)
    expect(code).not.toMatch(/jsxDEV/)

    // The Solid transform opencode itself uses (babel-preset-solid,
    // moduleName "@opentui/solid", generate "universal").
    expect(code).toMatch(/from "@opentui\/solid"/)
    expect(code).toMatch(/from "solid-js"/)

    // Self-contained: no relative imports that could break from dist/.
    expect(code).not.toMatch(/from "\.\.\//)
    expect(code).not.toMatch(/from "\.\//)
  })

  test("built module loads and defines the stats plugin", async () => {
    await buildTui()
    const mod = await import(`../../dist/tui.js?${Date.now()}`)
    const plugin = (mod as { default: { id: string } }).default
    expect(plugin.id).toBe("opencode-ufr.stats")
  })
})
