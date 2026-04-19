#!/usr/bin/env python3
"""
High-WR strategy search v2 — adds volatility and structural features.

Builds on high-wr-strategy-search.py by adding:

Volatility (computed from snap history up to T-33, no lookahead):
  lowvol_60s         — leader's bid std dev ≤ 0.5¢ across T-90..T-33
  lowvol_120s        — leader's bid std dev ≤ 1.0¢ across T-150..T-33
  highvol_60s        — leader's bid std dev ≥ 2¢ across T-90..T-33
  no_jumps_60s       — no |Δbid| > 3¢ across T-90..T-33
  bid_rising_33      — leader bid at T-33 ≥ leader bid at T-60
  wide_gap_15c       — |upBid - downBid| ≥ 15¢ at T-33

Structural (from single snap at T-33):
  deep_bid_30k       — leader bid depth ≥ 30000 shares (heavy bid-side liquidity)
  thin_ask_1k        — leader ask depth ≤ 1000 shares (no taker supply)
  book_tight_1c      — leader spread ≤ 1¢
  implied_agrees_fav — impliedUpProb matches direction and strength

Usage:
  python3 src/scripts/crypto-5min/high-wr-v2-volatility.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import statistics
import sys
from collections import defaultdict
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


def compute_features(snap33, snap240, snaps_60_window, snaps_120_window, crypto, interval, last_res, market_end_ms):
    side = side_from_snap(snap33)
    bid33 = leader_bid(snap33, side) or 0
    up33 = snap33.get("upBid", 0) or 0
    dn33 = snap33.get("downBid", 0) or 0

    # Volatility on leader bid across window
    def vol_stats(window, side_tmp):
        if len(window) < 3:
            return None, None
        bids = [leader_bid(s, side_tmp) or 0 for s in window]
        try:
            return statistics.stdev(bids), max(bids) - min(bids)
        except Exception:
            return None, None

    std_60, range_60 = vol_stats(snaps_60_window, side)
    std_120, range_120 = vol_stats(snaps_120_window, side)

    # Jump detection (|delta| > 3¢ between consecutive snaps in window)
    def count_jumps(window, threshold, side_tmp):
        bids = [leader_bid(s, side_tmp) or 0 for s in window]
        jumps = 0
        for i in range(1, len(bids)):
            if abs(bids[i] - bids[i - 1]) > threshold:
                jumps += 1
        return jumps

    jumps_60 = count_jumps(snaps_60_window, 0.03, side)

    # Rising vs declining
    snap60 = closest_snap(snaps_60_window + snaps_120_window, 60) if snaps_60_window else None
    bid_at_60 = leader_bid(snap60, side) if snap60 else None
    bid_rising = bid33 > bid_at_60 if bid_at_60 is not None else False

    # Cross-crypto agreement
    cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP")
                      if c != crypto and last_res.get(c) == side)

    # Late flip
    leader_240 = side_from_snap(snap240) if snap240 else "TIE"
    late_flip = leader_240 not in (side, "TIE")
    leader_stable = leader_240 == side

    # Structural
    ask_depth = snap33.get("upAskDepth", 0) if side == "UP" else snap33.get("downAskDepth", 0)
    bid_depth = snap33.get("upBidDepth", 0) if side == "UP" else snap33.get("downBidDepth", 0)
    spread = snap33.get("upSpread") if side == "UP" else snap33.get("downSpread")
    if spread is None:
        spread = 1.0
    ask_val = leader_ask(snap33, side) or 1.0
    prev_match_fav = last_res.get(crypto) == side

    # Hour / weekend
    if market_end_ms:
        tod = datetime.fromtimestamp(market_end_ms / 1000, tz=timezone.utc)
        us_daytime = 13 <= tod.hour <= 22
        weekend = tod.weekday() >= 5
    else:
        us_daytime = False
        weekend = False

    features = {
        # Volatility
        "lowvol_60s": std_60 is not None and std_60 <= 0.005,
        "lowvol_120s": std_120 is not None and std_120 <= 0.01,
        "highvol_60s": std_60 is not None and std_60 >= 0.02,
        "no_jumps_60s": jumps_60 == 0 and len(snaps_60_window) >= 5,
        "bid_rising_33": bid_rising,
        "wide_gap_15c": abs(up33 - dn33) >= 0.15,
        "wide_gap_30c": abs(up33 - dn33) >= 0.30,

        # Structural
        "deep_bid_30k": bid_depth >= 30000,
        "deep_bid_10k": bid_depth >= 10000,
        "thin_ask_1k": ask_depth <= 1000 and ask_depth > 0,
        "book_tight_1c": spread <= 0.01,
        "book_tight_2c": spread <= 0.02,

        # Cross/prev (reused from v1)
        "cross_agree_all": cross_match == 3,
        "cross_agree_2plus": cross_match >= 2,
        "prev_match_fav": prev_match_fav,
        "late_flip": late_flip,
        "leader_stable_240s": leader_stable,

        # Context
        "us_daytime": us_daytime,
        "weekend": weekend,
        "interval_15m": interval == "15m",
        "interval_5m": interval == "5m",
    }
    return features, side, ask_val


def main() -> None:
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

    last_res = {}
    samples = []

    for row in rows_raw:
        slug = row["slug"]
        crypto = crypto_from_slug(slug)
        interval = interval_from_slug(slug)
        resolution = row["resolution"]
        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        snap240 = closest_snap(snaps, 240, tolerance=30)
        if not snap33:
            last_res[crypto] = resolution
            continue
        side = side_from_snap(snap33)
        if side == "TIE":
            last_res[crypto] = resolution
            continue
        ask = leader_ask(snap33, side)
        if ask is None or ask <= 0 or ask >= 1.0:
            last_res[crypto] = resolution
            continue
        band = band_of(ask)
        if band is None:
            last_res[crypto] = resolution
            continue

        snaps_60 = snaps_in_range(snaps, 33, 90)
        snaps_120 = snaps_in_range(snaps, 33, 150)

        features, _, _ = compute_features(snap33, snap240, snaps_60, snaps_120,
                                          crypto, interval, last_res, row.get("marketEnd"))

        won = side == resolution
        samples.append((band, ask, won, features))
        last_res[crypto] = resolution

    # Report per-band baseline
    print("=" * 90)
    print("Baseline (no filter) per high-price band")
    print("=" * 90)
    print(f"{'Band':<8} {'N':>6} {'AvgAsk':>7} {'WR':>7} {'Breakeven':>10} {'Edge':>8} {'$/tr':>7}")
    for b in ("75-80", "80-85", "85-90", "90-93", "93-96", "96-99", "99+"):
        bs = [s for s in samples if s[0] == b]
        if not bs: continue
        n = len(bs)
        wins = sum(1 for _, _, w, _ in bs if w)
        avg_ask = sum(a for _, a, _, _ in bs) / n
        pnl = sum(simulate(a, w) for _, a, w, _ in bs)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        print(f"{b:<8} {n:>6} {avg_ask * 100:>6.2f}¢ {wr:>6.2f}% {be:>9.2f}% {wr - be:>+7.2f}pp {pnl / n:>+6.3f}")

    print()
    print("=" * 90)
    print("Single filter — top 20 POSITIVE edges in 85¢+ bands (N ≥ 50)")
    print("=" * 90)
    filters = list(samples[0][3].keys()) if samples else []
    print(f"{'Filter':<22} {'Band':<8} {'N':>6} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7} {'TotalPnL':>10}")
    hits = []
    for flt in filters:
        for b in ("85-90", "90-93", "93-96", "96-99", "99+"):
            bs = [(a, w) for bb, a, w, f in samples if bb == b and f.get(flt)]
            if len(bs) < 50:
                continue
            n = len(bs)
            wins = sum(1 for _, w in bs if w)
            avg_ask = sum(a for a, _ in bs) / n
            pnl = sum(simulate(a, w) for a, w in bs)
            be = breakeven_wr(avg_ask) * 100
            wr = wins / n * 100
            hits.append((wr - be, flt, b, n, wr, be, pnl))
    hits.sort(key=lambda x: -x[0])
    for edge, flt, b, n, wr, be, pnl in hits[:20]:
        if edge <= 0:
            break
        print(f"{flt:<22} {b:<8} {n:>6} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+9.2f}")

    print()
    print("=" * 90)
    print("Two-filter AND combos — top 15 positive, N ≥ 50, edge ≥ +3pp")
    print("=" * 90)
    combo_hits = []
    for i, a_flt in enumerate(filters):
        for b_flt in filters[i + 1:]:
            for band in ("85-90", "90-93", "93-96", "96-99", "99+"):
                bs = [(a, w) for bb, a, w, f in samples if bb == band and f.get(a_flt) and f.get(b_flt)]
                if len(bs) < 50:
                    continue
                n = len(bs)
                wins = sum(1 for _, w in bs if w)
                avg_ask = sum(a for a, _ in bs) / n
                pnl = sum(simulate(a, w) for a, w in bs)
                be = breakeven_wr(avg_ask) * 100
                wr = wins / n * 100
                combo_hits.append((wr - be, a_flt, b_flt, band, n, wr, be, pnl))
    combo_hits.sort(key=lambda x: -x[0])
    print(f"{'A':<22} {'B':<22} {'Band':<8} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7}")
    shown = 0
    for edge, a, b, band, n, wr, be, pnl in combo_hits:
        if edge < 3.0:
            break
        print(f"{a:<22} {b:<22} {band:<8} {n:>5} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f}")
        shown += 1
        if shown >= 15:
            break

    print()
    print("=" * 90)
    print("Three-filter combos — top 10 positive, N ≥ 50, edge ≥ +3pp")
    print("=" * 90)
    tri_hits = []
    # Reduce search space to promising single filters
    promising = [h[1] for h in hits[:12]] if hits else []
    for i, a in enumerate(promising):
        for j, b in enumerate(promising[i + 1:], start=i + 1):
            for c in promising[j + 1:]:
                for band in ("85-90", "90-93"):
                    bs = [(ask, won) for bb, ask, won, f in samples
                          if bb == band and f.get(a) and f.get(b) and f.get(c)]
                    if len(bs) < 50:
                        continue
                    n = len(bs)
                    wins = sum(1 for _, w in bs if w)
                    avg_ask = sum(ask for ask, _ in bs) / n
                    pnl = sum(simulate(ask, won) for ask, won in bs)
                    be = breakeven_wr(avg_ask) * 100
                    wr = wins / n * 100
                    tri_hits.append((wr - be, a, b, c, band, n, wr, be, pnl))
    tri_hits.sort(key=lambda x: -x[0])
    print(f"{'A':<22} {'B':<22} {'C':<22} {'Band':<7} {'N':>5} {'WR':>7} {'Edge':>8} {'$/tr':>7}")
    for edge, a, b, c, band, n, wr, be, pnl in tri_hits[:10]:
        if edge < 3.0:
            break
        print(f"{a:<22} {b:<22} {c:<22} {band:<7} {n:>5} {wr:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f}")


if __name__ == "__main__":
    main()
