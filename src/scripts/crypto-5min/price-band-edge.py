#!/usr/bin/env python3
"""
Is there edge at higher price bands (high WR strategies)?

Replay every T-33 leader across all price bands (no filter beyond leader side
at T-33 existing). Compute:
  - Empirical WR
  - Implied breakeven WR (ask + 7% fee tax on wins)
  - Per-trade PnL at $5 stake with 7% winner fee
  - Edge margin (actual WR − breakeven WR)

Usage:
  python3 src/scripts/crypto-5min/price-band-edge.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

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


def closest_snap(snaps: list[dict], target_sec: int, tolerance: int = 5) -> dict | None:
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not candidates:
        return None
    best = min(candidates, key=lambda s: abs(s["secondsBeforeEnd"] - target_sec))
    if abs(best.get("secondsBeforeEnd", 0) - target_sec) > tolerance:
        return None
    return best


def simulate(ask: float, side: str, resolution: str) -> float:
    if ask <= 0 or ask >= 1.0:
        return 0.0
    shares = TRADE_SIZE_USD / ask
    if side == resolution:
        gross = shares * (1.0 - ask)
        return gross * (1.0 - WINNER_FEE_PCT)
    return -shares * ask


def band_of(ask: float) -> str:
    if ask < 0.55:
        return "<55"
    elif ask < 0.60:
        return "55-60"
    elif ask < 0.65:
        return "60-65"
    elif ask < 0.70:
        return "65-70"
    elif ask < 0.75:
        return "70-75"
    elif ask < 0.80:
        return "75-80"
    elif ask < 0.85:
        return "80-85"
    elif ask < 0.90:
        return "85-90"
    elif ask < 0.93:
        return "90-93"
    elif ask < 0.96:
        return "93-96"
    elif ask < 0.99:
        return "96-99"
    else:
        return "99+"


def breakeven_wr(ask: float) -> float:
    """WR needed to break even at given ask, accounting for 7% winner fee."""
    # p * shares * (1-ask) * (1-fee) = (1-p) * shares * ask
    # p * (1-ask) * (1-fee) = (1-p) * ask
    # p * ((1-ask)*(1-fee) + ask) = ask
    win_payout = (1.0 - ask) * (1.0 - WINNER_FEE_PCT)
    return ask / (win_payout + ask)


def main() -> None:
    stats = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0, "ask_sum": 0.0})

    with open(PATH, "r") as handle:
        for line in handle:
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            slug = row.get("slug", "")
            if not interval_from_slug(slug) or not crypto_from_slug(slug):
                continue
            resolution = row.get("resolution")
            if resolution not in ("UP", "DOWN"):
                continue
            snaps = row.get("snapshots") or []
            snap33 = closest_snap(snaps, 33)
            if not snap33:
                continue
            side = side_from_snap(snap33)
            if side == "TIE":
                continue
            ask = leader_ask(snap33, side)
            if ask is None or ask <= 0 or ask >= 1.0:
                continue
            band = band_of(ask)
            pnl = simulate(ask, side, resolution)
            stats[band]["n"] += 1
            stats[band]["ask_sum"] += ask
            if side == resolution:
                stats[band]["wins"] += 1
            stats[band]["pnl"] += pnl

    print(f"{'Band':<8} {'N':>6} {'AvgAsk':>7} {'WR':>7} {'Breakeven':>10} {'EdgeMargin':>11} {'TotalPnL':>10} {'$/trade':>8}")
    print("-" * 75)
    band_order = ["<55", "55-60", "60-65", "65-70", "70-75", "75-80", "80-85",
                  "85-90", "90-93", "93-96", "96-99", "99+"]
    grand_total = 0.0
    grand_n = 0
    for band in band_order:
        s = stats.get(band)
        if not s or s["n"] == 0:
            continue
        n = s["n"]
        wr = 100 * s["wins"] / n
        avg_ask = s["ask_sum"] / n
        be = 100 * breakeven_wr(avg_ask)
        edge = wr - be
        pnl = s["pnl"]
        per_trade = pnl / n
        grand_total += pnl
        grand_n += n
        print(f"{band:<8} {n:>6} {avg_ask * 100:>6.2f}¢ {wr:>6.2f}% {be:>9.2f}% {edge:>+10.2f}pp {pnl:>+9.2f} {per_trade:>+7.3f}")

    print("-" * 75)
    print(f"{'TOTAL':<8} {grand_n:>6} {'':>7} {'':>7} {'':>10} {'':>11} {grand_total:>+9.2f} {grand_total / grand_n if grand_n else 0:>+7.3f}")
    print()
    print("Interpretation:")
    print("  EdgeMargin > 0 → profitable band (actual WR beats what the ask implies)")
    print("  Fee: 7% taken from winning payout only (losses pay no fee)")


if __name__ == "__main__":
    main()
