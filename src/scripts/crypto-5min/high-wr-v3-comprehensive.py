#!/usr/bin/env python3
"""
Comprehensive high-WR strategy search v3.

Adds every feature we haven't tried:

Underlying volatility (from previous candles' chainlinkMoveDollars):
  cl_prev_calm           — previous candle's Chainlink move below 25th pctile
  cl_prev_violent        — previous candle's move above 75th pctile
  cl_3candle_calm_avg    — avg of last 3 candles' |moves| below median
  cl_3candle_violent_avg — above 75th pctile

Inter-market regime (snapshot of all 4 cryptos at T-33):
  all_cryptos_favorite_85 — all 4 cryptos have leader ask ≥ 85¢
  all_cryptos_same_side   — all 4 cryptos' leaders point same direction (UP or DOWN)
  all_cryptos_one_sided   — all 4 have leader ≥ 95¢ (total squash regime)

Volume:
  volume_high — market's total volume above median
  volume_low  — below 25th pctile

Better-calibrated bid volatility:
  bid_std_p25            — bid std in T-90..T-33 below 25th pctile of distribution
  bid_std_p75            — above 75th pctile

Plus all v1/v2 features (cross_agree_all, deep_bid_*, bid_rising_33, etc.)

Then:
  1. Single-filter top 20 in 85¢+
  2. Pair top 15 with edge ≥ 3pp
  3. Triple with dedupe
  4. Train/test split (time-ordered 60/40) for top pair strategies

Usage:
  python3 src/scripts/crypto-5min/high-wr-v3-comprehensive.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import statistics
import sys
from collections import defaultdict, deque
from datetime import datetime, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE_USD = 5.0
WINNER_FEE_PCT = 0.07


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
    if up > dn:
        return "UP"
    if dn > up:
        return "DOWN"
    return "TIE"


def leader_ask(snap, side):
    return snap.get("upAsk") if side == "UP" else snap.get("downAsk")


def leader_bid(snap, side):
    return snap.get("upBid") if side == "UP" else snap.get("downBid")


def closest_snap(snaps, target_sec, tolerance=8):
    c = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not c:
        return None
    best = min(c, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))
    if abs(best.get("secondsBeforeEnd", 0) - target_sec) > tolerance:
        return None
    return best


def snaps_in_range(snaps, lo, hi):
    return [s for s in snaps
            if isinstance(s.get("secondsBeforeEnd"), (int, float))
            and lo <= s["secondsBeforeEnd"] <= hi]


def simulate(ask, won):
    if ask <= 0 or ask >= 1.0:
        return 0.0
    shares = TRADE_SIZE_USD / ask
    if won:
        return shares * (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return -shares * ask


def breakeven_wr(ask):
    win_payout = (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return ask / (win_payout + ask)


def band_of(ask):
    if ask < 0.75: return None
    if ask < 0.80: return "75-80"
    if ask < 0.85: return "80-85"
    if ask < 0.90: return "85-90"
    if ask < 0.93: return "90-93"
    if ask < 0.96: return "93-96"
    if ask < 0.99: return "96-99"
    return "99+"


def main() -> None:
    # Pass 1: load all rows, sort by marketEnd
    rows_raw = []
    with open(PATH, "r") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            if row.get("resolution") not in ("UP", "DOWN"):
                continue
            if not interval_from_slug(row.get("slug", "")):
                continue
            if not crypto_from_slug(row.get("slug", "")):
                continue
            rows_raw.append(row)
    rows_raw.sort(key=lambda r: r.get("marketEnd") or 0)

    # Pass 2: precompute distributions for volatility-threshold calibration
    all_bid_stds_85plus = []
    all_volumes = []
    all_cl_moves = {}  # crypto+interval → list of |moves|
    for row in rows_raw:
        crypto = crypto_from_slug(row["slug"])
        interval = interval_from_slug(row["slug"])
        cl_move = row.get("chainlinkMoveDollars")
        if cl_move is not None:
            all_cl_moves.setdefault((crypto, interval), []).append(abs(cl_move))
        if row.get("volume") is not None:
            all_volumes.append(row["volume"])

        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        if not snap33: continue
        side = side_from_snap(snap33)
        if side == "TIE": continue
        ask = leader_ask(snap33, side)
        if ask is None or ask < 0.85 or ask >= 1.0: continue
        window = snaps_in_range(snaps, 33, 90)
        if len(window) >= 3:
            bids = [leader_bid(s, side) or 0 for s in window]
            try:
                all_bid_stds_85plus.append(statistics.stdev(bids))
            except Exception:
                pass

    def quantile(lst, q):
        if not lst: return 0
        s = sorted(lst)
        idx = min(len(s) - 1, max(0, int(len(s) * q)))
        return s[idx]

    bid_std_p25 = quantile(all_bid_stds_85plus, 0.25)
    bid_std_p75 = quantile(all_bid_stds_85plus, 0.75)
    volume_p50 = quantile(all_volumes, 0.50)
    volume_p25 = quantile(all_volumes, 0.25)

    # Per-crypto+interval Chainlink move quantiles
    cl_thresholds = {}
    for key, moves in all_cl_moves.items():
        cl_thresholds[key] = (quantile(moves, 0.25), quantile(moves, 0.50), quantile(moves, 0.75))

    print("Calibrated thresholds:")
    print(f"  bid_std 85+: p25={bid_std_p25:.4f}, p75={bid_std_p75:.4f}")
    print(f"  volume:      p25={volume_p25:.2f}, p50={volume_p50:.2f}")
    print(f"  cl_move:     by crypto+interval (see data)")
    print()

    # Pass 3: cross-market index (for inter-market regime at T-33)
    # Group rows by candle-end time to find concurrent markets across cryptos
    concurrent = defaultdict(list)
    for idx, row in enumerate(rows_raw):
        end = row.get("marketEnd")
        interval = interval_from_slug(row["slug"])
        if end is not None:
            # Bucket by (marketEnd, interval) since BTC/ETH/SOL/XRP share end times
            concurrent[(end, interval)].append(idx)

    # Pass 4: compute features per market
    last_res = {}
    last_cl_moves = defaultdict(lambda: deque(maxlen=3))  # last 3 |moves| per crypto+interval
    samples = []

    for row_idx, row in enumerate(rows_raw):
        slug = row["slug"]
        crypto = crypto_from_slug(slug)
        interval = interval_from_slug(slug)
        resolution = row["resolution"]
        end_ms = row.get("marketEnd")
        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        snap240 = closest_snap(snaps, 240, tolerance=30)

        # Update trackers even if this market fails the filter, so later markets see them
        def finalize():
            last_res[crypto] = resolution
            cl_move = row.get("chainlinkMoveDollars")
            if cl_move is not None:
                last_cl_moves[(crypto, interval)].append(abs(cl_move))

        if not snap33:
            finalize()
            continue
        side = side_from_snap(snap33)
        if side == "TIE":
            finalize()
            continue
        ask = leader_ask(snap33, side)
        if ask is None or ask <= 0 or ask >= 1.0:
            finalize()
            continue
        band = band_of(ask)
        if band is None:
            finalize()
            continue

        # Volatility features
        window = snaps_in_range(snaps, 33, 90)
        bid_std = None
        if len(window) >= 3:
            bids = [leader_bid(s, side) or 0 for s in window]
            try:
                bid_std = statistics.stdev(bids)
            except Exception:
                bid_std = None

        snap60 = closest_snap(window, 60) if window else None
        bid_at_60 = leader_bid(snap60, side) if snap60 else None
        bid33 = leader_bid(snap33, side) or 0
        bid_rising = bid_at_60 is not None and bid33 > bid_at_60

        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0

        # Chainlink previous-candle volatility
        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_1 = prev_cls[-1] if prev_cls else None
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None

        # Inter-market regime (at T-33 across all 4 cryptos)
        all_cryptos_favorite_85 = False
        all_cryptos_same_side = False
        all_cryptos_one_sided = False
        peers = concurrent.get((end_ms, interval), [])
        if peers:
            peer_rows = [rows_raw[i] for i in peers]
            peer_snap33s = [(crypto_from_slug(r["slug"]), closest_snap(r.get("snapshots") or [], 33))
                            for r in peer_rows]
            peer_sides = []
            peer_asks = []
            for c, s in peer_snap33s:
                if not s: continue
                sd = side_from_snap(s)
                if sd == "TIE": continue
                peer_sides.append(sd)
                peer_asks.append(leader_ask(s, sd) or 1.0)
            if len(peer_sides) == 4 and len(set(peer_sides)) == 1:
                all_cryptos_same_side = True
            if len(peer_asks) == 4 and all(a >= 0.85 for a in peer_asks):
                all_cryptos_favorite_85 = True
            if len(peer_asks) == 4 and all(a >= 0.95 for a in peer_asks):
                all_cryptos_one_sided = True

        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP")
                          if c != crypto and last_res.get(c) == side)

        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        late_flip = leader_240 not in (side, "TIE")
        leader_stable = leader_240 == side

        ask_depth = snap33.get("upAskDepth", 0) if side == "UP" else snap33.get("downAskDepth", 0)
        bid_depth = snap33.get("upBidDepth", 0) if side == "UP" else snap33.get("downBidDepth", 0)
        spread = snap33.get("upSpread") if side == "UP" else snap33.get("downSpread")
        if spread is None:
            spread = 1.0
        prev_match_fav = last_res.get(crypto) == side
        volume = row.get("volume") or 0

        tod = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc) if end_ms else None
        us_daytime = tod is not None and 13 <= tod.hour <= 22
        weekend = tod is not None and tod.weekday() >= 5

        f = {
            # Cross / prev
            "cross_agree_all": cross_match == 3,
            "cross_agree_2plus": cross_match >= 2,
            "prev_match_fav": prev_match_fav,

            # Stability / momentum
            "leader_stable_240s": leader_stable,
            "late_flip": late_flip,
            "bid_rising_33": bid_rising,

            # Volatility (calibrated)
            "lowvol_calibrated": bid_std is not None and bid_std <= bid_std_p25,
            "highvol_calibrated": bid_std is not None and bid_std >= bid_std_p75,

            # Structural
            "deep_bid_10k": bid_depth >= 10000,
            "deep_bid_30k": bid_depth >= 30000,
            "thin_ask_1k": 0 < ask_depth <= 1000,
            "book_tight_1c": spread <= 0.01,
            "book_tight_2c": spread <= 0.02,
            "wide_gap_15c": abs(up33 - dn33) >= 0.15,
            "wide_gap_30c": abs(up33 - dn33) >= 0.30,

            # Chainlink vol
            "cl_prev_calm": prev_cl_1 is not None and prev_cl_1 <= cl_thr[0],
            "cl_prev_violent": prev_cl_1 is not None and prev_cl_1 >= cl_thr[2],
            "cl_3candle_calm_avg": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[1] and len(prev_cls) == 3,
            "cl_3candle_violent_avg": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,

            # Inter-market regime
            "all_cryptos_favorite_85": all_cryptos_favorite_85,
            "all_cryptos_same_side": all_cryptos_same_side,
            "all_cryptos_one_sided": all_cryptos_one_sided,

            # Volume
            "volume_high": volume >= volume_p50,
            "volume_low": volume <= volume_p25 and volume > 0,

            # Context
            "us_daytime": us_daytime,
            "weekend": weekend,
            "interval_15m": interval == "15m",
            "interval_5m": interval == "5m",
        }
        won = side == resolution
        samples.append({"band": band, "ask": ask, "won": won, "features": f, "end_ms": end_ms})
        finalize()

    print(f"Total samples: {len(samples)}")
    print()

    # Single-filter screens in 85¢+
    print("=" * 95)
    print("Single filter — top 25 POSITIVE edges in 85¢+ (N ≥ 50)")
    print("=" * 95)
    all_filter_keys = sorted(samples[0]["features"].keys()) if samples else []
    hits = []
    for flt in all_filter_keys:
        for b in ("85-90", "90-93", "93-96", "96-99", "99+"):
            bs = [s for s in samples if s["band"] == b and s["features"].get(flt)]
            if len(bs) < 50:
                continue
            n = len(bs)
            wins = sum(1 for s in bs if s["won"])
            avg_ask = sum(s["ask"] for s in bs) / n
            pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
            be = breakeven_wr(avg_ask) * 100
            wr = wins / n * 100
            hits.append((wr - be, flt, b, n, wr, be, pnl))
    hits.sort(key=lambda x: -x[0])
    print(f"{'Filter':<26} {'Band':<8} {'N':>6} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'TotalPnL':>10}")
    for edge, flt, b, n, wr, be, pnl in hits[:25]:
        if edge <= 0: break
        print(f"{flt:<26} {b:<8} {n:>6} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+9.2f}")

    # Pair screens — focus on 85-90 and 90-93
    print()
    print("=" * 95)
    print("Two-filter AND — top 20, edge ≥ +3pp, N ≥ 50, 85¢+ bands")
    print("=" * 95)
    combo_hits = []
    for i, a in enumerate(all_filter_keys):
        for b_flt in all_filter_keys[i + 1:]:
            for band in ("85-90", "90-93", "93-96", "96-99"):
                bs = [s for s in samples if s["band"] == band
                      and s["features"].get(a) and s["features"].get(b_flt)]
                if len(bs) < 50:
                    continue
                n = len(bs)
                wins = sum(1 for s in bs if s["won"])
                avg_ask = sum(s["ask"] for s in bs) / n
                pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
                be = breakeven_wr(avg_ask) * 100
                wr = wins / n * 100
                combo_hits.append((wr - be, a, b_flt, band, n, wr, be, pnl))
    combo_hits.sort(key=lambda x: -x[0])
    print(f"{'A':<26} {'B':<26} {'Band':<7} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'PnL':>9}")
    shown = 0
    for edge, a, b, band, n, wr, be, pnl in combo_hits:
        if edge < 3.0: break
        print(f"{a:<26} {b:<26} {band:<7} {n:>5} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+8.2f}")
        shown += 1
        if shown >= 20: break

    # Train/test validation on top 10 pair strategies
    print()
    print("=" * 95)
    print("Train/Test (time-ordered 60/40) — top 10 pair strategies")
    print("=" * 95)
    sorted_samples = sorted(samples, key=lambda s: s["end_ms"] or 0)
    split_idx = int(len(sorted_samples) * 0.6)
    train = sorted_samples[:split_idx]
    test = sorted_samples[split_idx:]

    def eval_strategy(sample_set, a_flt, b_flt, band):
        bs = [s for s in sample_set if s["band"] == band and s["features"].get(a_flt) and s["features"].get(b_flt)]
        if not bs: return None
        n = len(bs)
        wins = sum(1 for s in bs if s["won"])
        avg_ask = sum(s["ask"] for s in bs) / n
        pnl = sum(simulate(s["ask"], s["won"]) for s in bs)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        return {"n": n, "wr": wr, "be": be, "edge": wr - be, "pnl": pnl, "per_tr": pnl / n}

    print(f"{'A':<26} {'B':<26} {'Band':<7} "
          f"{'TrN':>4} {'TrEdge':>7} {'Tr$/tr':>7}  "
          f"{'TeN':>4} {'TeEdge':>7} {'Te$/tr':>7}  Holds?")
    top_combos = [(a, b, band) for edge, a, b, band, *_ in combo_hits[:20] if edge >= 3.0]
    for a, b, band in top_combos[:15]:
        tr = eval_strategy(train, a, b, band)
        te = eval_strategy(test, a, b, band)
        if not tr or not te or tr["n"] < 20 or te["n"] < 15:
            continue
        holds = "✓" if te["edge"] > 0 and te["per_tr"] > 0 else "✗"
        print(f"{a:<26} {b:<26} {band:<7} "
              f"{tr['n']:>4} {tr['edge']:>+6.2f}pp {tr['per_tr']:>+6.3f}  "
              f"{te['n']:>4} {te['edge']:>+6.2f}pp {te['per_tr']:>+6.3f}  {holds}")


if __name__ == "__main__":
    main()
