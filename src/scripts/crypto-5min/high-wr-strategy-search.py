#!/usr/bin/env python3
"""
High-WR strategy search.

Goal: find filter conditions on high-price (85¢+) markets where empirical WR
systematically beats the breakeven that the ask implies.

For each market at T-33 snapshot, compute a battery of candidate stabilizer
features and check whether conditioning on each (or combinations) produces
edge in the high-price bands where the base rate is already a losing bet.

Features tested:
  leader_stable_240s   — leader at T-33 == leader at T-240 (no flip observed)
  cross_agree_2plus    — ≥2 other cryptos' last resolutions match this leader
  cross_agree_all      — all 3 other cryptos' prev resolutions match leader
  prev_match_fav       — this crypto's prev resolution matches current leader
  spread_tight_1c      — ask - bid ≤ 1¢
  depth_strong_2x      — bid_depth / ask_depth ≥ 2.0
  us_daytime           — UTC hour in 13-22 (US market-hours)
  weekend              — Sat/Sun UTC
  late_flip            — leader at T-240 != leader at T-33

And combinations of the promising ones.

Usage:
  python3 src/scripts/crypto-5min/high-wr-strategy-search.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE_USD = 5.0
WINNER_FEE_PCT = 0.07


def interval_from_slug(slug: str) -> str | None:
    for part in slug.split("-"):
        if part in ("5m", "15m"):
            return part
    return None


def crypto_from_slug(slug: str) -> str | None:
    prefix = slug.split("-", 1)[0].upper()
    return prefix if prefix in ("BTC", "ETH", "SOL", "XRP") else None


def side_from_snap(snap: dict) -> str:
    up = snap.get("upBid", 0) or 0
    dn = snap.get("downBid", 0) or 0
    if up > dn:
        return "UP"
    if dn > up:
        return "DOWN"
    return "TIE"


def leader_ask(snap: dict, side: str) -> float | None:
    if side == "UP":
        return snap.get("upAsk")
    if side == "DOWN":
        return snap.get("downAsk")
    return None


def closest_snap(snaps: list[dict], target_sec: int, tolerance: int = 8) -> dict | None:
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not candidates:
        return None
    best = min(candidates, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))
    if abs(best.get("secondsBeforeEnd", 0) - target_sec) > tolerance:
        return None
    return best


def simulate(ask: float, won: bool) -> float:
    if ask <= 0 or ask >= 1.0:
        return 0.0
    shares = TRADE_SIZE_USD / ask
    if won:
        return shares * (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return -shares * ask


def breakeven_wr(ask: float) -> float:
    win_payout = (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return ask / (win_payout + ask)


def band_of(ask: float) -> str | None:
    if ask < 0.75: return None
    if ask < 0.80: return "75-80"
    if ask < 0.85: return "80-85"
    if ask < 0.90: return "85-90"
    if ask < 0.93: return "90-93"
    if ask < 0.96: return "93-96"
    if ask < 0.99: return "96-99"
    return "99+"


def ts_from_ms(ms):
    if not ms:
        return None
    try:
        return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
    except Exception:
        return None


def main() -> None:
    # Load per-crypto prev resolution tracker in time order
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

    last_res: dict[str, str] = {}
    samples = []  # each sample = (band, ask, won, features_dict)

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

        up33 = snap33.get("upBid", 0) or 0
        dn33 = snap33.get("downBid", 0) or 0
        bid33 = up33 if side == "UP" else dn33
        ask_size = snap33.get("upAsk", 1) - up33 if side == "UP" else snap33.get("downAsk", 1) - dn33
        spread = ask - bid33 if ask and bid33 else 1.0

        leader_stable_240 = False
        late_flip = False
        if snap240:
            leader_240 = side_from_snap(snap240)
            leader_stable_240 = leader_240 == side
            late_flip = leader_240 != side and leader_240 != "TIE"

        cross_match = sum(
            1 for c in ("BTC", "ETH", "SOL", "XRP")
            if c != crypto and last_res.get(c) == side
        )
        cross_agree_2plus = cross_match >= 2
        cross_agree_all = cross_match == 3
        prev_match_fav = last_res.get(crypto) == side
        spread_tight_1c = spread <= 0.01
        up_depth = snap33.get("upAskDepth", 0) or 0
        down_depth = snap33.get("downAskDepth", 0) or 0
        up_bd = snap33.get("upBidDepth", 0) or 0
        down_bd = snap33.get("downBidDepth", 0) or 0
        ask_depth = up_depth if side == "UP" else down_depth
        bid_depth = up_bd if side == "UP" else down_bd
        depth_strong_2x = ask_depth > 0 and (bid_depth / ask_depth) >= 2.0

        tod = ts_from_ms(row.get("marketEnd"))
        us_daytime = 13 <= tod.hour <= 22 if tod else False
        weekend = tod.weekday() >= 5 if tod else False

        won = side == resolution

        features = {
            "leader_stable_240s": leader_stable_240,
            "cross_agree_2plus": cross_agree_2plus,
            "cross_agree_all": cross_agree_all,
            "prev_match_fav": prev_match_fav,
            "spread_tight_1c": spread_tight_1c,
            "depth_strong_2x": depth_strong_2x,
            "us_daytime": us_daytime,
            "weekend": weekend,
            "late_flip": late_flip,
            "interval_15m": interval == "15m",
            "interval_5m": interval == "5m",
        }
        samples.append((band, ask, won, features))
        last_res[crypto] = resolution

    # Report per-band baseline
    print("=" * 85)
    print("Baseline (no filter) per band")
    print("=" * 85)
    print(f"{'Band':<8} {'N':>6} {'AvgAsk':>7} {'WR':>7} {'Breakeven':>10} {'Edge':>8} {'$/tr':>7}")
    bands = ["75-80", "80-85", "85-90", "90-93", "93-96", "96-99", "99+"]
    for b in bands:
        band_samples = [s for s in samples if s[0] == b]
        if not band_samples:
            continue
        n = len(band_samples)
        wins = sum(1 for _, _, won, _ in band_samples if won)
        avg_ask = sum(a for _, a, _, _ in band_samples) / n
        pnl = sum(simulate(a, w) for _, a, w, _ in band_samples)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        print(f"{b:<8} {n:>6} {avg_ask * 100:>6.2f}¢ {wr:>6.2f}% {be:>9.2f}% {wr - be:>+7.2f}pp {pnl / n:>+6.3f}")

    print()
    print("=" * 85)
    print("Single-filter screens — POSITIVE edge in high-price bands (85¢+)")
    print("=" * 85)
    filters = [
        "leader_stable_240s", "late_flip", "cross_agree_2plus", "cross_agree_all",
        "prev_match_fav", "spread_tight_1c", "depth_strong_2x", "us_daytime",
        "weekend", "interval_15m", "interval_5m",
    ]

    print(f"{'Filter':<22} {'Band':<8} {'N':>6} {'AvgAsk':>7} {'WR':>7} {'Breakeven':>10} {'Edge':>8} {'$/tr':>7} {'TotalPnL':>10}")
    print("-" * 95)
    hits = []
    for flt in filters:
        for b in ("85-90", "90-93", "93-96", "96-99", "99+"):
            band_samples = [(a, w) for bb, a, w, f in samples if bb == b and f.get(flt)]
            if len(band_samples) < 30:
                continue
            n = len(band_samples)
            wins = sum(1 for _, w in band_samples if w)
            avg_ask = sum(a for a, _ in band_samples) / n
            pnl = sum(simulate(a, w) for a, w in band_samples)
            be = breakeven_wr(avg_ask) * 100
            wr = wins / n * 100
            edge = wr - be
            hits.append((edge, flt, b, n, avg_ask, wr, be, pnl))
    hits.sort(key=lambda x: -x[0])
    for edge, flt, b, n, avg_ask, wr, be, pnl in hits[:20]:
        print(f"{flt:<22} {b:<8} {n:>6} {avg_ask * 100:>6.2f}¢ {wr:>6.2f}% {be:>9.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f} {pnl:>+9.2f}")

    print()
    print("=" * 85)
    print("Two-filter AND combinations in high-price bands (top positive edges)")
    print("=" * 85)
    combo_hits = []
    for i, a_flt in enumerate(filters):
        for b_flt in filters[i + 1:]:
            if a_flt == b_flt:
                continue
            for band in ("85-90", "90-93", "93-96", "96-99", "99+"):
                band_samples = [(a, w) for bb, a, w, f in samples if bb == band and f.get(a_flt) and f.get(b_flt)]
                if len(band_samples) < 30:
                    continue
                n = len(band_samples)
                wins = sum(1 for _, w in band_samples if w)
                avg_ask = sum(a for a, _ in band_samples) / n
                pnl = sum(simulate(a, w) for a, w in band_samples)
                be = breakeven_wr(avg_ask) * 100
                wr = wins / n * 100
                edge = wr - be
                combo_hits.append((edge, a_flt, b_flt, band, n, avg_ask, wr, be, pnl))
    combo_hits.sort(key=lambda x: -x[0])
    print(f"{'Filter A':<22} {'Filter B':<22} {'Band':<8} {'N':>5} {'WR':>7} {'BE':>7} {'Edge':>8} {'$/tr':>7}")
    print("-" * 95)
    for edge, a, b, band, n, avg_ask, wr, be, pnl in combo_hits[:15]:
        if edge <= 0:
            break
        print(f"{a:<22} {b:<22} {band:<8} {n:>5} {wr:>6.2f}% {be:>6.2f}% {edge:>+7.2f}pp {pnl / n:>+6.3f}")

    total_hits = sum(1 for h in hits if h[0] > 0)
    total_combo_hits = sum(1 for h in combo_hits if h[0] > 0)
    print()
    print(f"Single filters with positive edge in 85¢+ bands: {total_hits} / {len(hits)}")
    print(f"Two-filter combos with positive edge in 85¢+ bands: {total_combo_hits} / {len(combo_hits)}")


if __name__ == "__main__":
    main()
