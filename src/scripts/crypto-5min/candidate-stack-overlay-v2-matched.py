#!/usr/bin/env python3
"""
Candidate-stack overlay v2 — match external LLM's conventions EXACTLY.

Differences from v1 (candidate-stack-feature-overlay.py):

  1. NO 7% winner fee (external LLM's replay didn't apply it)
  2. Integer shares: math.floor(TRADE_SIZE / fill_ask), not fractional
  3. Fill price from T-30 snap, not T-33 leader_ask
  4. prev_resolutions ONLY updates on 5m markets (not 15m), matching
     strategy-complement-search.py's logic at line 422
  5. $10 trade size (matches external's $836 total / 839 trades = $1/tr)
  6. Depth check: selected_ask_depth >= floor(TRADE_SIZE / selected_ask)

Same feature overlays as v1.

Usage:
  python3 src/scripts/crypto-5min/candidate-stack-overlay-v2-matched.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0  # ← matches external LLM's $10 replay
TAKER_CAP = 0.75


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


def snaps_in_range(snaps, lo, hi):
    return [s for s in snaps
            if isinstance(s.get("secondsBeforeEnd"), (int, float))
            and lo <= s["secondsBeforeEnd"] <= hi]


def simulate(fill_ask, won):
    """External LLM's formula exactly: integer shares, no fee."""
    shares = math.floor(TRADE_SIZE / fill_ask)
    if shares < 1:
        return 0.0, 0
    if won:
        return shares * (1.0 - fill_ask), shares
    return -shares * fill_ask, shares


def quantile(lst, q):
    if not lst: return 0
    s = sorted(lst)
    idx = min(len(s) - 1, max(0, int(len(s) * q)))
    return s[idx]


