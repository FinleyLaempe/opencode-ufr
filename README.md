# opencode-ufr

An [opencode](https://opencode.ai) provider for Uni Freiburg's Open WebUI
models. A small local gateway runs on your machine, pools your UFR API
key(s), and handles UFR's rate limits and outages so opencode doesn't have to.

## Requirements

- opencode ≥ 2.0
- A UFR account and API key (Open WebUI → Settings → Account → API keys)
- [Bun](https://bun.sh) on your `PATH` for the `ufr` CLI. The plugin itself
  needs no Bun — it runs inside opencode.
- **The uni VPN when off campus.** Without it, UFR answers every request —
  including the model list — with its "VPN erforderlich" page, and
  `ufr status` will tell you so. See the RZ guide:
  https://wiki.uni-freiburg.de/rz/doku.php?id=vpn

## Install

Not on npm yet — install straight from GitHub:

```bash
bun add -g github:FinleyLaempe/opencode-ufr   # puts `ufr` on PATH
ufr setup
```

`ufr setup` walks you through adding one or more UFR API keys (stored in your
OS keyring, never on disk), checks that UFR is reachable, and runs
`opencode plugin add github:FinleyLaempe/opencode-ufr` for you.

Manual alternative — add to `opencode.json`:

```json
{ "plugins": ["github:FinleyLaempe/opencode-ufr"] }
```

or run `opencode plugin add github:FinleyLaempe/opencode-ufr` yourself, then
`ufr keys add <alias>`.

npm publication is planned; once it lands, `bunx opencode-ufr …` /
`npx opencode-ufr …` will work without a global install.

## Use

Models show up in opencode as `unifreiburg/<model>`, e.g.
`unifreiburg/ufr/coding-complex`. Everything else is the CLI:

```bash
ufr status       # gateway, keys, limits, breakers, spend today
ufr stats        # requests, tokens and cost
ufr keys test    # check your keys against UFR
```

The gateway starts itself the first time opencode needs it (the plugin waits
up to 40 s for it to come up) and shuts down again after 5 minutes idle. You
don't run or manage it directly.

## What the gateway does

- Keeps each key under 18 of UFR's 20 requests-per-rolling-minute, waiting
  instead of failing when a key is close to its limit.
- Enforces a pool-wide cap of 800 requests/hour across all keys and models —
  UFR walls a model group for hours once it sees sustained traffic above
  roughly 900/hour.
- Runs a circuit breaker per model: after repeated failures it backs off from
  30 s up to 60 minutes before probing again, instead of hammering a walled
  model.
- Falls back, when a model is rate-limited or walled, only to models listed
  in `free_escape_order` (in `models.json`), in that order — and never to
  UFR's external (paid-tier) models unless you set `allowPaid`. Some "local"
  UFR models (glm-5.x) are still billed per token.
- Caps every client request at 4 upstream calls to UFR in total, across
  retries and fallbacks.
- Retries once with reasoning turned off if a `glm` model spends its whole
  token budget thinking and returns no text.
- Keeps local stats in the same "% of $20/day" unit UFR's own portal uses, so
  the numbers in `ufr status` line up with what you see there.
- Survives being killed: if the gateway's lock file is left behind by an
  unclean shutdown, the next start detects it's stale and takes it over
  rather than refusing to start.

## More than one key

UFR allows one API key per account, so one key is one account's worth of
throughput. Adding more keys only helps if they belong to different UFR
accounts — it does not raise any one account's limit.

## Configuration

Non-secret settings live in a JSON file; keys always stay in the OS keyring.

- **Linux / macOS:** `~/.config/opencode-ufr/config.json` (state in
  `~/.local/state/opencode-ufr`, cache in `~/.cache/opencode-ufr`, data in
  `~/.local/share/opencode-ufr` — or the matching `$XDG_*` variable if you
  set one)
- **Windows:** `%APPDATA%\opencode-ufr\config.json` (state, cache and data
  under `%LOCALAPPDATA%\opencode-ufr`)
- Set `OPENCODE_UFR_HOME` to point everything (config, state, cache, data)
  at one directory instead — useful for testing or a fully portable setup.

Reference `config.json` (all fields optional; shown here at their defaults
except `port`, which is written on first start):

```json
{
  "schema": 1,
  "port": 47300,
  "transport": { "type": "direct" },
  "keys": ["a", "b"],
  "limits": {
    "keyRpm": 18,
    "keyWindowS": 60,
    "poolPerHour": 800,
    "poolWindowS": 3600,
    "keyMaxWaitS": 60,
    "poolMaxWaitS": 20,
    "maxUpstreamAttempts": 4
  },
  "dailyBudgetUsd": 20,
  "breaker": {
    "tripThreshold": 3,
    "ladderS": [30, 120, 300, 900, 1800, 3600],
    "probeTimeoutS": 120
  },
  "allowPaid": false,
  "catalog": {
    "url": "https://raw.githubusercontent.com/FinleyLaempe/opencode-ufr/main/models.json",
    "refreshHours": 6
  },
  "idleShutdownMin": 5
}
```

`port` is chosen once (preferred `47300`, next free port if taken) and then
stays fixed across restarts. `poolPerHour: 0` disables the pool limiter.

## Model data

The gateway fetches `models.json` from this repository every 6 hours —
context windows, prices, vision/tool flags, alias spellings and fallback
order that UFR's own API doesn't expose or gets wrong. Fixes reach every
user without a release.

To contribute a measurement (a price, a context window, a missing alias),
open a PR against `models.json` with the source of the measurement in a
`note` field.

## Privacy

- UFR API keys live only in your OS keyring (Keychain, Credential Manager,
  or libsecret/KWallet on Linux) — never in a config file or in this
  repository.
- The gateway listens on `127.0.0.1` only, behind a random local token; it
  is not reachable from the network or by other local users without that
  token.
- Local stats record token counts, cost and latency per request — never
  prompt or response content.

## Not affiliated

This is an independent project, not an official service of the University
of Freiburg's Rechenzentrum (RZ).
