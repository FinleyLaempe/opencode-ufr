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
OPENCODE_UFR_HOME=/tmp/ufr-dev bun bin/ufr.ts status
scripts/release.sh <version>  # bump package.json, commit, tag v<version>, push —
                              # .github/workflows/release.yml does the rest
```

Releases are tag-driven: the workflow verifies on ubuntu/macos/windows,
publishes to npm in the gated `npm` environment (manual approval in the
Actions UI), then creates the GitHub release with notes and the packed
tarball. Prerequisites: repo secret `NPM_TOKEN`, environment `npm` with a
required reviewer. The workflow fails if the tag does not match
`package.json`'s version.

`OPENCODE_UFR_HOME` puts config, state, cache and stats under one directory —
use it for every manual experiment so a real install is never touched.

## Layout

| path | what |
|---|---|
| `src/daemon/` | the gateway: `router.ts` is the request path, `daemon.ts` wires everything |
| `src/plugin/` | opencode plugin — only starts the daemon and registers the provider |
| `src/cli/` | `ufr` CLI |
| `src/shared/` | config, paths, secrets, models.json schema — used by all three |
| `models.json` | maintained model facts, fetched live by every install (see below) |
| `scripts/` | `import-overrides.ts`, measurement scripts `probe-*.py` (run inside the uni network or VPN) |
| `test/support/fake-ufr.ts` | fake UFR server — every behaviour below is reproduced there |

## UFR facts (measured — keep this table current)

| fact | measured |
|---|---|
| per-key bucket: **20 requests per rolling 60 s**, across all models; frees at first admission + 60 s; rejected requests do not count | 2026-09-28 (was 60 on 2026-08-24) |
| one API key per UFR account → more throughput needs more accounts | 2026-09-28 |
| every 429 (bucket, model wall, daily $ cap) is the same `budget_exceeded` body, `Content-Type: text/plain`, **no `Retry-After`** | 2026-09-28 |
| sustained wall above ~900 req/h pooled, per model group, recovery unclear | 2026-09-21 (n = 2) |
| **off the VPN every path answers `HTTP 200` + HTML "VPN erforderlich"** | 2026-09-28 |
| glm-5.2 / glm-5.3-flash: input, output (incl. reasoning) and prefix-cached input all $0.40/Mtok — no cache discount | 2026-09-28, portal |
| no `cached_tokens`, no cost or rate-limit headers; streams send a `usage` chunk when `stream_options.include_usage` is set | 2026-09-28 |
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
- **models.json is data other people's installs fetch live.** Every change must
  pass `bun test test/unit/models-file.test.ts test/unit/models-json.test.ts`;
  bump `updated`; put the measurement source in the entry's `note`.
- **VPN is not implemented yet** (planned). Everything reaches UFR through
  `src/daemon/transport.ts` — keep it that way.
- **CI runs on GitHub-hosted runners only.** Never self-hosted (fork PRs would run code on the runner's host).
- When a UFR fact is re-measured: update the table above, the spec's "Verified facts",
  and the fake UFR, in the same commit.
