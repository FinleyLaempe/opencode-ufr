#!/usr/bin/env python3
"""probe-ratelimit.py — UFR's per-key request bucket: size, window type, recovery.

  1. burst   N parallel minimal requests, released at a fixed UTC second
  2. recover one probe every --probe-interval s until a 200 comes back
  3. burst   N parallel again, right after recovery (fresh window or partial?)

Window type follows from when step 2 recovers:
  at the next full minute        -> fixed per-minute window
  60 s after the first admission -> sliding 60 s window
  later than both                -> blocked requests extend the lock

Run it on a machine that reaches UFR chat (inside the uni network or VPN). The
key comes from stdin (--key-stdin) or an environment variable (--key-env) and
is never printed.
"""
import argparse
import collections
import concurrent.futures
import datetime
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

URL = "https://openwebui.uni-freiburg.de/api/chat/completions"


def utc(t: float) -> str:
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime("%H:%M:%S.%f")[:-3]


def post(key: str, model: str):
    body = json.dumps({"model": model, "messages": [{"role": "user", "content": "Hi"}], "max_tokens": 1}).encode()
    req = urllib.request.Request(URL, data=body, headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    sent = time.time()
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            r.read()
            return sent, time.time(), r.status, "", dict(r.headers.items())
    except urllib.error.HTTPError as e:
        return sent, time.time(), e.code, e.read().decode(errors="replace"), dict(e.headers.items())
    except Exception as e:  # timeout, reset
        return sent, time.time(), 0, repr(e), {}


def burst(key: str, model: str, n: int):
    with concurrent.futures.ThreadPoolExecutor(max_workers=n) as ex:
        return [f.result() for f in [ex.submit(post, key, model) for _ in range(n)]]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--key-stdin", action="store_true")
    ap.add_argument("--key-env")
    ap.add_argument("--model", default="gemma-4-31b-llmlb")
    ap.add_argument("--burst", type=int, default=65)
    ap.add_argument("--start-second", type=int, default=40, help="UTC second to release the first burst at")
    ap.add_argument("--probe-interval", type=float, default=3.0)
    ap.add_argument("--probe-max", type=float, default=180.0)
    args = ap.parse_args()

    key = sys.stdin.read().strip() if args.key_stdin else os.environ.pop(args.key_env or "", "").strip()
    if not key:
        raise SystemExit("empty key")
    redact = lambda s: str(s).replace(key, "<key>")
    run_id = uuid.uuid4().hex[:8]
    log = {"run": run_id, "model": args.model, "phases": {}}

    def summarize(name, results):
        counts = collections.Counter(r[2] for r in results)
        ok = sorted((r for r in results if r[2] == 200), key=lambda r: r[0])
        print(f"\n== {name}: {dict(counts)}", flush=True)
        if ok:
            print(f"   200s sent {utc(ok[0][0])} .. {utc(ok[-1][0])}, answered by {utc(max(r[1] for r in ok))}")
        bodies = collections.Counter(redact(r[3])[:600] for r in results if r[2] != 200)
        for body, c in bodies.items():
            print(f"   {c}x non-200 body: {body}")
        hdrs = next((r[4] for r in results if r[2] == 429), None)
        if hdrs:
            print(f"   429 headers: {redact(sorted(hdrs.items()))}")
        log["phases"][name] = [{"sent": r[0], "done": r[1], "status": r[2], "body": redact(r[3])[:600]} for r in results]
        return ok

    # 1. first burst, released at a fixed UTC second
    now = time.time()
    wait = (args.start_second - now % 60) % 60
    print(f"run {run_id}  model {args.model}  burst {args.burst}  waiting {wait:.1f}s for second :{args.start_second:02d}", flush=True)
    time.sleep(wait)
    t_burst = time.time()
    ok1 = summarize("burst 1", burst(key, args.model, args.burst))
    first_admit = ok1[0][0] if ok1 else t_burst

    # 2. recovery probes
    print(f"\n== recovery probes every {args.probe_interval:.0f}s", flush=True)
    probes, recovered = [], None
    while time.time() - t_burst < args.probe_max:
        r = post(key, args.model)
        probes.append(r)
        print(f"   {utc(r[0])}  +{r[0] - t_burst:5.1f}s  HTTP {r[2]}", flush=True)
        if r[2] == 200:
            recovered = r[0]
            break
        time.sleep(args.probe_interval)
    log["phases"]["probes"] = [{"sent": r[0], "status": r[2], "body": redact(r[3])[:300]} for r in probes]

    next_minute = (int(t_burst) // 60 + 1) * 60
    print("\n== window analysis")
    print(f"   burst released      {utc(t_burst)}")
    print(f"   predicted fixed     {utc(next_minute)}   (next full minute)")
    print(f"   predicted sliding   {utc(first_admit + 60)}   (first admission + 60 s)")
    if recovered:
        print(f"   observed recovery   {utc(recovered)}   (+{recovered - t_burst:.1f}s after burst; "
              f"probe resolution {args.probe_interval:.0f}s)")
    else:
        print(f"   no recovery within {args.probe_max:.0f}s")

    # 3. second burst right after recovery
    if recovered:
        summarize("burst 2 (right after recovery)", burst(key, args.model, args.burst))

    out = f"/root/probe-ratelimit-{datetime.datetime.now(datetime.timezone.utc):%Y%m%d-%H%M%S}-{run_id}.json"
    with open(out, "w") as f:
        f.write(redact(json.dumps(log, indent=2)))
    print(f"\nraw results: {out}")


if __name__ == "__main__":
    main()
