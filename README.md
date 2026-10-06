# opencode-ufr

An [opencode](https://opencode.ai) provider for **Uni Freiburg's Open WebUI
models**. A small local gateway runs on your machine, pools your UFR API
key, and handles UFR's rate limits and outages so opencode doesn't have to.
Off campus, it connects through the uni's Fortinet VPN **by itself** — with no
TUN device, no admin rights and no external tools.

```
opencode ⇄ gateway (127.0.0.1) ⇄ [Fortinet tunnel] ⇄ openwebui.uni-freiburg.de
                    │
                    ├─ key pool (your UFR account)
                    ├─ rate-limit pacing, circuit breakers, fallbacks
                    └─ VPN when off campus (userspace TCP/IP stack)
```

## Install

```bash
opencode plugin add opencode-ufr     # registers the plugin
```

(or add `"plugins": ["opencode-ufr"]` to your `opencode.json` manually.)

## Update

opencode installs the plugin once into its cache and does not look for a newer
version while that copy exists — restarting opencode alone keeps the old one.
It also loads plugins inside a background server (`opencode serve --service`)
that keeps running after you close the TUI. To update, remove the cached copy
and stop that server:

```bash
rm -rf ~/.cache/opencode/npm/opencode-ufr@latest    # opencode's cached plugin copy
/restart in opencode                                # stops opencode's background server
```

The next opencode start installs the latest version and replaces the old
gateway once it is idle. On Windows, end the `opencode` server process in Task
Manager and delete the `opencode-ufr@latest` folder in opencode's cache.

## Setup

Open `/connect` in opencode, pick **Uni Freiburg**, and fill in:

| Field | Needed? |
|---|---|
| **API key** | always — your UFR API key (Open WebUI → Settings → Account → API keys) |
| **Uni login** | only off campus — e.g. `xx0000@uni-freiburg.de`, empty on the uni network |
| **Uni password** | only with a login above |

Submitted credentials land in your OS keyring (never on disk), the gateway
restarts with them, and the `unifreiburg/…` models appear in the model picker.

## Use

Models show up in opencode as `unifreiburg/<model>`, e.g.
`unifreiburg/ufr/coding-complex` or `unifreiburg/glm-5.3-flash-llmlb`. The
gateway starts itself the first time opencode needs it (the plugin waits up to
40 s) and shuts down after 5 minutes idle. You never manage it directly.

The plugin adds a line to opencode's sidebar with live gateway throughput —
requests/s and tokens/s (in and out) over the gateway's rolling 60 s window.
It hides while the gateway is off, and polling it never keeps the gateway
alive. The same numbers are served on `GET /v1/_status` under `rates` for
anything else that wants them.

Removing the **unifreiburg** integration in opencode's `/connect` panel wipes
everything: the stored key and uni login are deleted, the gateway stops, and
the models disappear from the picker on the next opencode start. While
opencode runs, connecting and removing are noticed within seconds — and even
if opencode was closed during the removal, the next start wipes what is left.

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

## PDF to Markdown (skill)

The plugin registers a **ufr-pdf2md** skill with opencode: an agentic
PDF-to-Markdown pipeline on the UFR vision models — page classification,
OCR with tables and LaTeX, and for circuit diagrams and flowcharts a
three-model ensemble (glm-5.3-flash, deepseek-v4.1-flash, qwen-3.5-397b)
with quadrant zoom and an adjudication pass that resolves disagreements
against the page image. Flowcharts and node graphs additionally come out as
node lists, edge lists and Mermaid graphs; a refinement loop and cross-page
table merging finish the document. opencode's agent loads the skill on its
own when you ask it to convert a PDF — you never run anything by hand.

Every model call goes through the gateway's relay (`POST /v1/_relay`): the
same central key rotation and soft rate limiting as chat. Pages run with up
to 16 parallel workers (auto-tuned), the key pool queues them and waits for
a free slot — nothing hammers UFR. The relay is also usable by your own
scripts (`src/client/gateway.ts`), and the context probe uses it too: the
old fixed pause between probe calls is gone, the key pool paces instead.

## What the gateway does

- Keeps the key under 19 of UFR's 20 requests-per-rolling-minute, waiting
  instead of failing when it is close to its limit.
- Can enforce a pool-wide cap on requests/hour across all models (off by
  default; `limits.poolPerHour`) — the old ~900/h model-group wall is gone,
  so nothing throttles beyond the per-key bucket unless you set a cap.
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
  the recorded spend lines up with what you see there.
- Survives being killed: if the gateway's lock file is left behind by an
  unclean shutdown, the next start detects it's stale and takes it over
  rather than refusing to start.

## Configuration

Non-secret settings live in a JSON file; the key and the uni login always stay
in the OS keyring.

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
  "upstream": { "baseUrl": "https://openwebui.uni-freiburg.de/api", "requestTimeoutS": 600 },
  "keys": [],
  "limits": {
    "keyRpm": 19,
    "keyWindowS": 60,
    "poolPerHour": 0,
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
  "idleShutdownMin": 5
}
```

`port` is chosen once (preferred `47300`, next free port if taken) and then
stays fixed across restarts. `poolPerHour: 0` (the default) disables the pool limiter.
`transport.type: "direct"` never opens the tunnel. `upstream.requestTimeoutS`
is the per-request timeout in seconds. `keys` lists keyring aliases and is
filled in by the plugin when you connect — you normally never edit it by hand.

## Releases

Releases are tag-driven: `scripts/release.sh 0.2.9` bumps, commits, tags and
pushes; the workflow then verifies on Ubuntu, macOS and Windows, stages the
package on npm (trusted publishing via OIDC — no stored tokens), and creates
the GitHub release after a maintainer approves the staged version with 2FA.

## Model data

`models.json` ships with every release — context windows, prices,
vision/tool flags, alias spellings and fallback order that UFR's own API
doesn't expose or gets wrong. Fixes reach users with the next plugin update.

Context windows are measured, not guessed: the `probe contexts` workflow
(weekly, on demand, and after every release tag) sends one oversized — and
therefore free, since UFR rejects it before pricing — request per model and
commits the exact limit the server names back to `models.json` on main.
Maintainers run the same measurement locally:

```bash
bun scripts/probe-all-contexts.ts --keyring key1 --write   # report + patch models.json
```

To contribute a measurement (a price, a context window, a missing alias),
open a PR against `models.json` with the source of the measurement in a
`note` field.

## Privacy

- Your UFR API key and the uni VPN login live only in your OS keyring (Keychain,
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
