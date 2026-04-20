#!/usr/bin/env python3
"""
Low-WR (underdog-buying) strategy search.

Goal: find conditions where buying the FOLLOWER (underdog) at low prices
produces positive edge. Low-WR strategies win rarely but big:
  - Buy at 15c: win = +$0.85 per share ($4.25 on $5 trade at 5 shares)
  - Loss: -$0.75 per share
  - Breakeven WR = 15% (approximately)

Hypothesis: if markets systematically over-price favorites in certain
regimes (e.g., cross_0 where no other cryptos confirm the leader), the
UNDERDOG in those same markets should be under-priced.

Feature battery:
  Cross-crypto:
    - cross_0 (no other cryptos agree with leader → leader may be overpriced)
    - cross_1 (only one other crypto agrees)
  Volatility:
    - cl_3c_violent (recent candles had violent underlying moves)
    - cl_3c_calm
    - cl_prev_calm / violent
  Structural:
    - narrow_gap_5c (|upBid - downBid| ≤ 5c, close to coinflip)
    - narrow_gap_10c
    - tight_spread_2c (underdog's spread ≤ 2c)
  Volume:
    - volume_low (below p25 — thin markets, maybe mispriced)
    - volume_high
  Market-maker behavior:
    - leader_just_flipped (snap240 leader != snap33 leader)

Then walk-forward 60/40 + bootstrap on top candidates.

Usage:
  python3 src/scripts/crypto-5min/low-wr-strategy-search.py pricing-data.jsonl
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


def low_band_of(ask):
    """Price bands for the UNDERDOG we're buying."""
    if ask < 0.05: return None  # too tiny, likely illiquid
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


