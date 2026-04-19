#!/usr/bin/env python3
"""
Investigate why fam_cross_0 appears in the live strategy despite being
a money-loser on 30-day data.

Split the 30 days into:
  - Early: Mar 20 - Apr 5   (roughly matches the first half of external's window)
  - Late:  Apr 6 - Apr 19   (roughly matches the most recent 14 days)

Show per-family + per-overlay stats on each window to see:
  - Did fam_cross_0 work in Early and break in Late? (regime shift)
  - Was it always losing? (methodology blind spot)

Uses the same matched conventions as candidate-stack-overlay-v2-matched.py.

Usage:
  python3 src/scripts/crypto-5min/candidate-stack-temporal-split.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0
TAKER_CAP = 0.75

SPLIT_TS = int(datetime(2026, 4, 5, 12, 0, 0, tzinfo=timezone.utc).timestamp() * 1000)


def interval_from_slug(slug):
    for part in slug.split("-"):
        if part in ("5m", "15m"):
            return part
    return None


def crypto_from_slug(slug):
    prefix = slug.split("-", 1)[0].upper()
    return prefix if prefix in ("BTC", "ETH", "SOL", "XRP") else None


def side_from_snap(snap):
    up = snap.get("upBid", 0) or 0
    dn = snap.get("downBid", 0) or 0
    if up > dn: return "UP"
    if dn > up: return "DOWN"
    return "TIE"


def leader_ask(snap, side):
    return snap.get("upAsk") if side == "UP" else snap.get("downAsk")


def leader_bid(snap, side):
    return snap.get("upBid") if side == "UP" else snap.get("downBid")


def closest_snap(snaps, target_sec, tolerance=8):
    c = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not c: return None
    best = min(c, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))
    if abs(best.get("secondsBeforeEnd", 0) - target_sec) > tolerance: return None
    return best


def simulate(fill_ask, won):
    shares = math.floor(TRADE_SIZE / fill_ask)
    if shares < 1: return 0.0
    if won: return shares * (1.0 - fill_ask)
    return -shares * fill_ask


def main():
    rows_raw = []
    with open(PATH, "r") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except:
                continue
            if row.get("resolution") not in ("UP", "DOWN"): continue
            if not interval_from_slug(row.get("slug", "")): continue
            if not crypto_from_slug(row.get("slug", "")): continue
            rows_raw.append(row)
    rows_raw.sort(key=lambda r: r.get("marketEnd") or 0)

    last_res = {}
    samples = []

    for row in rows_raw:
        crypto = crypto_from_slug(row["slug"])
        interval = interval_from_slug(row["slug"])
        resolution = row["resolution"]
        end_ms = row.get("marketEnd")
        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        snap30 = closest_snap(snaps, 30)
        snap240 = closest_snap(snaps, 240, tolerance=30)

        def finalize():
            if interval == "5m":
                last_res[crypto] = resolution

        if not snap33 or not snap30: finalize(); continue
        side_33 = side_from_snap(snap33)
        if side_33 == "TIE": finalize(); continue
        ask_33 = leader_ask(snap33, side_33)
        if ask_33 is None or ask_33 <= 0.03 or ask_33 >= 0.97: finalize(); continue
        bid_33 = leader_bid(snap33, side_33) or 0
        spread_33 = ask_33 - bid_33

        ask_depth = snap33.get("upAskDepth", 0) if side_33 == "UP" else snap33.get("downAskDepth", 0)
        shares_needed = math.floor(TRADE_SIZE / ask_33)
        if shares_needed < 1 or ask_depth < shares_needed: finalize(); continue

        fill_ask = leader_ask(snap30, side_33)
        if fill_ask is None or fill_ask <= 0.03 or fill_ask >= 0.99: finalize(); continue
        if fill_ask > TAKER_CAP: finalize(); continue

        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        late_flip_15m = interval == "15m" and leader_240 not in (side_33, "TIE")
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == side_33)
        cross_0_15m = interval == "15m" and cross_match == 0
        price_55_65_15m = interval == "15m" and 0.55 <= ask_33 < 0.65
        spread_tight_5m = interval == "5m" and spread_33 <= 0.01

        qualifies = late_flip_15m or cross_0_15m or price_55_65_15m or spread_tight_5m
        if not qualifies: finalize(); continue

        # Count how many families this market qualifies for — for overlap analysis
        num_families = sum([late_flip_15m, cross_0_15m, price_55_65_15m, spread_tight_5m])

        won = side_33 == resolution
        pnl = simulate(fill_ask, won)
        samples.append({
            "fill_ask": fill_ask,
            "won": won,
            "end_ms": end_ms,
            "pnl": pnl,
            "period": "Early" if end_ms < SPLIT_TS else "Late",
            "features": {
                "fam_late_flip": late_flip_15m,
                "fam_cross_0": cross_0_15m,
                "fam_price_55_65": price_55_65_15m,
                "fam_spread_tight": spread_tight_5m,
                "num_families": num_families,
            },
        })
        finalize()

    def eval_(sample_set, preds=None, exclude=None):
        bs = sample_set
        if preds:
            bs = [s for s in bs if all(s["features"].get(p) for p in preds)]
        if exclude:
            bs = [s for s in bs if not any(s["features"].get(e) for e in exclude)]
        if not bs: return None
        n = len(bs)
        wins = sum(1 for s in bs if s["won"])
        avg_fill = sum(s["fill_ask"] for s in bs) / n
        pnl = sum(s["pnl"] for s in bs)
        wr = wins / n * 100
        return {"n": n, "wr": wr, "avg_fill": avg_fill, "edge": wr - avg_fill * 100, "pnl": pnl, "per_tr": pnl / n}

    # By period and family
    for period in ("Early", "Late", "All"):
        if period == "All":
            data = samples
        else:
            data = [s for s in samples if s["period"] == period]
        first = min(data, key=lambda s: s["end_ms"])["end_ms"] if data else None
        last = max(data, key=lambda s: s["end_ms"])["end_ms"] if data else None
        print("=" * 95)
        print(f"PERIOD: {period}  "
              f"({datetime.fromtimestamp(first/1000,tz=timezone.utc).strftime('%m-%d') if first else ''} → "
              f"{datetime.fromtimestamp(last/1000,tz=timezone.utc).strftime('%m-%d') if last else ''}, "
              f"N={len(data)})")
        print("=" * 95)
        r = eval_(data)
        if r:
            print(f"  BASELINE: N={r['n']} WR={r['wr']:.2f}% AvgFill={r['avg_fill']*100:.2f}¢ "
                  f"Edge={r['edge']:+.2f}pp $/tr={r['per_tr']:+.3f} Total={r['pnl']:+.2f}")
        print(f"  {'Family':<22} {'N':>5} {'WR':>7} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
        for fam in ("fam_late_flip", "fam_cross_0", "fam_price_55_65", "fam_spread_tight"):
            r = eval_(data, preds=[fam])
            if not r: continue
            marker = "✓" if r["per_tr"] > 0 else "✗"
            print(f"  {fam:<22} {r['n']:>5} {r['wr']:>6.2f}% {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f} {marker}")
        print()

    # OVERLAP: how often are families co-firing?
    print("=" * 95)
    print("FAMILY OVERLAP — how many markets qualify for exactly N families")
    print("=" * 95)
    by_count = defaultdict(int)
    for s in samples:
        by_count[s["features"]["num_families"]] += 1
    for k in sorted(by_count.keys()):
        print(f"  {k} families: {by_count[k]} markets ({by_count[k]/len(samples)*100:.1f}%)")
    print()

    # EXCLUSIVE family analysis — only markets that qualify for EXACTLY this family, no others
    print("=" * 95)
    print("EXCLUSIVE family (only this family, no other family qualifies)")
    print("=" * 95)
    print(f"  {'Family':<22} {'N':>5} {'WR':>7} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
    for fam in ("fam_late_flip", "fam_cross_0", "fam_price_55_65", "fam_spread_tight"):
        exclusive = [s for s in samples if s["features"][fam] and s["features"]["num_families"] == 1]
        if not exclusive: continue
        n = len(exclusive)
        wins = sum(1 for s in exclusive if s["won"])
        avg_fill = sum(s["fill_ask"] for s in exclusive) / n
        pnl = sum(s["pnl"] for s in exclusive)
        wr = wins / n * 100
        edge = wr - avg_fill * 100
        marker = "✓" if pnl > 0 else "✗"
        print(f"  {fam:<22} {n:>5} {wr:>6.2f}% {edge:>+7.2f}pp {pnl/n:>+6.3f} {pnl:>+8.2f} {marker}")


if __name__ == "__main__":
    main()
