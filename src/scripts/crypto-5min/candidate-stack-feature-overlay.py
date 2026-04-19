#!/usr/bin/env python3
"""
Can we improve candidate-stack by adding features we haven't tested?

Approximates the current candidate-stack filter:
  - 15m family: late_flip OR cross_0 OR price_55_65
  - 5m family:  spread_tight (≤1¢)
  - Universal: leader ask ≤ 75¢, leader side not TIE

Then layers additional features (volatility, volume, inter-market, etc.) to
see which OVERLAYS improve the baseline candidate-stack edge.

Also tests ANTI-FILTERS — does excluding a sub-condition (e.g. skip all
cl_3candle_violent trades) improve things?

Usage:
  python3 src/scripts/crypto-5min/candidate-stack-feature-overlay.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone
import random

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE_USD = 5.0
WINNER_FEE_PCT = 0.07
random.seed(42)


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


def simulate(ask, won):
    if ask <= 0 or ask >= 1.0: return 0.0
    shares = TRADE_SIZE_USD / ask
    if won: return shares * (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return -shares * ask


def breakeven_wr(ask):
    win_payout = (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return ask / (win_payout + ask)


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

    # Build distributions
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

    # Pass through markets, applying candidate-stack filter + computing features
    last_res = {}
    last_cl_moves = defaultdict(lambda: deque(maxlen=3))
    samples = []

    for row in rows_raw:
        crypto = crypto_from_slug(row["slug"])
        interval = interval_from_slug(row["slug"])
        resolution = row["resolution"]
        end_ms = row.get("marketEnd")
        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        snap240 = closest_snap(snaps, 240, tolerance=30)

        def finalize():
            last_res[crypto] = resolution
            cm = row.get("chainlinkMoveDollars")
            if cm is not None:
                last_cl_moves[(crypto, interval)].append(abs(cm))

        if not snap33: finalize(); continue
        side = side_from_snap(snap33)
        if side == "TIE": finalize(); continue
        ask = leader_ask(snap33, side)
        if ask is None or ask <= 0 or ask > 0.75: finalize(); continue
        bid = leader_bid(snap33, side) or 0
        spread = ask - bid

        # Follower two-sided check
        follower_bid = snap33.get("downBid", 0) if side == "UP" else snap33.get("upBid", 0)
        if follower_bid < 0.05: finalize(); continue

        # Candidate-stack family qualifiers
        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        late_flip_15m = interval == "15m" and leader_240 not in (side, "TIE")
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == side)
        cross_0_15m = interval == "15m" and cross_match == 0
        price_55_65_15m = interval == "15m" and 0.55 <= ask < 0.65
        spread_tight_5m = interval == "5m" and spread <= 0.01

        qualifies = late_flip_15m or cross_0_15m or price_55_65_15m or spread_tight_5m
        if not qualifies: finalize(); continue

        # Feature battery for overlays
        bid_depth = snap33.get("upBidDepth", 0) if side == "UP" else snap33.get("downBidDepth", 0)
        ask_depth = snap33.get("upAskDepth", 0) if side == "UP" else snap33.get("downAskDepth", 0)
        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None
        prev_cl_1 = prev_cls[-1] if prev_cls else None
        volume = row.get("volume") or 0

        # Bid momentum
        window = snaps_in_range(snaps, 33, 90)
        snap60 = closest_snap(window, 60) if window else None
        bid_at_60 = leader_bid(snap60, side) if snap60 else None
        bid_rising = bid_at_60 is not None and bid > bid_at_60

        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0

        tod = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc) if end_ms else None
        us_daytime = tod is not None and 13 <= tod.hour <= 22
        weekend = tod is not None and tod.weekday() >= 5

        features = {
            # Chainlink vol
            "cl_prev_calm": prev_cl_1 is not None and prev_cl_1 <= cl_thr[0],
            "cl_prev_violent": prev_cl_1 is not None and prev_cl_1 >= cl_thr[2],
            "cl_3c_calm": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[0] and len(prev_cls) == 3,
            "cl_3c_violent": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,
            "cl_3c_mid": (prev_cl_3_avg is not None and len(prev_cls) == 3
                          and cl_thr[0] < prev_cl_3_avg < cl_thr[2]),
            # Volume
            "volume_high": volume >= volume_p50,
            "volume_low": 0 < volume <= volume_p25,
            # Structural
            "deep_bid_10k": bid_depth >= 10000,
            "deep_bid_30k": bid_depth >= 30000,
            "thin_ask_1k": 0 < ask_depth <= 1000,
            "wide_gap_10c": abs(up33 - dn33) >= 0.10,
            "wide_gap_20c": abs(up33 - dn33) >= 0.20,
            # Cross
            "cross_agree_all": cross_match == 3,
            "cross_agree_2plus": cross_match >= 2,
            "cross_agree_0": cross_match == 0,  # candidate-stack's native signal
            # Momentum
            "bid_rising_33": bid_rising,
            "leader_stable_240": leader_240 == side,
            # Families
            "fam_late_flip": late_flip_15m,
            "fam_cross_0": cross_0_15m,
            "fam_price_55_65": price_55_65_15m,
            "fam_spread_tight": spread_tight_5m,
            # Context
            "us_daytime": us_daytime,
            "weekend": weekend,
            "interval_15m": interval == "15m",
            "interval_5m": interval == "5m",
        }

        won = side == resolution
        samples.append({"ask": ask, "won": won, "features": features, "end_ms": end_ms})
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
        avg_ask = sum(s["ask"] for s in bs) / n
        pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        return {"n": n, "wr": wr, "be": be, "edge": wr - be, "pnl": pnl, "per_tr": pnl / n, "avg_ask": avg_ask}

    baseline = eval_(samples)
    print("=" * 95)
    print("Candidate-stack BASELINE (all 4 families, no overlay)")
    print("=" * 95)
    print(f"N={baseline['n']}  WR={baseline['wr']:.2f}%  AvgAsk={baseline['avg_ask'] * 100:.2f}¢  "
          f"Edge={baseline['edge']:+.2f}pp  $/tr={baseline['per_tr']:+.3f}  Total=${baseline['pnl']:+.2f}")
    print()

    # Overlay: does adding each feature IMPROVE $/tr?
    print("=" * 95)
    print("OVERLAY: $/trade improvement when adding each feature to candidate-stack filter")
    print(f"{'Feature':<22} {'N':>5} {'% kept':>7} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'Δ$/tr':>8}")
    print("-" * 95)
    print("=" * 95)
    overlays = []
    for flt in samples[0]["features"].keys():
        if flt.startswith("fam_"):
            continue
        r = eval_(samples, preds=[flt])
        if not r or r["n"] < 50: continue
        delta = r["per_tr"] - baseline["per_tr"]
        overlays.append((delta, flt, r))
    overlays.sort(key=lambda x: -x[0])
    for delta, flt, r in overlays:
        marker = "✓" if delta > 0 else ""
        pct_kept = r["n"] / baseline["n"] * 100
        print(f"{flt:<22} {r['n']:>5} {pct_kept:>6.1f}% {r['wr']:>6.2f}% {r['be']:>6.2f}% "
              f"{r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {delta:>+7.3f} {marker}")

    print()
    print("=" * 95)
    print("ANTI-OVERLAY: $/trade improvement when EXCLUDING trades matching each feature")
    print(f"{'Exclude':<22} {'N':>5} {'% kept':>7} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'Δ$/tr':>8}")
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
        marker = "✓" if delta > 0 else ""
        pct_kept = r["n"] / baseline["n"] * 100
        print(f"{flt:<22} {r['n']:>5} {pct_kept:>6.1f}% {r['wr']:>6.2f}% {r['be']:>6.2f}% "
              f"{r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {delta:>+7.3f} {marker}")

    # Per-family breakdown
    print()
    print("=" * 95)
    print("FAMILY BREAKDOWN (which families carry the candidate-stack edge)")
    print(f"{'Family':<22} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'Total':>8}")
    print("-" * 95)
    for fam in ("fam_late_flip", "fam_cross_0", "fam_price_55_65", "fam_spread_tight"):
        r = eval_(samples, preds=[fam])
        if not r: continue
        print(f"{fam:<22} {r['n']:>5} {r['wr']:>6.2f}% {r['be']:>6.2f}% {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+7.2f}")

    # Walk-forward of top 3 improvement overlays
    print()
    print("=" * 95)
    print("WALK-FORWARD (5 windows) on top 3 overlay candidates")
    print("=" * 95)
    sorted_samples = sorted(samples, key=lambda s: s["end_ms"] or 0)
    n_windows = 5
    window_size = len(sorted_samples) // n_windows
    top_overlays = [flt for delta, flt, r in overlays[:5] if delta > 0][:3]
    print(f"Top overlays by total $/tr lift: {top_overlays}")
    print()
    for flt in top_overlays:
        print(f"--- OVERLAY: candidate-stack + {flt} ---")
        neg = 0
        for i in range(n_windows):
            lo = i * window_size
            hi = (i + 1) * window_size if i < n_windows - 1 else len(sorted_samples)
            window = sorted_samples[lo:hi]
            r = eval_(window, preds=[flt])
            start_ts = sorted_samples[lo]["end_ms"] or 0
            end_ts = sorted_samples[hi - 1]["end_ms"] or 0
            s_date = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc).strftime("%m-%d")
            e_date = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).strftime("%m-%d")
            if not r or r["n"] < 10:
                print(f"  [{s_date}→{e_date}]  N={r['n'] if r else 0} (too thin)")
                continue
            if r["edge"] < 0: neg += 1
            mk = "✓" if r["edge"] > 0 else "✗"
            print(f"  [{s_date}→{e_date}]  N={r['n']:>4} WR={r['wr']:>5.2f}% Edge={r['edge']:>+6.2f}pp $/tr={r['per_tr']:>+6.3f} {mk}")
        print(f"  Negative windows: {neg}/5")
        print()


if __name__ == "__main__":
    main()
