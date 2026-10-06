#!/usr/bin/env python3
"""probe-cost.py — how does UFR bill a model: input, prefix-cached input, output?

Series (run one at a time and read the key's usage on the UFR website after
each, since the site shows only one total per key):
  A    uncached input: 3 calls, each a different prompt (unique marker first)
  B    cache: 1 warm-up + 4 calls with one identical prompt
  OUT  output: N parallel calls, short prompt asking for a very long answer

Records per call: HTTP status, latency, usage (prompt / cached / completion /
reasoning tokens), any cost field in the body, and every x-* response header.
Run it on a machine that reaches UFR chat (inside the uni network or VPN). The
key comes from stdin (--key-stdin), an env var (--key-env) or an env file
(--env-file) and is never printed.

  printf %s "$KEY" | python3 probe-cost.py --key-stdin --series A
"""

import argparse
import concurrent.futures
import datetime
import json
import os
import random
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

URL = "https://openwebui.uni-freiburg.de/api/chat/completions"
PRICE = 0.40e-6  # $/token, input and output, as advertised for glm-5.2 / glm-5.3-flash
BUDGET = 20.0  # $/day per key, the website shows usage as % of this
WORDS = (
    "river stone garden window paper light market winter silver forest engine "
    "bridge letter orange yellow planet signal harbor candle mirror rocket "
    "valley castle pocket shadow thunder meadow violet anchor basket copper "
    "desert falcon ginger hammer island jacket kettle lemon marble needle "
    "office pepper quartz ribbon saddle tunnel velvet wander yogurt zipper "
    "number simple moment little people follow change school family between "
    "picture country answer another between sentence without thought several"
).split()
LONG_PROMPT = (
    "Write a very long, detailed story about a lighthouse keeper on a remote "
    "island, told over many chapters. Aim for at least 12000 words. Do not "
    "summarise and do not stop early."
)


def read_key(args) -> str:
    if args.key_stdin:
        return sys.stdin.read().strip()
    if args.key_env:
        return os.environ.pop(args.key_env, "").strip()
    if args.env_file:
        with open(args.env_file) as f:
            for line in f:
                line = line.strip()
                if line.startswith(args.key_var + "="):
                    return line.split("=", 1)[1].strip().strip("'\"")
        raise SystemExit(f"{args.key_var} not found in {args.env_file}")
    raise SystemExit("one of --key-stdin, --key-env or --env-file is required")


def make_prompt(seed: str, n_words: int, marker: str = "") -> str:
    rng = random.Random(seed)
    words = [rng.choice(WORDS) for _ in range(n_words)]
    body = "\n".join(" ".join(words[i : i + 16]) for i in range(0, n_words, 16))
    head = f"{marker}\n" if marker else ""
    return f"{head}{body}\n\nIgnore the text above. Reply with exactly: OK"


