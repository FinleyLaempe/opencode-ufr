# opencode-ufr

An [opencode](https://opencode.ai) provider for **Uni Freiburg's Open WebUI
models**. A small local gateway runs on your machine, pools your UFR API
key(s), and handles UFR's rate limits and outages so opencode doesn't have to.
Off campus, it connects through the uni's Fortinet VPN **by itself** — with no
TUN device, no admin rights and no external tools.

```
opencode ⇄ gateway (127.0.0.1) ⇄ [Fortinet tunnel] ⇄ openwebui.uni-freiburg.de
                    │
                    ├─ key pool (1…n UFR accounts)
                    ├─ rate-limit pacing, circuit breakers, fallbacks
                    └─ VPN when off campus (userspace TCP/IP stack)
```

## Install

```bash
bun add -g opencode-ufr              # puts `ufr` on PATH
opencode plugin add opencode-ufr     # registers the plugin
```

(or add `"plugins": ["opencode-ufr"]` to your `opencode.json` manually.)

## Updating

opencode installs the plugin once into its cache and does not look for a newer
version while that copy exists — restarting opencode alone keeps the old one.
It also loads plugins inside a background server (`opencode serve --service`)
that keeps running after you close the TUI. To update, remove the cached copy
and stop that server:

```bash
bun add -g opencode-ufr@latest                      # update the `ufr` CLI
rm -rf ~/.cache/opencode/npm/opencode-ufr@latest    # opencode's cached plugin copy
pkill -f "opencode serve --service"                 # opencode's background server
```

The next opencode start installs the latest version and replaces the old
gateway once it is idle. On Windows, end the `opencode` server process in Task
Manager and delete the `opencode-ufr@latest` folder in opencode's cache.

## Setup

**Inside opencode — the normal way:** open `/connect`, pick **Uni Freiburg**,
and fill in:

| Field | Needed? |
|---|---|
| **API keys** | always — paste one key per UFR account, comma-separated (whitespace is filtered) |
| **Uni login** | only off campus — e.g. `fl240@uni-freiburg.de`, empty on the uni network |
| **Uni password** | only with a login above |

Submitted credentials land in your OS keyring (never on disk), the gateway
restarts with them, and the `unifreiburg/…` models appear in the model picker.

**In a terminal — the fallback:** works before opencode ever starts.

```bash
ufr connect --keys "<key1>,<key2>"                                 # keys only
ufr connect --login fl240@uni-freiburg.de --password … --keys "…"   # + VPN login
```

`ufr connect` verifies every key against UFR, assigns aliases (`key1`, `key2`,
…) automatically and accepts keys comma- or line-separated.

## Use

Models show up in opencode as `unifreiburg/<model>`, e.g.
`unifreiburg/ufr/coding-complex` or `unifreiburg/glm-5.3-flash-llmlb`. The
gateway starts itself the first time opencode needs it (the plugin waits up to
40 s) and shuts down after 5 minutes idle. You never manage it directly.

```bash
ufr status       # gateway, keys, limits, breakers, vpn, spend today
ufr stats        # requests, tokens and cost
ufr keys list    # stored aliases
ufr keys test    # check your keys against UFR
ufr login show   # the stored uni login
ufr disconnect   # remove everything: keys, uni login, config, gateway
```

Removing the **unifreiburg** integration in opencode's `/connect` panel does the
same as `ufr disconnect`: the stored keys and uni login are wiped, the gateway
stops, and the models disappear from the picker on the next opencode start.
While opencode runs, connecting and removing are noticed within seconds. If
opencode was closed when you removed the integration, run `ufr disconnect` once
to wipe what is left.

## The built-in VPN

On the campus network (or the VPN you already run) UFR is reached directly and
no tunnel opens. Off campus, the gateway:

1. logs in to `fortivpn.uni-freiburg.de` with your stored uni login (TLS),
2. negotiates PPP/IPCP over the Fortinet SSL-VPN channel (this is the same
   protocol `openconnect --protocol=fortinet` speaks, implemented in pure
   TypeScript — see `docs/fortinet-protocol.md`),
3. runs a **userspace TCP/IP stack inside the gateway process** and routes its
   UFR calls through it via a localhost CONNECT proxy.

What that means in practice:

- **No TUN device, no routing table changes, no admin rights** — identical
  code on Linux, macOS and Windows.
- **Your own VPNs keep working untouched in parallel** — the plugin's tunnel
  exists only inside its own process and rides on whatever network the OS
  provides.
- **Everything is encrypted twice**: the tunnel itself is TLS 1.3, and your
  API calls are HTTPS end-to-end to `openwebui.uni-freiburg.de` inside it.
- `vpn.mode: "auto"` (default) only tunnels when UFR is unreachable directly;
  `"always"` forces the tunnel (useful behind firewalls that block the campus
  route).
- If the tunnel dies, it reconnects with backoff — no session is lost, the
  gateway just waits until the path is back.

## More than one key

UFR allows one API key per account, so one key is one account's worth of
throughput. The key pool round-robins across all stored keys and keeps each
under UFR's per-key limits; adding more keys only helps if they belong to
different UFR accounts.

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

## Configuration

Non-secret settings live in a JSON file; keys and the uni login always stay in
the OS keyring.

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
  "transport": { "type": "auto" },
  "vpn": { "gateway": "https://fortivpn.uni-freiburg.de", "mode": "auto" },
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
`transport.type: "direct"` never opens the tunnel.

## Releases

Releases are tag-driven: `scripts/release.sh 0.2.1` bumps, commits, tags and
pushes; the workflow then verifies on Ubuntu, macOS and Windows, stages the
package on npm (trusted publishing via OIDC — no stored tokens), and creates
the GitHub release after a maintainer approves the staged version with 2FA.

## Model data

The gateway fetches `models.json` from this repository every 6 hours —
context windows, prices, vision/tool flags, alias spellings and fallback
order that UFR's own API doesn't expose or gets wrong. Fixes reach every
user without a release.

To contribute a measurement (a price, a context window, a missing alias),
open a PR against `models.json` with the source of the measurement in a
`note` field.

## Privacy

- UFR API keys and the uni VPN login live only in your OS keyring (Keychain,
  Credential Manager, or libsecret/KWallet on Linux) — never in a config file
  or in this repository.
- The gateway listens on `127.0.0.1` only, behind a random local token; it
  is not reachable from the network or by other local users without that
  token.
- Local stats record token counts, cost and latency per request — never
  prompt or response content.

## Not affiliated

This is an independent project, not an official service of the University
of Freiburg's Rechenzentrum (RZ).
