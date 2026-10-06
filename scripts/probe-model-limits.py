#!/usr/bin/env python3
"""probe-model-limits.py — misst die per-key Limits eines UFR-Modells live.

Feuert minimale Chat-Requests (max_tokens 1) mit genau einem Key und leitet
daraus ab:

  1. Requests pro Minute — Maximum an Admissions in einem rollierenden
     60-s-Fenster, plus Fenstertyp (feste Minuten-Grenze vs. sliding 60 s,
     bestimmt über den Zeitpunkt der Erholung nach der ersten 429)
  2. Requests pro Stunde — Dauer-Rate über die Restlaufzeit; ein echtes
     Stunden-Limit ist in 5 min nicht erreichbar, das Ergebnis ist eine
     untere Grenze (Extrapolation) plus Hinweis auf UFRs Modellgruppen-Wall
  3. Max Context / Max Output — aus dem gebündelten models.json (Fallback:
     Defaults 131072 / 16384)

Läuft standardmäßig 5 Minuten (--duration). Setzt voraus, dass die Maschine
UFR bereits erreicht (Uni-Netz oder VPN verbunden). Der Key kommt über
--key, --key-env oder --key-stdin und wird nie ausgegeben.

Beispiel:
  scripts/probe-model-limits.py glm-5.3-flash-llmlb --key sk-...
"""

import argparse
import collections
import concurrent.futures
import datetime
import json
import os
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

BASE = "https://openwebui.uni-freiburg.de/api"
URL_MODELS = f"{BASE}/models"
URL_CHAT = f"{BASE}/chat/completions"
MODELS_JSON = Path(__file__).resolve().parent.parent / "models.json"


def utc(t: float) -> str:
    return datetime.datetime.fromtimestamp(t, datetime.timezone.utc).strftime(
        "%H:%M:%S"
    )


def redact(s: str, key: str) -> str:
    return str(s).replace(key, "<key>")


def http(key: str, method: str, url: str, body: bytes | None, timeout: float):
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method=method,
    )
    sent = time.time()
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            payload = r.read().decode(errors="replace")
            return sent, time.time(), r.status, payload, dict(r.headers.items())
    except urllib.error.HTTPError as e:
        return (
            sent,
            time.time(),
            e.code,
            e.read().decode(errors="replace"),
            dict(e.headers.items()),
        )
    except Exception as e:  # timeout, reset, DNS …
        return sent, time.time(), 0, repr(e), {}


def chat(key: str, model: str, timeout: float = 90.0):
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": "Hi"}],
            "max_tokens": 1,
        }
    ).encode()
    return http(key, "POST", URL_CHAT, body, timeout)


def ufr_models(key: str):
    _, _, status, payload, _ = http(key, "GET", URL_MODELS, None, 20.0)
    if status != 200:
        raise SystemExit(
            f"/api/models liefert HTTP {status} — Key ungültig oder UFR nicht erreichbar"
        )
    try:
        raw = json.loads(payload)
    except json.JSONDecodeError:
        raise SystemExit(
            "/api/models liefert kein JSON (VPN-Seite?) — erst Netzweg prüfen"
        )
    items = raw if isinstance(raw, list) else (raw or {}).get("data", [])
    return {
        m["id"]: m
        for m in items
        if isinstance(m, dict) and isinstance(m.get("id"), str)
    }


def load_context(model: str):
    """Max context/output aus models.json (Defaults als Fallback)."""
    ctx, out, src = 131_072, 16_384, "models.json-Defaults"
    try:
        file = json.loads(MODELS_JSON.read_text())
        aliases = file.get("aliases", {})
        model = aliases.get(model, model)  # Alias auflösen, z. B. gpt-5.6-llmlb
        entry = file.get("models", {}).get(model)
        if entry:
            ctx = entry.get("context", ctx)
            out = entry.get("max_output", out)
            src = "models.json"
    except (OSError, json.JSONDecodeError):
        src = "models.json nicht lesbar — Defaults"
    return model, ctx, out, src