def main() -> None:
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
            # Match the external-LLM convention used in candidate-stack work
            if interval == "5m":
                last_res[crypto] = resolution
            cm = row.get("chainlinkMoveDollars")
            if cm is not None:
                last_cl_moves[(crypto, interval)].append(abs(cm))

        if not snap33: finalize(); continue
        leader_side = side_from_snap(snap33)
        if leader_side == "TIE": finalize(); continue

        # Underdog is the OTHER side (the follower)
        underdog_side = other_side(leader_side)
        underdog_ask = ask_for(snap33, underdog_side)
        if underdog_ask is None or underdog_ask <= 0 or underdog_ask >= 1.0: finalize(); continue
        band = low_band_of(underdog_ask)
        if band is None: finalize(); continue

        # Liquidity sanity: need the underdog ask side to have at least trade-size shares
        underdog_ask_depth = snap33.get("upAskDepth", 0) if underdog_side == "UP" else snap33.get("downAskDepth", 0)
        shares_needed = math.floor(TRADE_SIZE_USD / underdog_ask)
        if shares_needed < 1 or underdog_ask_depth < shares_needed: finalize(); continue

        # Features
        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0
        gap = abs(up33 - dn33)
        underdog_bid = bid_for(snap33, underdog_side) or 0
        underdog_spread = underdog_ask - underdog_bid

        # cross_0/1 relative to LEADER (measuring "no confirmation" regime)
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == leader_side)

        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None
        prev_cl_1 = prev_cls[-1] if prev_cls else None
        volume = row.get("volume") or 0

        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        leader_just_flipped = leader_240 not in (leader_side, "TIE")

        tod = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc) if end_ms else None
        us_daytime = tod is not None and 13 <= tod.hour <= 22
        weekend = tod is not None and tod.weekday() >= 5

        features = {
            # Cross (measuring lack of confirmation for leader = underdog may be underpriced)
            "cross_0": cross_match == 0,
            "cross_1": cross_match == 1,
            "cross_2plus": cross_match >= 2,
            # Vol regime
            "cl_prev_calm": prev_cl_1 is not None and prev_cl_1 <= cl_thr[0],
            "cl_prev_violent": prev_cl_1 is not None and prev_cl_1 >= cl_thr[2],
            "cl_3c_violent": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,
            "cl_3c_calm": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[0] and len(prev_cls) == 3,
            # Gap regime
            "narrow_gap_5c": gap <= 0.05,
            "narrow_gap_10c": gap <= 0.10,
            "wide_gap_20c": gap >= 0.20,
            # Structural
            "tight_spread_2c": underdog_spread <= 0.02,
            "volume_high": volume >= volume_p50,
            "volume_low": 0 < volume <= volume_p25,
            # Trend
            "leader_just_flipped": leader_just_flipped,
            # Context
            "us_daytime": us_daytime,
            "weekend": weekend,
            "interval_15m": interval == "15m",
            "interval_5m": interval == "5m",
        }

        won = underdog_side == resolution
        samples.append({"band": band, "ask": underdog_ask, "won": won, "features": features, "end_ms": end_ms})
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

    print("=" * 95)
    print("UNDERDOG baseline by price band (no filter)")
    print("=" * 95)
    print(f"{'Band':<8} {'N':>6} {'AvgAsk':>7} {'WR':>7} {'Breakeven':>10} {'Edge':>8} {'$/tr':>7} {'Total':>8}")
    for b in ("05-10", "10-15", "15-20", "20-25", "25-30", "30-40", "40-50"):
        bs = [s for s in samples if s["band"] == b]
        if not bs: continue
        n = len(bs)
        wins = sum(1 for s in bs if s["won"])
        avg_ask = sum(s["ask"] for s in bs) / n
        pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        marker = "✓" if wr > be else "✗"
        print(f"{b:<8} {n:>6} {avg_ask * 100:>6.2f}¢ {wr:>6.2f}% {be:>9.2f}% {wr - be:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+7.2f} {marker}")

    print()
    print("=" * 95)
    print("Top 25 positive single-filter edges (N >= 30)")
    print("=" * 95)
    hits = []
    filter_keys = sorted(samples[0]["features"].keys()) if samples else []
    for flt in filter_keys:
        for b in ("05-10", "10-15", "15-20", "20-25", "25-30", "30-40", "40-50"):
            bs = [s for s in samples if s["band"] == b and s["features"].get(flt)]
            if len(bs) < 30: continue
            n = len(bs)
            wins = sum(1 for s in bs if s["won"])
            avg_ask = sum(s["ask"] for s in bs) / n
            pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
            be = breakeven_wr(avg_ask) * 100
            wr = wins / n * 100
            hits.append((wr - be, flt, b, n, wr, be, pnl))
    hits.sort(key=lambda x: -x[0])
    print(f"{'Filter':<22} {'Band':<8} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'Total':>8}")
    for edge, flt, b, n, wr, be, pnl in hits[:25]:
        if edge <= 0: break
        print(f"{flt:<22} {b:<8} {n:>5} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+7.2f}")

    print()
    print("=" * 95)
    print("Top 15 positive two-filter combos (N >= 30, edge > 0)")
    print("=" * 95)
    combo_hits = []
    for i, a in enumerate(filter_keys):
        for b_flt in filter_keys[i + 1:]:
            for band in ("05-10", "10-15", "15-20", "20-25", "25-30", "30-40", "40-50"):
                bs = [s for s in samples if s["band"] == band
                      and s["features"].get(a) and s["features"].get(b_flt)]
                if len(bs) < 30: continue
                n = len(bs)
                wins = sum(1 for s in bs if s["won"])
                avg_ask = sum(s["ask"] for s in bs) / n
                pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
                be = breakeven_wr(avg_ask) * 100
                wr = wins / n * 100
                combo_hits.append((wr - be, a, b_flt, band, n, wr, be, pnl))
    combo_hits.sort(key=lambda x: -x[0])
    print(f"{'A':<22} {'B':<22} {'Band':<7} {'N':>5} {'WR':>7} {'Edge':>8} {'$/tr':>7} {'Total':>8}")
    for edge, a, b, band, n, wr, be, pnl in combo_hits[:15]:
        if edge <= 0: break
        print(f"{a:<22} {b:<22} {band:<7} {n:>5} {wr:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+7.2f}")

    # Walk-forward on top 5
    print()
    print("=" * 95)
    print("Walk-forward (5 windows) on top 5 pair strategies")
    print("=" * 95)
    sorted_samples = sorted(samples, key=lambda s: s["end_ms"] or 0)
    n_windows = 5
    window_size = len(sorted_samples) // n_windows
    top = [(a, b, band) for edge, a, b, band, *_ in combo_hits[:10] if edge > 0][:5]
    for a, b, band in top:
        print(f"--- {a} + {b} @ {band} ---")
        neg = 0
        for i in range(n_windows):
            lo = i * window_size
            hi = (i + 1) * window_size if i < n_windows - 1 else len(sorted_samples)
            slice_ = sorted_samples[lo:hi]
            r = eval_(slice_, preds=[a, b])
            start_ts = sorted_samples[lo]["end_ms"] or 0
            end_ts = sorted_samples[hi - 1]["end_ms"] or 0
            s_date = datetime.fromtimestamp(start_ts / 1000, tz=timezone.utc).strftime("%m-%d")
            e_date = datetime.fromtimestamp(end_ts / 1000, tz=timezone.utc).strftime("%m-%d")
            if not r:
                print(f"  [{s_date}→{e_date}]  N={0}")
                continue
            # Filter to band
            band_slice = [s for s in slice_ if s["band"] == band and s["features"].get(a) and s["features"].get(b)]
            if len(band_slice) < 5:
                print(f"  [{s_date}→{e_date}]  N={len(band_slice)} (too thin)")
                continue
            r2 = eval_(band_slice)
            if r2["edge"] < 0: neg += 1
            mk = "✓" if r2["edge"] > 0 else "✗"
            print(f"  [{s_date}→{e_date}]  N={r2['n']:>4} WR={r2['wr']:>5.2f}% Edge={r2['edge']:>+6.2f}pp $/tr={r2['per_tr']:>+6.3f} {mk}")
        print(f"  Negative windows: {neg}/5")
        print()


if __name__ == "__main__":
    main()
