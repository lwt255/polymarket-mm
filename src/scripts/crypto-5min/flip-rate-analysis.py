#!/usr/bin/env python3
"""
Flip-rate analysis: how often does the favorite side flip between T-33 (decision)
and T-30 (fill) in the candidate-stack filter universe?

If this rate is ~5% historically, our 4/22 live sample is a bad morning.
If it's ~15-20%, the strategy has a structural hole the T-33 snap can't see.

Usage:
  python3 src/scripts/crypto-5min/flip-rate-analysis.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
DECISION_SEC = 33
FILL_SEC = 30
INTERVALS = ("5m", "15m")
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")


def interval_from_slug(slug: str) -> str | None:
    for part in slug.split("-"):
        if part in INTERVALS:
            return part
    return None


def crypto_from_slug(slug: str) -> str | None:
    prefix = slug.split("-", 1)[0].upper()
    return prefix if prefix in CRYPTOS else None


def side_from_snap(snap: dict) -> str:
    up = snap.get("upBid", 0) or 0
    dn = snap.get("downBid", 0) or 0
    if up > dn:
        return "UP"
    if dn > up:
        return "DOWN"
    return "TIE"


def leader_ask(snap: dict) -> float | None:
    side = side_from_snap(snap)
    if side == "UP":
        return snap.get("upAsk") or snap.get("upBid")
    if side == "DOWN":
        return snap.get("downAsk") or snap.get("downBid")
    return None


def closest_snap(snaps: list[dict], target_sec: int) -> dict | None:
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not candidates:
        return None
    return min(candidates, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))


def main() -> None:
    rows_scanned = 0
    markets_considered = 0
    markets_with_both_snaps = 0
    stats = {
        "all": {"n": 0, "flip": 0, "t33_won": 0, "t30_won": 0, "flip_t33_won": 0, "flip_t30_won": 0},
    }

    by_band = defaultdict(lambda: {"n": 0, "flip": 0, "t33_won": 0, "flip_t33_won": 0})
    by_interval = defaultdict(lambda: {"n": 0, "flip": 0, "t33_won": 0, "flip_t33_won": 0})
    by_crypto = defaultdict(lambda: {"n": 0, "flip": 0, "t33_won": 0, "flip_t33_won": 0})
    by_gap = defaultdict(lambda: {"n": 0, "flip": 0})  # |up - dn| at T-33

    with open(PATH, "r") as handle:
        for line in handle:
            rows_scanned += 1
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue

            slug = row.get("slug", "")
            interval = interval_from_slug(slug)
            crypto = crypto_from_slug(slug)
            if not interval or not crypto:
                continue

            resolution = row.get("resolution")
            if resolution not in ("UP", "DOWN"):
                continue

            snaps = row.get("snapshots") or []
            if not snaps:
                continue

            snap33 = closest_snap(snaps, DECISION_SEC)
            snap30 = closest_snap(snaps, FILL_SEC)
            if not snap33 or not snap30:
                continue
            if abs(snap33.get("secondsBeforeEnd", 0) - DECISION_SEC) > 5:
                continue
            if abs(snap30.get("secondsBeforeEnd", 0) - FILL_SEC) > 5:
                continue

            markets_considered += 1

            side33 = side_from_snap(snap33)
            side30 = side_from_snap(snap30)
            ask33 = leader_ask(snap33)
            if side33 == "TIE" or ask33 is None:
                continue

            if not (0.54 <= ask33 <= 0.75):
                continue

            markets_with_both_snaps += 1

            flipped = side30 != side33
            t33_won = side33 == resolution
            t30_won = side30 == resolution if side30 != "TIE" else False

            s = stats["all"]
            s["n"] += 1
            s["t33_won"] += int(t33_won)
            s["t30_won"] += int(t30_won)
            if flipped:
                s["flip"] += 1
                s["flip_t33_won"] += int(t33_won)
                s["flip_t30_won"] += int(t30_won)

            if ask33 < 0.58:
                band = "54-58"
            elif ask33 < 0.62:
                band = "58-62"
            elif ask33 < 0.66:
                band = "62-66"
            elif ask33 < 0.70:
                band = "66-70"
            else:
                band = "70-75"
            by_band[band]["n"] += 1
            by_band[band]["t33_won"] += int(t33_won)
            if flipped:
                by_band[band]["flip"] += 1
                by_band[band]["flip_t33_won"] += int(t33_won)

            by_interval[interval]["n"] += 1
            by_interval[interval]["t33_won"] += int(t33_won)
            if flipped:
                by_interval[interval]["flip"] += 1
                by_interval[interval]["flip_t33_won"] += int(t33_won)

            by_crypto[crypto]["n"] += 1
            by_crypto[crypto]["t33_won"] += int(t33_won)
            if flipped:
                by_crypto[crypto]["flip"] += 1
                by_crypto[crypto]["flip_t33_won"] += int(t33_won)

            up33 = snap33.get("upBid", 0) or 0
            dn33 = snap33.get("downBid", 0) or 0
            gap = abs(up33 - dn33)
            if gap < 0.05:
                g = "0-5c"
            elif gap < 0.10:
                g = "5-10c"
            elif gap < 0.20:
                g = "10-20c"
            elif gap < 0.30:
                g = "20-30c"
            else:
                g = "30c+"
            by_gap[g]["n"] += 1
            if flipped:
                by_gap[g]["flip"] += 1

    def pct(a, b):
        return 100 * a / b if b else 0

    print(f"Rows scanned:         {rows_scanned}")
    print(f"Markets considered:   {markets_considered}")
    print(f"In 54-75c band:       {markets_with_both_snaps}")
    print()

    s = stats["all"]
    print("=== Overall flip rate (T-33 decision → T-30 fill) ===")
    print(f"  N: {s['n']}")
    print(f"  Flip rate:          {pct(s['flip'], s['n']):.2f}%")
    print(f"  T-33 leader WR:     {pct(s['t33_won'], s['n']):.2f}%")
    print(f"  T-30 leader WR:     {pct(s['t30_won'], s['n']):.2f}%")
    print()
    print(f"  When flipped ({s['flip']} cases):")
    print(f"    T-33 leader WR:   {pct(s['flip_t33_won'], s['flip']):.2f}%  (what the bot bought)")
    print(f"    T-30 leader WR:   {pct(s['flip_t30_won'], s['flip']):.2f}%  (what it flipped to)")
    print()

    def print_table(name, buckets):
        print(f"=== By {name} ===")
        print(f"  {'bucket':<10} {'n':>6} {'flip%':>7} {'t33_WR':>7} {'flip_t33_WR':>12}")
        for k in sorted(buckets.keys()):
            b = buckets[k]
            n = b["n"]
            print(f"  {k:<10} {n:>6} {pct(b['flip'], n):>6.2f}% {pct(b['t33_won'], n):>6.2f}% {pct(b.get('flip_t33_won', 0), b['flip']):>11.2f}%")
        print()

    print_table("price band", by_band)
    print_table("interval", by_interval)
    print_table("crypto", by_crypto)
    print(f"=== Flip rate by T-33 up-down gap (|upBid - downBid|) ===")
    print(f"  {'bucket':<10} {'n':>6} {'flip%':>7}")
    for k in ("0-5c", "5-10c", "10-20c", "20-30c", "30c+"):
        if k in by_gap:
            b = by_gap[k]
            print(f"  {k:<10} {b['n']:>6} {pct(b['flip'], b['n']):>6.2f}%")


if __name__ == "__main__":
    main()
