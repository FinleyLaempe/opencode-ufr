# CLAUDE.md — opencode-ufr

Local gateway + opencode plugin for Uni Freiburg's Open WebUI API
(`openwebui.uni-freiburg.de`). Replaces the author's former self-hosted
LiteLLM proxy. Public repo — anything committed is published.

Design notes (spec, plan) are kept outside the published tree
(`docs/superpowers/`, local only) — agents should not expect them here.

## Commands

```bash
bun install
bun test                      # all tests, no network, no VPN, no keyring
bunx tsc --noEmit             # typecheck
OPENCODE_UFR_HOME=/tmp/ufr-dev bun src/daemon/main.ts   # run the daemon isolated
scripts/release.sh <version>  # bump package.json, commit, tag v<version>, push —
                              # .github/workflows/release.yml does the rest
```

Releases are tag-driven: the workflow verifies on ubuntu/macos/windows,
publishes to npm via OIDC trusted publishing (no `NPM_TOKEN` secret), then
creates the GitHub release with notes and the packed tarball. Approval
happens on npm's side (staged publish + 2FA), not in the Actions UI. The
workflow fails if the tag does not match `package.json`'s version.

`OPENCODE_UFR_HOME` puts config, state, cache and stats under one directory —
use it for every manual experiment so a real install is never touched.

## Layout

| path | what |
|---|---|
| `src/daemon/` | the gateway: `router.ts` is the request path, `daemon.ts` wires everything |
| `src/plugin/` | opencode plugin — only starts the daemon, registers the provider and watches /connect |
| `src/shared/` | config, paths, secrets, connect + key lifecycle, models.json schema — used by daemon and plugin |
| `models.json` | maintained model facts, ships with the package — installs never pull it remotely (see below) |
| `scripts/` | `release.sh`, `probe-all-contexts.ts` (the primary CI probe), `import-overrides.ts`, measurement scripts `probe-*.py` (run inside the uni network or VPN) |
| `test/support/fake-ufr.ts` | fake UFR server — every behaviour below is reproduced there |

## UFR facts (measured — keep this table current)

| fact | measured |
|---|---|
| per-key bucket: **no longer measurable at the 20/min level** — paced traffic (5 req/s, 80 requests in 20 s) and bursts of 80 never got a 429 on glm-5.3-flash / deepseek-v4.1-flash; only a 250-parallel burst on glm got 429s ("Current limit: 20", `Retry-After: 60`) next to backend pool errors (400/500) | 2026-11-09 (one key; was 20 per rolling 60 s on 2026-09-28) |
| one API key per UFR account → more throughput needs more accounts | 2026-09-28 |
| every 429 seen so far: bucket, model wall and daily $ cap share the `budget_exceeded` body, `Content-Type: text/plain`, **no `Retry-After`** (2026-09-28); the glm burst 429 of 2026-11-09 was JSON (`type: throttling_error`, "Limit resets at …") **with** `Retry-After: 60` | 2026-09-28 / 2026-11-09 |
| cached prompt tokens: `usage.prompt_tokens_details.cached_tokens` is reported by glm-5.3-flash, deepseek-v4.1-flash and the OpenAI models; cached reads are **free** on glm and deepseek (portal), OpenAI cache write luna = $0.125/Mtok (declared price confirmed); deepseek bills uncached input = cache writes at $0.025/Mtok, glm $0.10/Mtok | 2026-11-09 |
| the ~900 req/h pooled model-group wall is gone (README: verified 2026-10-06); not re-tested at higher volume | 2026-10-06 |
| **off the VPN every path answers `HTTP 200` + HTML "VPN erforderlich"** | 2026-09-28 |
| off the VPN the front proxy answers requests up to ~0.9 MiB with the VPN page (200) and **bodies over 1 MiB with an HTML `413 Request Entity Too Large`** (921 581 B → 200, 1 126 381 B → 413, unauthenticated POST) — a 413 means "VPN not connected", not "request too large"; no body size limit has been observed on the real route (780 KB bodies passed 2026-11-09) | 2026-11-10 |
| glm-5.3-flash: input and output (incl. reasoning) $0.10/Mtok, cached reads free (portal-measured; was $0.40 on 2026-09-28, then with no cache discount); glm-5.2 still $0.40, not re-measured | 2026-11-09, portal |
| no cost or rate-limit headers; streams send a `usage` chunk when `stream_options.include_usage` is set (`cached_tokens` now present, see above) | 2026-11-09 |
| portal shows spend only as % of $20/day per key, two decimals | 2026-09-28 |
| UFR's server clock runs ~70 s fast | 2026-09-28 |
| context probe: one oversized request is refused **before pricing** (740 ms, x-process-time 0) and names the exact limit — rejected probes are free and don't consume the key bucket | 2026-10-05 |

## Rules

- **Never write, log or print a UFR key.** Keys live only in the OS keyring
  (`Bun.secrets`, service `opencode-ufr`). Error messages name the alias, never the value.
- **Tests never talk to the real UFR.** New UFR behaviour → reproduce it in
  `test/support/fake-ufr.ts` first, then write the test.
- **No `Date.now()` inside `src/daemon/`** — take `now` from the deps so tests run on a fake clock.
- **No runtime dependencies.** Bun built-ins only; it must run on opencode's embedded Bun.
- **models.json ships with the package — installs never pull it remotely.** Every change must
  pass `bun test test/unit/models-file.test.ts test/unit/models-json.test.ts`;
  bump `updated`; put the measurement source in the entry's `note`.
- **The built-in VPN lives in `src/daemon/vpn/`;** all upstream traffic flows
  through `src/daemon/transport.ts` — keep it that way.
- **CI runs on GitHub-hosted runners only.** Never self-hosted (fork PRs would run code on the runner's host).
- When a UFR fact is re-measured: update the table above, the spec's "Verified facts"
  (local spec, gitignored — skip if absent), and the fake UFR, in the same commit.
