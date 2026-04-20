#!/usr/bin/env python3
"""
Deep validation of low-WR (underdog-buying) candidate strategies.

Addresses:
  Q1. Walk-forward stability across 5 rolling ~6-day windows
  Q2. Bootstrap 90% CI on WR and $/trade (variance is EXTREME at 5-10c entry)
  Q3. Loss asymmetry stress — how far could WR drop before breakeven
  Q4. Three-regime Chainlink vol breakdown with cross_0

Strategies tested:
  A. cross_0 @ 05-10c                         (headline — 827 trades, highest volume)
  B. cross_0 @ 15-20c                         (strong edge, solid N)
  C. cl_3c_calm + cross_0 @ 05-10c            (highest $/tr, smaller N)
  D. cross_0 + narrow_gap_5c @ 40-50c         (5/5 walk-forward in initial search)
  E. cross_0 + narrow_gap_10c @ 40-50c        (larger N variant)
  F. cross_0 + leader_just_flipped @ 25-30c   (122 trades)

Usage:
  python3 src/scripts/crypto-5min/low-wr-validation-deep-dive.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import random
import statistics
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone

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


def ask_for(snap, side):
    return snap.get("upAsk") if side == "UP" else snap.get("downAsk")


def bid_for(snap, side):
    return snap.get("upBid") if side == "UP" else snap.get("downBid")


def other_side(side):
    if side == "UP": return "DOWN"
    if side == "DOWN": return "UP"
    return "TIE"


def closest_snap(snaps, target_sec, tolerance=8):
    c = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not c: return None
    best = min(c, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))
    if abs(best.get("secondsBeforeEnd", 0) - target_sec) > tolerance: return None
    return best


def simulate(ask, won):
    if ask <= 0 or ask >= 1.0: return 0.0
    shares = TRADE_SIZE_USD / ask
    if won: return shares * (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return -shares * ask


def breakeven_wr(ask):
    win_payout = (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return ask / (win_payout + ask)


def band_of(ask):
    if ask < 0.05: return None
    if ask < 0.10: return "05-10"
    if ask < 0.15: return "10-15"
    if ask < 0.20: return "15-20"
    if ask < 0.25: return "20-25"
    if ask < 0.30: return "25-30"
    if ask < 0.40: return "30-40"
    if ask < 0.50: return "40-50"
    return None


def quantile(lst, q):
    if not lst: return 0
    s = sorted(lst)
    idx = min(len(s) - 1, max(0, int(len(s) * q)))
    return s[idx]


def build_samples():
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

    all_volumes = [r.get("volume") for r in rows_raw if r.get("volume") is not None]
    all_cl_moves = {}
    for row in rows_raw:
        c = crypto_from_slug(row["slug"])
        iv = interval_from_slug(row["slug"])
        cm = row.get("chainlinkMoveDollars")
        if cm is not None:
            all_cl_moves.setdefault((c, iv), []).append(abs(cm))

    volume_p25 = quantile(all_volumes, 0.25)
    volume_p50 = quantile(all_volumes, 0.50)
    cl_thresholds = {k: (quantile(v, 0.25), quantile(v, 0.50), quantile(v, 0.75))
                     for k, v in all_cl_moves.items()}

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
            if interval == "5m":
                last_res[crypto] = resolution
            cm = row.get("chainlinkMoveDollars")
            if cm is not None:
                last_cl_moves[(crypto, interval)].append(abs(cm))

        if not snap33: finalize(); continue
        leader_side = side_from_snap(snap33)
        if leader_side == "TIE": finalize(); continue

        underdog_side = other_side(leader_side)
        underdog_ask = ask_for(snap33, underdog_side)
        if underdog_ask is None or underdog_ask <= 0 or underdog_ask >= 1.0: finalize(); continue
        band = band_of(underdog_ask)
        if band is None: finalize(); continue

        underdog_ask_depth = snap33.get("upAskDepth", 0) if underdog_side == "UP" else snap33.get("downAskDepth", 0)
        shares_needed = math.floor(TRADE_SIZE_USD / underdog_ask)
        if shares_needed < 1 or underdog_ask_depth < shares_needed: finalize(); continue

        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0
        gap = abs(up33 - dn33)

        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == leader_side)
        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None
        volume = row.get("volume") or 0
        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        leader_just_flipped = leader_240 not in (leader_side, "TIE")

        features = {
            "cross_0": cross_match == 0,
            "cross_1": cross_match == 1,
            "cl_3c_violent": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,
            "cl_3c_calm": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[0] and len(prev_cls) == 3,
            "cl_3c_mid": (prev_cl_3_avg is not None and len(prev_cls) == 3
                          and cl_thr[0] < prev_cl_3_avg < cl_thr[2]),
            "narrow_gap_5c": gap <= 0.05,
            "narrow_gap_10c": gap <= 0.10,
            "volume_low": 0 < volume <= volume_p25,
            "leader_just_flipped": leader_just_flipped,
        }

        won = underdog_side == resolution
        samples.append({"band": band, "ask": underdog_ask, "won": won, "features": features, "end_ms": end_ms})
        finalize()

    return samples


def eval_(sample_set, preds=None, band=None):
    bs = sample_set
    if band is not None:
        bs = [s for s in bs if s["band"] == band]
    if preds:
        bs = [s for s in bs if all(s["features"].get(p) for p in preds)]
    if not bs: return None
    n = len(bs)
    wins = sum(1 for s in bs if s["won"])
    avg_ask = sum(s["ask"] for s in bs) / n
    pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
    be = breakeven_wr(avg_ask) * 100
    wr = wins / n * 100
    return {"n": n, "wr": wr, "be": be, "edge": wr - be, "pnl": pnl, "per_tr": pnl / n, "avg_ask": avg_ask}


def bootstrap_ci(samples, preds, band, n_bootstrap=2000):
    bs = [s for s in samples if s["band"] == band and all(s["features"].get(p) for p in preds)]
    if len(bs) < 10: return None
    wrs, per_trs = [], []
    for _ in range(n_bootstrap):
        resample = [bs[random.randint(0, len(bs) - 1)] for _ in range(len(bs))]
        wins = sum(1 for s in resample if s["won"])
        wrs.append(wins / len(resample) * 100)
        pnl = sum(simulate(s["ask"], s["won"]) for s in resample)
        per_trs.append(pnl / len(resample))
    wrs.sort()
    per_trs.sort()
    return {
        "wr_p05": wrs[int(0.05 * len(wrs))],
        "wr_p50": wrs[int(0.50 * len(wrs))],
        "wr_p95": wrs[int(0.95 * len(wrs))],
        "per_tr_p05": per_trs[int(0.05 * len(per_trs))],
        "per_tr_p50": per_trs[int(0.50 * len(per_trs))],
        "per_tr_p95": per_trs[int(0.95 * len(per_trs))],
    }


def walk_forward(samples, preds, band, n_windows=5):
    sorted_s = sorted(samples, key=lambda s: s["end_ms"] or 0)
    window_size = len(sorted_s) // n_windows
    windows = []
    for i in range(n_windows):
        lo = i * window_size
        hi = (i + 1) * window_size if i < n_windows - 1 else len(sorted_s)
        slice_ = sorted_s[lo:hi]
        r = eval_(slice_, preds=preds, band=band)
        start_ts = sorted_s[lo]["end_ms"] or 0
        end_ts = sorted_s[hi - 1]["end_ms"] or 0
        start_date = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc).strftime("%m-%d")
        end_date = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).strftime("%m-%d")
        windows.append({"start": start_date, "end": end_date, "result": r})
    return windows


def main() -> None:
    print("Loading samples...")
    samples = build_samples()
    print(f"Total low-band underdog samples: {len(samples)}")
    print()

    strategies = [
        ("A", "cross_0 @ 05-10¢ (headline volume)", ["cross_0"], "05-10"),
        ("B", "cross_0 @ 15-20¢", ["cross_0"], "15-20"),
        ("C", "cl_3c_calm + cross_0 @ 05-10¢", ["cl_3c_calm", "cross_0"], "05-10"),
        ("D", "cross_0 + narrow_gap_5c @ 40-50¢", ["cross_0", "narrow_gap_5c"], "40-50"),
        ("E", "cross_0 + narrow_gap_10c @ 40-50¢", ["cross_0", "narrow_gap_10c"], "40-50"),
        ("F", "cross_0 + leader_just_flipped @ 25-30¢", ["cross_0", "leader_just_flipped"], "25-30"),
    ]

    # Q1: Walk-forward
    print("=" * 100)
    print("Q1: Walk-forward validation (5 windows, ~6 days each)")
    print("=" * 100)
    for label, name, preds, band in strategies:
        print(f"--- {label}: {name} ---")
        windows = walk_forward(samples, preds, band)
        neg = 0
        thin = 0
        for w in windows:
            r = w["result"]
            if r is None or r["n"] < 5:
                thin += 1
                n_val = r["n"] if r else 0
                print(f"  [{w['start']}→{w['end']}]  N={n_val:>4} (too thin)")
                continue
            if r["edge"] < 0: neg += 1
            mk = "✓" if r["edge"] > 0 else "✗"
            print(f"  [{w['start']}→{w['end']}]  N={r['n']:>4} WR={r['wr']:>5.2f}% Edge={r['edge']:>+6.2f}pp $/tr={r['per_tr']:>+6.3f} {mk}")
        print(f"  Negative windows: {neg}/5  (thin windows: {thin})")
        print()

    # Q2: Bootstrap CI
    print("=" * 100)
    print("Q2: Bootstrap 90% CI — variance is EXTREME at low-price entries")
    print("=" * 100)
    print(f"{'Strategy':<44} {'N':>4} {'WR_p05':>7} {'WR_p50':>7} {'WR_p95':>7} {'$tr_p05':>8} {'$tr_p50':>8} {'$tr_p95':>8}")
    for label, name, preds, band in strategies:
        ci = bootstrap_ci(samples, preds, band)
        if not ci: continue
        r = eval_(samples, preds=preds, band=band)
        print(f"{label}: {name:<40} {r['n']:>4} "
              f"{ci['wr_p05']:>6.2f}% {ci['wr_p50']:>6.2f}% {ci['wr_p95']:>6.2f}% "
              f"{ci['per_tr_p05']:>+7.2f} {ci['per_tr_p50']:>+7.2f} {ci['per_tr_p95']:>+7.2f}")

    # Q3: Loss asymmetry vs breakeven
    print()
    print("=" * 100)
    print("Q3: Loss asymmetry — how much WR buffer above breakeven?")
    print("=" * 100)
    print(f"{'Strategy':<44} {'AvgAsk':>7} {'Actual WR':>10} {'Breakeven':>10} {'Buffer':>7} {'p05 vs BE':>10}")
    for label, name, preds, band in strategies:
        r = eval_(samples, preds=preds, band=band)
        ci = bootstrap_ci(samples, preds, band)
        if not r or not ci: continue
        buffer_actual = r["wr"] - r["be"]
        buffer_p05 = ci["wr_p05"] - r["be"]
        mk = "✓" if buffer_p05 > 0 else "⚠"
        print(f"{label}: {name:<40} {r['avg_ask'] * 100:>6.2f}¢ "
              f"{r['wr']:>9.2f}% {r['be']:>9.2f}% {buffer_actual:>+6.2f}pp {buffer_p05:>+9.2f}pp {mk}")

    # Q4: Regime decomposition at 05-10¢ with cross_0
    print()
    print("=" * 100)
    print("Q4: Three-regime Chainlink vol breakdown @ cross_0 @ 05-10¢")
    print("=" * 100)
    print(f"{'Regime':<25} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'Total':>8}")
    for regime in ("cl_3c_calm", "cl_3c_mid", "cl_3c_violent"):
        r = eval_(samples, preds=["cross_0", regime], band="05-10")
        if not r: continue
        print(f"{regime:<25} {r['n']:>5} {r['wr']:>6.2f}% {r['be']:>6.2f}% {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+7.2f}")

    # Expected daily economics (at $5 stake)
    print()
    print("=" * 100)
    print("Daily economics projection (at $5 stake, 30-day historical)")
    print("=" * 100)
    # Approximate daily trade counts: trades in 30 days / 30
    print(f"{'Strategy':<44} {'Trades/30d':>10} {'Daily avg':>9} {'$/day':>7} {'Daily σ':>8}")
    for label, name, preds, band in strategies:
        bs = [s for s in samples if s["band"] == band and all(s["features"].get(p) for p in preds)]
        if not bs: continue
        n = len(bs)
        per_day_n = n / 30
        pnls = [simulate(s["ask"], s["won"]) for s in bs]
        mean_pnl = sum(pnls) / n
        expected_day = mean_pnl * per_day_n
        # Approximate daily sigma
        if n > 1:
            tr_sigma = statistics.stdev(pnls)
        else:
            tr_sigma = 0
        daily_sigma = tr_sigma * math.sqrt(per_day_n)
        print(f"{label}: {name:<40} {n:>10} {per_day_n:>8.2f} {expected_day:>+6.2f} {daily_sigma:>+7.2f}")


if __name__ == "__main__":
    main()