def call(key: str, model: str, prompt: str, max_tokens: int):
    payload = {
        "model": model,
        "messages": [{"role": "user", "content": prompt}],
        "max_tokens": max_tokens,
        "stream": False,
    }
    req = urllib.request.Request(
        URL,
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    )
    t = time.time()
    try:
        with urllib.request.urlopen(req, timeout=1200) as r:
            status, headers, data = (
                r.status,
                dict(r.headers.items()),
                json.loads(r.read()),
            )
    except urllib.error.HTTPError as e:
        status, headers = e.code, dict(e.headers.items())
        data = {"error": e.read().decode(errors="replace")[:400]}
    except Exception as e:  # timeout, connection reset
        status, headers, data = 0, {}, {"error": repr(e)[:400]}
    return status, time.time() - t, headers, data


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-stdin", action="store_true")
    ap.add_argument("--key-env", help="read the key from this environment variable")
    ap.add_argument("--env-file", default=None)
    ap.add_argument("--key-var", default="UFR_KEY")
    ap.add_argument("--model", default="glm-5.2-llmlb")
    ap.add_argument("--series", required=True, choices=["A", "B", "OUT"])
    ap.add_argument("--words", type=int, default=80000, help="~1.2 tokens per word")
    ap.add_argument("--parallel", type=int, default=5, help="OUT only")
    ap.add_argument("--out-tokens", type=int, default=16384, help="OUT only")
    ap.add_argument("--pause", type=float, default=3.0)
    args = ap.parse_args()

    key = read_key(args)
    if not key:
        raise SystemExit("empty key")
    redact = lambda s: str(s).replace(key, "<key>")
    run_id = uuid.uuid4().hex[:8]
    started = datetime.datetime.now(datetime.timezone.utc)
    print(
        f"run {run_id}  series {args.series}  model {args.model}  start {started:%Y-%m-%d %H:%M:%S} UTC",
        flush=True,
    )

    if args.series == "A":
        jobs = [
            (
                "A",
                i,
                make_prompt(f"A-{i}-{run_id}", args.words, f"RUN {run_id} A{i}"),
                20,
            )
            for i in (1, 2, 3)
        ]
    elif args.series == "B":
        cached = make_prompt(f"B-{run_id}", args.words, f"RUN {run_id} B")
        jobs = [("B", i, cached, 20) for i in range(5)]
    else:
        jobs = [
            ("OUT", i, f"[{run_id}-{i}] {LONG_PROMPT}", args.out_tokens)
            for i in range(1, args.parallel + 1)
        ]

    results = []

    def record(job, status, secs, headers, data):
        series, i, _, _ = job
        u = data.get("usage") or {}
        cached_t = (u.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        reason = (u.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        costs = {k: v for k, v in u.items() if "cost" in k.lower()}
        costs.update({k: v for k, v in data.items() if "cost" in k.lower()})
        xh = {k: v for k, v in headers.items() if k.lower().startswith("x-")}
        results.append(
            {
                "series": series,
                "i": i,
                "status": status,
                "secs": round(secs, 2),
                "usage": u,
                "cost_fields": costs,
                "x_headers": xh,
                "error": data.get("error"),
                "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            }
        )
        p = u.get("prompt_tokens") or 0
        print(
            f" {series:3} {i}  {status:>4} {secs:7.1f} {p:8} {cached_t:8} {p - cached_t:9} "
            f"{u.get('completion_tokens') or 0:6} {reason:7}  {redact(costs) if costs else '-'}",
            flush=True,
        )
        if status != 200:
            print(f"      error: {redact(data.get('error'))}", flush=True)

    print(
        "ser  #  http    secs   prompt   cached  uncached  compl  reason  cost-fields",
        flush=True,
    )
    if args.series == "OUT":
        with concurrent.futures.ThreadPoolExecutor(max_workers=len(jobs)) as ex:
            futs = {ex.submit(call, key, args.model, j[2], j[3]): j for j in jobs}
            for f in concurrent.futures.as_completed(futs):
                record(futs[f], *f.result())
    else:
        for j in jobs:
            record(j, *call(key, args.model, j[2], j[3]))
            time.sleep(args.pause)

    ended = datetime.datetime.now(datetime.timezone.utc)
    ok = [r for r in results if r["status"] == 200]
    p = sum((r["usage"].get("prompt_tokens") or 0) for r in ok)
    c = sum(
        ((r["usage"].get("prompt_tokens_details") or {}).get("cached_tokens") or 0)
        for r in ok
    )
    o = sum((r["usage"].get("completion_tokens") or 0) for r in ok)
    pct = lambda usd: f"${usd:.4f} = {usd / BUDGET * 100:.3f}%"
    print(
        f"\nend {ended:%Y-%m-%d %H:%M:%S} UTC  ({(ended - started).total_seconds():.0f}s)"
    )
    print(
        f"totals: calls ok {len(ok)}/{len(results)}  prompt {p}  cached {c}  uncached {p - c}  completion {o}"
    )
    print(f"  @ $0.40/Mtok, cache billed full: {pct((p + o) * PRICE)}")
    print(f"  @ $0.40/Mtok, cache free:        {pct((p - c + o) * PRICE)}")
    first = results[0] if results else {"x_headers": {}}
    print(
        f"x-* headers (first call): {redact(sorted(first['x_headers'].items())) or 'none'}"
    )

    out = f"{tempfile.gettempdir()}/probe-cost-{started:%Y%m%d-%H%M%S}-{args.series}-{run_id}.json"
    with open(out, "w") as f:
        f.write(
            redact(
                json.dumps(
                    {
                        "run": run_id,
                        "series": args.series,
                        "model": args.model,
                        "start": started.isoformat(),
                        "end": ended.isoformat(),
                        "results": results,
                    },
                    indent=2,
                )
            )
        )
    print(f"raw results: {out}")


if __name__ == "__main__":
    main()
