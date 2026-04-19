#!/usr/bin/env python3
"""
Pre-fill verify net-impact analysis.

Answers two questions:
  1. Does waiting 1.5s (T-33 decide → T-28 fill instead of T-30 fill) degrade
     the entry price enough to hurt the edge?
  2. Do flip aborts save more than the 1.5s fill-delay costs us?

Process per market (collector history, candidate-universe):
  - Snap at T-33 (decision): record leader side, ask
  - Snap at T-31 (pre-fill re-verify): is leader unchanged?
  - Snap at T-28 (new fill point): if we'd have fired here, what ask would we get?
  - Snap at T-30 (old fill point, baseline): what ask *would* we have paid previously?
  - Track per-trade P&L under three scenarios:
      (a) Old bot: always fire, T-30 fill ask
      (b) New bot: abort if flipped at T-31, otherwise T-28 fill ask
      (c) New bot if we'd kept T-30 fill (hypothetical no slippage from verify)

Usage:
  python3 src/scripts/crypto-5min/pre-fill-verify-impact.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import json
import sys
from collections import defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
DECISION_SEC = 33
VERIFY_SEC = 31
FILL_SEC_OLD = 30
FILL_SEC_NEW = 28
TRADE_SIZE_USD = 5.0


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


def side_ask(snap: dict, side: str) -> float | None:
    if side == "UP":
        return snap.get("upAsk") or 1.0
    if side == "DOWN":
        return snap.get("downAsk") or 1.0
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
    """PnL for a $TRADE_SIZE_USD buy at this ask."""
    if ask <= 0 or ask > 0.99:
        return 0.0
    shares = TRADE_SIZE_USD / ask
    if side == resolution:
        return shares * (1.0 - ask)
    return -shares * ask


def fmt(x: float) -> str:
    sign = "+" if x >= 0 else "-"
    return f"{sign}${abs(x):.2f}"


def pct(a: int, b: int) -> float:
    return 100 * a / b if b else 0.0


def main() -> None:
    old_trades = 0
    old_pnl = 0.0
    old_wins = 0

    new_trades = 0
    new_pnl = 0.0
    new_wins = 0
    new_aborts = 0

    hypo_trades = 0  # new filter (abort flips) but use T-30 fill ask instead of T-28
    hypo_pnl = 0.0

    ask_degradation_samples = []  # T-28 ask − T-30 ask (per trade, same-side only)

    with open(PATH, "r") as handle:
        for line in handle:
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
            snap31 = closest_snap(snaps, VERIFY_SEC)
            snap30 = closest_snap(snaps, FILL_SEC_OLD)
            snap28 = closest_snap(snaps, FILL_SEC_NEW)
            if not (snap33 and snap31 and snap30 and snap28):
                continue

            side33 = side_from_snap(snap33)
            if side33 == "TIE":
                continue
            ask33 = side_ask(snap33, side33)
            if ask33 is None or not (0.54 <= ask33 <= 0.75):
                continue

            side31 = side_from_snap(snap31)
            flipped = side31 != side33

            # (a) Old bot: always fire, T-30 ask for decided side
            ask_old_fill = side_ask(snap30, side33) or 1.0
            if ask_old_fill <= 0.75:
                pnl_old = simulate(ask_old_fill, side33, resolution)
                old_pnl += pnl_old
                old_trades += 1
                if pnl_old > 0:
                    old_wins += 1

            # (b) New bot: abort if flipped, else T-28 ask for decided side
            if flipped:
                new_aborts += 1
            else:
                ask_new_fill = side_ask(snap28, side33) or 1.0
                if ask_new_fill <= 0.75:
                    pnl_new = simulate(ask_new_fill, side33, resolution)
                    new_pnl += pnl_new
                    new_trades += 1
                    if pnl_new > 0:
                        new_wins += 1
                    ask_degradation_samples.append(ask_new_fill - ask_old_fill)

                    # (c) Hypothetical: new filter + old fill timing
                    if ask_old_fill <= 0.75:
                        pnl_hypo = simulate(ask_old_fill, side33, resolution)
                        hypo_pnl += pnl_hypo
                        hypo_trades += 1

    degrad_mean = sum(ask_degradation_samples) / len(ask_degradation_samples) if ask_degradation_samples else 0.0
    degrad_abs = [abs(x) for x in ask_degradation_samples]
    degrad_p50 = sorted(ask_degradation_samples)[len(ask_degradation_samples) // 2] if ask_degradation_samples else 0.0
    degrad_p90 = sorted(ask_degradation_samples)[int(len(ask_degradation_samples) * 0.9)] if ask_degradation_samples else 0.0

    print("=" * 70)
    print("Edge degradation from 1.5s fill delay (T-30 → T-28)")
    print("=" * 70)
    print(f"  Samples (non-flipped trades): {len(ask_degradation_samples)}")
    print(f"  Avg ask move T-30 → T-28:     {degrad_mean * 100:+.3f}¢  (+ means paid more)")
    print(f"  Median:                        {degrad_p50 * 100:+.3f}¢")
    print(f"  p90:                           {degrad_p90 * 100:+.3f}¢")
    print()

    print("=" * 70)
    print("Strategy P&L comparison (historical candidate universe)")
    print("=" * 70)
    print(f"  {'Scenario':<35} {'N':>6} {'Wins':>6} {'WR':>7} {'Total PnL':>12} {'$/trade':>9}")
    print(f"  {'(a) Old: always fire @ T-30':<35} {old_trades:>6} {old_wins:>6} "
          f"{pct(old_wins, old_trades):>6.2f}% {fmt(old_pnl):>12} "
          f"{fmt(old_pnl / old_trades) if old_trades else 'n/a':>9}")
    print(f"  {'(b) New: abort + fill @ T-28':<35} {new_trades:>6} {new_wins:>6} "
          f"{pct(new_wins, new_trades):>6.2f}% {fmt(new_pnl):>12} "
          f"{fmt(new_pnl / new_trades) if new_trades else 'n/a':>9}")
    print(f"  {'(c) New filter + T-30 fill':<35} {hypo_trades:>6} {'':>6} "
          f"{'':>7} {fmt(hypo_pnl):>12} "
          f"{fmt(hypo_pnl / hypo_trades) if hypo_trades else 'n/a':>9}")
    print()
    print(f"  Aborts saved: {new_aborts} trades would have been flip losses under (a)")
    print()
    print("=" * 70)
    print("Decomposition: what did pre-fill verify actually buy us?")
    print("=" * 70)
    benefit_from_aborts = hypo_pnl - old_pnl
    cost_from_delay = new_pnl - hypo_pnl
    net = new_pnl - old_pnl
    print(f"  Benefit from aborting flips   (c − a): {fmt(benefit_from_aborts)}")
    print(f"  Cost of 1.5s fill delay       (b − c): {fmt(cost_from_delay)}")
    print(f"  Net effect of pre-fill verify (b − a): {fmt(net)}")
    print()
    if old_trades:
        print(f"  Per-trade comparison:")
        print(f"    Old:  {fmt(old_pnl / old_trades)} / trade")
        print(f"    New:  {fmt(new_pnl / new_trades)} / trade")
        delta_per_new_trade = (new_pnl / new_trades) - (old_pnl / old_trades) if new_trades else 0
        print(f"    Δ:    {fmt(delta_per_new_trade)} / trade")


if __name__ == "__main__":
    main()