def rolling_max(
    admits: list[float], window_s: float = 60.0
) -> tuple[int, float, float]:
    """Größtes Fenster mit count Admissions; gibt (count, fensterstart, fensterende) zurück."""
    best = (0, 0.0, 0.0)
    j = 0
    for i, t in enumerate(admits):
        while admits[j] <= t - window_s:
            j += 1
        if i - j + 1 > best[0]:
            best = (i - j + 1, admits[j], t)
    return best


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("model", help="Modell-ID, z. B. glm-5.3-flash-llmlb")
    ap.add_argument("--key", help="UFR API key (sonst --key-env / --key-stdin)")
    ap.add_argument("--key-env", default="UFR_PROBE_KEY")
    ap.add_argument("--key-stdin", action="store_true")
    ap.add_argument(
        "--duration",
        type=float,
        default=300.0,
        help="Gesamtlaufzeit in s (default 300)",
    )
    ap.add_argument(
        "--probe-interval", type=float, default=3.0, help="Erholungs-Probe alle N s"
    )
    ap.add_argument("--out", help="JSON-Logpfad (default: Temp-Verzeichnis)")
    args = ap.parse_args()

    key = (
        sys.stdin.read().strip()
        if args.key_stdin
        else (args.key or "").strip() or os.environ.get(args.key_env, "").strip()
    )
    if not key:
        raise SystemExit("kein Key — --key, --key-env oder --key-stdin nutzen")

    run_id = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%d-%H%M%S")
    t0 = time.time()
    deadline = t0 + args.duration
    log = {
        "run": run_id,
        "model": args.model,
        "duration_s": args.duration,
        "requests": [],
    }

    # -- Vorlauf: Modell prüfen, Context aus models.json ----------------------
    print(f"== Vorlauf — Modell {args.model} bei UFR prüfen", flush=True)
    models = ufr_models(key)
    try:
        aliases = json.loads(MODELS_JSON.read_text()).get("aliases", {})
    except (OSError, json.JSONDecodeError):
        aliases = {}
    resolved = aliases.get(args.model, args.model)
    if args.model in aliases and resolved not in models:
        raise SystemExit(
            f"Alias '{args.model}' zeigt auf '{resolved}', das nicht in UFRs "
            f"Modellliste steht — models.json und UFR stimmen nicht überein"
        )
    if resolved not in models:
        close = [m for m in models if args.model.split("-")[0] in m]
        raise SystemExit(
            f"Modell '{args.model}' nicht in UFRs Modellliste. Ähnliche: {close[:6]}"
        )
    model, context, max_out, ctx_src = load_context(args.model)
    ufr_name = models.get(model, {}).get("name", "?")
    tier = (
        "paid (external)"
        if models.get(model, {}).get("connection_type") == "external"
        else "free"
    )
    print(f'   Modell gefunden: {model} — "{ufr_name}" ({tier})', flush=True)
    print(
        f"   Max Context: {context:,} tokens, Max Output: {max_out:,} ({ctx_src})",
        flush=True,
    )

    admits: list[float] = []  # Zeitstempel der 200er-Antworten
    first429 = None
    n429 = 0
    req_no = 0
    first_headers = {}

    def note(sent, done, status, body, extra=""):
        log["requests"].append(
            {
                "sent": sent,
                "done": done,
                "status": status,
                "body": redact(body, key)[:400],
            }
        )
        dt = f"{(done - sent) * 1000:.0f}ms"
        win = f"  Fenster: {rolling_max(admits)[0]} in 60s" if status == 200 else ""
        print(
            f"   {utc(sent)}  #{req_no:<3} HTTP {status:<4} {dt:>7}{win} {extra}",
            flush=True,
        )

    # -- Phase 1: Minuten-Limit — volle Geschwindigkeit bis zur ersten 429 ----
    print(
        f"\n== Phase 1: Minuten-Limit messen (volle Geschwindigkeit bis zur ersten 429)",
        flush=True,
    )
    phase1_end = min(deadline, t0 + args.duration * 0.45)
    while time.time() < phase1_end:
        req_no += 1
        sent, done, status, body, headers = chat(key, model)
        if status == 200:
            admits.append(sent)
            note(sent, done, status, body)
        elif status == 429:
            n429 += 1
            first429 = first429 or sent
            first_headers = headers
            note(sent, done, status, body, "← Limit erreicht")
            break
        else:
            note(sent, done, status, body)
            if status in (401, 403):
                raise SystemExit("Key wird von UFR abgelehnt (401/403)")
            if status == 0:
                raise SystemExit("UFR nicht erreichbar — VPN/Netz prüfen")
            time.sleep(2)

    per_min, w_start, w_end = rolling_max(admits)
    if not first429:
        print(
            "   ! keine 429 in Phase 1 — Limit höher als der Messdurchsatz", flush=True
        )

    # -- Phase 2: Erholung — wann lässt UFR wieder zu? ------------------------
    recovery = None
    if first429:
        print(
            f"\n== Phase 2: Erholung abwarten (Probe alle {args.probe_interval:.0f}s)",
            flush=True,
        )
        probe_end = min(deadline, first429 + 150)
        while time.time() < probe_end:
            time.sleep(args.probe_interval)
            req_no += 1
            sent, done, status, body, headers = chat(key, model)
            note(sent, done, status, body)
            if status == 200:
                admits.append(sent)
                recovery = sent
                break
            if status == 429:
                n429 += 1

    # -- Phase 3: Stunden-Rate — Dauerbetrieb bis zum Zeitbudget --------------
    print(
        f"\n== Phase 3: Dauerbetrieb bis {utc(deadline)} UTC ({args.duration:.0f}s Budget)",
        flush=True,
    )
    phase3_start = time.time()
    phase3_admits: list[float] = []
    pace = (
        60.0 / max(1, per_min * 0.8) if first429 else 1.0
    )  # knapp unter dem gemessenen Minuten-Limit bleiben
    while time.time() < deadline:
        req_no += 1
        sent, done, status, body, headers = chat(key, model)
        if status == 200:
            admits.append(sent)
            phase3_admits.append(sent)
            note(sent, done, status, body)
        elif status == 429:
            n429 += 1
            note(sent, done, status, body, "← 429 im Dauerbetrieb")
            pace = min(pace * 1.5, 10.0)  # zurückfallen und weitermessen
        else:
            note(sent, done, status, body)
            if status == 0:
                print(
                    "   ! Transportfehler — fahre mit nächstem Versuch fort", flush=True
                )
            time.sleep(2)
        time.sleep(max(0.0, pace - (time.time() - done)))

    # -- Bericht ---------------------------------------------------------------
    phase3_s = time.time() - phase3_start
    phase3_rate = len(phase3_admits) / phase3_s * 3600 if phase3_s > 5 else 0.0

    print("\n" + "=" * 64)
    print(f"BERICHT  {model}  (Run {run_id})")
    print("=" * 64)
    print(f"  Max Context        {context:,} tokens   ({ctx_src})")
    print(f"  Max Output         {max_out:,} tokens")
    print(f"  Requests gesamt    {req_no}  (200: {len(admits)}, 429: {n429})")
    if first429:
        print(f"  Limit pro Minute   {per_min} Requests")
        print(
            f"                     (dichtestes 60s-Fenster {utc(w_start)}–{utc(w_end)} UTC)"
        )
        if recovery:
            # Sliding window: frees 60 s after the last admission before the
            # 429. Fixed window: frees at the minute boundary after the 429.
            last_before = max((t for t in admits if t < first429), default=first429)
            delta_slide = recovery - (last_before + 60)
            next_minute = (int(first429) // 60 + 1) * 60
            delta_fixed = recovery - next_minute
            wtype = (
                "sliding 60s"
                if abs(delta_slide) < abs(delta_fixed)
                else "feste Minuten-Grenze"
            )
            print(f"  Fenstertyp         {wtype}")
            print(
                f"                     Erholung {utc(recovery)} UTC — sliding {delta_slide:+.0f}s nach letzter Zulassung + 60 s, fixed {delta_fixed:+.0f}s nach der Minute"
            )
        else:
            print(
                f"  Fenstertyp         unbestimmt (keine Erholung innerhalb des Budgets)"
            )
    else:
        print(
            f"  Limit pro Minute   > {per_min} Requests (nicht erreicht — Durchsatz zu langsam)"
        )
    if phase3_rate:
        print(
            f"  Dauer-Rate         {len(phase3_admits)} Requests in {phase3_s:.0f}s ≈ {phase3_rate:.0f}/h"
        )
        print(
            f"                     (untere Grenze — echtes Stunden-Limit braucht eine Stunde Messzeit)"
        )
    else:
        print(f"  Dauer-Rate         keine Messung (zu kurze Phase 3)")
    if first_headers:
        interesting = {
            k: v
            for k, v in first_headers.items()
            if k.lower()
            in (
                "retry-after",
                "x-ratelimit-limit",
                "x-ratelimit-remaining",
                "x-ratelimit-reset",
                "ratelimit-limit",
                "ratelimit-remaining",
                "ratelimit-reset",
            )
        }
        if interesting:
            print(f"  429-Header         {interesting}")
    print(
        f"  Hinweis            UFR maurt Modellgruppen oberhalb ~900/h Dauerlast für Stunden ein;"
    )
    print(
        f"                     der Gateway deckelt den Pool standardmäßig nicht (limits.poolPerHour: 0 = Limiter aus);"
    )
    print(
        f"                     setze ihn z. B. auf 800/h, um das unabhängig von der Key-Anzahl abzufedern."
    )
    print("=" * 64)

    out = args.out or str(
        Path(tempfile.gettempdir()) / f"probe-model-limits-{run_id}.json"
    )
    Path(out).write_text(redact(json.dumps(log, indent=2), key))
    print(f"  Rohdaten           {out}")


if __name__ == "__main__":
    main()