def main() -> None:
    # Load
    rows_raw = []
    with open(PATH, "r") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("resolution") not in ("UP", "DOWN"): continue
            if not interval_from_slug(row.get("slug", "")): continue
            if not crypto_from_slug(row.get("slug", "")): continue
            rows_raw.append(row)
    rows_raw.sort(key=lambda r: r.get("marketEnd") or 0)

    all_volumes = [r.get("volume") for r in rows_raw if r.get("volume") is not None]
    all_cl_moves = {}
    for row in rows_raw:
        c = crypto_from_slug(row["slug"])
        iv = interval_from_slug(row["slug"])
        cm = row.get("chainlinkMoveDollars")
        if cm is not None:
            all_cl_moves.setdefault((c, iv), []).append(abs(cm))

    volume_p50 = quantile(all_volumes, 0.50)
    volume_p25 = quantile(all_volumes, 0.25)
    cl_thresholds = {k: (quantile(v, 0.25), quantile(v, 0.50), quantile(v, 0.75))
                     for k, v in all_cl_moves.items()}

    # Apply candidate-stack + compute overlays
    last_res = {}  # Only updated from 5m markets
    last_cl_moves = defaultdict(lambda: deque(maxlen=3))
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
            # EXTERNAL LLM'S RULE: prev_resolutions only updates from 5m slugs
            if interval == "5m":
                last_res[crypto] = resolution
            cm = row.get("chainlinkMoveDollars")
            if cm is not None:
                last_cl_moves[(crypto, interval)].append(abs(cm))

        if not snap33 or not snap30: finalize(); continue
        side_33 = side_from_snap(snap33)
        if side_33 == "TIE": finalize(); continue
        ask_33 = leader_ask(snap33, side_33)
        if ask_33 is None or ask_33 <= 0.03 or ask_33 >= 0.97: finalize(); continue
        bid_33 = leader_bid(snap33, side_33) or 0
        spread_33 = ask_33 - bid_33

        # Depth sanity
        ask_depth = snap33.get("upAskDepth", 0) if side_33 == "UP" else snap33.get("downAskDepth", 0)
        shares_needed = math.floor(TRADE_SIZE / ask_33)
        if shares_needed < 1 or ask_depth < shares_needed: finalize(); continue

        # Fill at T-30 on same side
        fill_ask = leader_ask(snap30, side_33)
        if fill_ask is None or fill_ask <= 0.03 or fill_ask >= 0.99: finalize(); continue
        if fill_ask > TAKER_CAP: finalize(); continue

        # Candidate-stack family qualifiers
        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        late_flip_15m = interval == "15m" and leader_240 not in (side_33, "TIE")
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == side_33)
        cross_0_15m = interval == "15m" and cross_match == 0
        price_55_65_15m = interval == "15m" and 0.55 <= ask_33 < 0.65
        spread_tight_5m = interval == "5m" and spread_33 <= 0.01

        qualifies = late_flip_15m or cross_0_15m or price_55_65_15m or spread_tight_5m
        if not qualifies: finalize(); continue

        # Features
        bid_depth = snap33.get("upBidDepth", 0) if side_33 == "UP" else snap33.get("downBidDepth", 0)
        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None
        prev_cl_1 = prev_cls[-1] if prev_cls else None
        volume = row.get("volume") or 0

        window = snaps_in_range(snaps, 33, 90)
        snap60 = closest_snap(window, 60) if window else None
        bid_at_60 = leader_bid(snap60, side_33) if snap60 else None
        bid_rising = bid_at_60 is not None and bid_33 > bid_at_60

        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0

        tod = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc) if end_ms else None
        us_daytime = tod is not None and 13 <= tod.hour <= 22
        weekend = tod is not None and tod.weekday() >= 5

        features = {
            "cl_prev_calm": prev_cl_1 is not None and prev_cl_1 <= cl_thr[0],
            "cl_prev_violent": prev_cl_1 is not None and prev_cl_1 >= cl_thr[2],
            "cl_3c_calm": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[0] and len(prev_cls) == 3,
            "cl_3c_violent": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,
            "cl_3c_mid": (prev_cl_3_avg is not None and len(prev_cls) == 3
                          and cl_thr[0] < prev_cl_3_avg < cl_thr[2]),
            "volume_high": volume >= volume_p50,
            "volume_low": 0 < volume <= volume_p25,
            "deep_bid_10k": bid_depth >= 10000,
            "deep_bid_30k": bid_depth >= 30000,
            "cross_agree_all": cross_match == 3,
            "cross_agree_2plus": cross_match >= 2,
            "cross_agree_0": cross_match == 0,
            "bid_rising_33": bid_rising,
            "leader_stable_240": leader_240 == side_33,
            "fam_late_flip": late_flip_15m,
            "fam_cross_0": cross_0_15m,
            "fam_price_55_65": price_55_65_15m,
            "fam_spread_tight": spread_tight_5m,
            "us_daytime": us_daytime,
            "weekend": weekend,
            "interval_15m": interval == "15m",
            "interval_5m": interval == "5m",
        }

        won = side_33 == resolution
        pnl, shares = simulate(fill_ask, won)
        samples.append({
            "ask_33": ask_33,
            "fill_ask": fill_ask,
            "won": won,
            "features": features,
            "end_ms": end_ms,
            "pnl": pnl,
            "shares": shares,
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
        edge_margin = wr - avg_fill * 100  # External LLM's metric
        return {"n": n, "wr": wr, "avg_fill": avg_fill, "edge_margin": edge_margin,
                "pnl": pnl, "per_tr": pnl / n}

    baseline = eval_(samples)
    print("=" * 95)
    print(f"Data span: {datetime.fromtimestamp(samples[0]['end_ms']/1000, tz=timezone.utc).strftime('%Y-%m-%d')} "
          f"to {datetime.fromtimestamp(samples[-1]['end_ms']/1000, tz=timezone.utc).strftime('%Y-%m-%d')}")
    print(f"Candidate-stack BASELINE — matched conventions (integer shares, no fee, T-30 fill, 5m-only prev res)")
    print("=" * 95)
    print(f"N={baseline['n']}  WR={baseline['wr']:.2f}%  AvgFill={baseline['avg_fill']*100:.2f}¢  "
          f"EdgeMargin={baseline['edge_margin']:+.2f}pp  $/tr={baseline['per_tr']:+.3f}  "
          f"Total=${baseline['pnl']:+.2f}")
    print()

    # Family breakdown
    print("=" * 95)
    print("FAMILY BREAKDOWN")
    print(f"{'Family':<22} {'N':>5} {'WR':>7} {'AvgFill':>8} {'EdgeM':>8} {'$/tr':>7} {'Total':>9}")
    print("-" * 95)
    for fam in ("fam_late_flip", "fam_cross_0", "fam_price_55_65", "fam_spread_tight"):
        r = eval_(samples, preds=[fam])
        if not r: continue
        print(f"{fam:<22} {r['n']:>5} {r['wr']:>6.2f}% {r['avg_fill']*100:>7.2f}¢ "
              f"{r['edge_margin']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f}")

    # Overlay: improvements
    print()
    print("=" * 95)
    print("TOP OVERLAYS (feature added to stack)")
    print(f"{'Overlay':<22} {'N':>5} {'kept':>6} {'WR':>7} {'AvgFill':>8} {'EdgeM':>8} {'$/tr':>7} {'Δ$/tr':>8}")
    print("-" * 95)
    overlays = []
    for flt in samples[0]["features"].keys():
        if flt.startswith("fam_"): continue
        r = eval_(samples, preds=[flt])
        if not r or r["n"] < 50: continue
        delta = r["per_tr"] - baseline["per_tr"]
        overlays.append((delta, flt, r))
    overlays.sort(key=lambda x: -x[0])
    for delta, flt, r in overlays[:15]:
        pct_kept = r["n"] / baseline["n"] * 100
        mk = "✓" if delta > 0 else ""
        print(f"{flt:<22} {r['n']:>5} {pct_kept:>5.1f}% {r['wr']:>6.2f}% {r['avg_fill']*100:>7.2f}¢ "
              f"{r['edge_margin']:>+7.2f}pp {r['per_tr']:>+6.3f} {delta:>+7.3f} {mk}")

    # Anti-overlay
    print()
    print("=" * 95)
    print("TOP ANTI-OVERLAYS (feature excluded from stack)")
    print(f"{'Exclude':<22} {'N':>5} {'kept':>6} {'WR':>7} {'AvgFill':>8} {'EdgeM':>8} {'$/tr':>7} {'Δ$/tr':>8}")
    print("-" * 95)
    anti = []
    for flt in samples[0]["features"].keys():
        if flt.startswith("fam_"): continue
        r = eval_(samples, exclude=[flt])
        if not r or r["n"] < 50: continue
        delta = r["per_tr"] - baseline["per_tr"]
        anti.append((delta, flt, r))
    anti.sort(key=lambda x: -x[0])
    for delta, flt, r in anti[:15]:
        pct_kept = r["n"] / baseline["n"] * 100
        mk = "✓" if delta > 0 else ""
        print(f"{flt:<22} {r['n']:>5} {pct_kept:>5.1f}% {r['wr']:>6.2f}% {r['avg_fill']*100:>7.2f}¢ "
              f"{r['edge_margin']:>+7.2f}pp {r['per_tr']:>+6.3f} {delta:>+7.3f} {mk}")


if __name__ == "__main__":
    main()
