#!/usr/bin/env python3
"""
Feasibility checks for low-WR (underdog-buying) strategy BEFORE building the
strategy flag.

Checks:
  1. Ask depth distribution at the underdog side — can we actually fill?
  2. Effective fill simulation — walk the book and measure slippage
  3. T-33 → T-30 ask drift distribution at low prices
  4. Spread (ask - bid) distribution by band
  5. Fee impact recalculation at actual low prices
  6. Top/bottom cases — worst historical fills we'd have taken

All done on the 30-day collector data, filtered to cross_0 + underdog-buying
universe at 05-25c bands (the main deployment candidates).

Usage:
  python3 src/scripts/crypto-5min/low-wr-feasibility-check.py pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
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


def band_of(ask):
    if ask < 0.05: return None
    if ask < 0.10: return "05-10"
    if ask < 0.15: return "10-15"
    if ask < 0.20: return "15-20"
    if ask < 0.25: return "20-25"
    if ask < 0.30: return "25-30"
    return None


def pct(n, d):
    return 100 * n / d if d else 0


def p(lst, q):
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
            except:
                continue
            if row.get("resolution") not in ("UP", "DOWN"): continue
            if not interval_from_slug(row.get("slug", "")): continue
            if not crypto_from_slug(row.get("slug", "")): continue
            rows_raw.append(row)
    rows_raw.sort(key=lambda r: r.get("marketEnd") or 0)

    # Build cross_0 qualifying underdog samples with full book detail
    last_res = {}
    samples = []

    for row in rows_raw:
        crypto = crypto_from_slug(row["slug"])
        interval = interval_from_slug(row["slug"])
        resolution = row["resolution"]
        snaps = row.get("snapshots") or []
        snap33 = closest_snap(snaps, 33)
        snap30 = closest_snap(snaps, 30)

        def finalize():
            if interval == "5m":
                last_res[crypto] = resolution

        if not snap33 or not snap30: finalize(); continue
        leader_side = side_from_snap(snap33)
        if leader_side == "TIE": finalize(); continue

        underdog_side = other_side(leader_side)
        underdog_ask_33 = ask_for(snap33, underdog_side)
        underdog_bid_33 = bid_for(snap33, underdog_side) or 0
        underdog_ask_30 = ask_for(snap30, underdog_side)
        if underdog_ask_33 is None or underdog_ask_30 is None: finalize(); continue
        if underdog_ask_33 <= 0 or underdog_ask_33 >= 1.0: finalize(); continue

        band = band_of(underdog_ask_33)
        if band is None: finalize(); continue

        # cross_0 check
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == leader_side)
        if cross_match != 0: finalize(); continue

        # Collect book snapshots (schema doesn't have top-of-book list
        # but we have depth totals and the best bid/ask)
        underdog_ask_depth_33 = snap33.get("upAskDepth", 0) if underdog_side == "UP" else snap33.get("downAskDepth", 0)
        underdog_ask_depth_30 = snap30.get("upAskDepth", 0) if underdog_side == "UP" else snap30.get("downAskDepth", 0)
        underdog_spread = underdog_ask_33 - underdog_bid_33

        won = underdog_side == resolution

        samples.append({
            "band": band,
            "ask_33": underdog_ask_33,
            "ask_30": underdog_ask_30,
            "bid_33": underdog_bid_33,
            "spread": underdog_spread,
            "depth_33": underdog_ask_depth_33,
            "depth_30": underdog_ask_depth_30,
            "won": won,
            "slug": row["slug"],
        })
        finalize()

    print(f"cross_0 qualifying underdog samples (05-30¢ band): {len(samples)}")
    print()

    # =========================================================================
    # CHECK 1: Ask depth distribution — can we fill?
    # =========================================================================
    print("=" * 90)
    print("CHECK 1: Ask depth distribution (shares available at underdog's best ask)")
    print("=" * 90)
    print(f"{'Band':<8} {'N':>6} {'Shares needed':>14} {'p10':>6} {'p25':>6} {'p50':>6} {'p75':>6} {'p90':>6} {'Feasible %':>11}")
    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        depths = [s["depth_33"] for s in bs]
        avg_ask = sum(s["ask_33"] for s in bs) / len(bs)
        shares_needed = math.floor(TRADE_SIZE_USD / avg_ask)
        feasible = sum(1 for s in bs if s["depth_33"] >= math.floor(TRADE_SIZE_USD / s["ask_33"]))
        print(f"{band:<8} {len(bs):>6} {shares_needed:>14} "
              f"{p(depths, 0.10):>6.0f} {p(depths, 0.25):>6.0f} {p(depths, 0.50):>6.0f} "
              f"{p(depths, 0.75):>6.0f} {p(depths, 0.90):>6.0f} {pct(feasible, len(bs)):>10.1f}%")
    print()

    # =========================================================================
    # CHECK 2: T-33 → T-30 ask drift
    # =========================================================================
    print("=" * 90)
    print("CHECK 2: T-33 → T-30 ask drift (how much the ask moves before we could fill)")
    print("=" * 90)
    print(f"{'Band':<8} {'N':>6} {'Avg drift':>10} {'p50':>6} {'p90':>7} {'p95':>7} {'p99':>7} {'Max':>7}")
    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        drifts = [s["ask_30"] - s["ask_33"] for s in bs]
        avg = sum(drifts) / len(drifts)
        drifts_abs = [abs(d) for d in drifts]
        print(f"{band:<8} {len(bs):>6} {avg * 100:>+9.2f}¢ {p(drifts, 0.50) * 100:>+5.2f}¢ "
              f"{p(drifts, 0.90) * 100:>+6.2f}¢ {p(drifts, 0.95) * 100:>+6.2f}¢ "
              f"{p(drifts, 0.99) * 100:>+6.2f}¢ {max(drifts) * 100:>+6.2f}¢")
    print()

    # =========================================================================
    # CHECK 3: Spread analysis (bid-ask at underdog side)
    # =========================================================================
    print("=" * 90)
    print("CHECK 3: Underdog-side spread (ask - bid at the side we're buying)")
    print("=" * 90)
    print(f"{'Band':<8} {'N':>6} {'AvgAsk':>7} {'AvgBid':>7} {'p25 spread':>11} {'p50 spread':>11} {'p90 spread':>11}")
    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        asks = [s["ask_33"] for s in bs]
        bids = [s["bid_33"] for s in bs]
        spreads = [s["spread"] for s in bs]
        print(f"{band:<8} {len(bs):>6} {sum(asks) / len(asks) * 100:>6.2f}¢ "
              f"{sum(bids) / len(bids) * 100:>6.2f}¢ "
              f"{p(spreads, 0.25) * 100:>10.2f}¢ {p(spreads, 0.50) * 100:>10.2f}¢ {p(spreads, 0.90) * 100:>10.2f}¢")
    print()

    # =========================================================================
    # CHECK 4: Effective fill simulation with adverse selection
    # =========================================================================
    print("=" * 90)
    print("CHECK 4: Effective fill simulation (pay T-30 ask, not T-33 ask)")
    print("=" * 90)
    print("If we decide at T-33 but fill at T-30, we pay the T-30 ask. Compare that")
    print("against what a 'zero-drift' assumption says ($/tr with T-33 ask as fill).")
    print()
    print(f"{'Band':<8} {'N':>6} {'T33 $/tr':>9} {'T30 $/tr':>9} {'Drift cost':>11} {'T30 Edge vs BE':>14}")

    def edge(ask, won):
        shares = TRADE_SIZE_USD / ask
        if won: return shares * (1 - ask) * (1 - WINNER_FEE_PCT)
        return -shares * ask

    def be(ask):
        wp = (1 - ask) * (1 - WINNER_FEE_PCT)
        return ask / (wp + ask)

    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        # Fill as if T-33 ask (ideal)
        pnl_ideal = sum(edge(s["ask_33"], s["won"]) for s in bs)
        # Fill at T-30 ask (realistic) — but only if T-30 ask is still in low-band
        pnl_real = 0.0
        n_filled = 0
        n_aborted = 0
        for s in bs:
            if s["ask_30"] > 0.30:  # abort if T-30 ask crossed out of low zone
                n_aborted += 1
                continue
            pnl_real += edge(s["ask_30"], s["won"])
            n_filled += 1
        drift_cost = pnl_real - pnl_ideal if n_filled else 0
        wins = sum(1 for s in bs if s["won"] and s["ask_30"] <= 0.30)
        avg_fill = sum(s["ask_30"] for s in bs if s["ask_30"] <= 0.30) / max(n_filled, 1)
        wr = pct(wins, n_filled) if n_filled else 0
        edge_vs_be = wr - be(avg_fill) * 100 if n_filled else 0
        print(f"{band:<8} {len(bs):>6} {pnl_ideal / len(bs):>+8.3f} "
              f"{pnl_real / max(n_filled, 1):>+8.3f} "
              f"{(pnl_real / max(n_filled, 1)) - (pnl_ideal / len(bs)):>+10.3f} "
              f"{edge_vs_be:>+12.2f}pp  (aborted {n_aborted})")
    print()

    # =========================================================================
    # CHECK 5: Pre-fill slippage gate simulation
    # =========================================================================
    print("=" * 90)
    print("CHECK 5: Pre-fill slippage gate simulation")
    print("=" * 90)
    print("What happens if we add a 'abort if T-30 ask > T-33 ask + X¢' gate?")
    print()
    for max_slip_c in (0.3, 0.5, 1.0, 2.0):
        print(f"Slippage cap = {max_slip_c:.1f}¢:")
        print(f"  {'Band':<8} {'N fired':>8} {'aborts':>7} {'WR':>6} {'$/tr':>7} {'edge vs BE':>12}")
        for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
            bs = [s for s in samples if s["band"] == band]
            if not bs: continue
            fired = []
            aborts = 0
            for s in bs:
                if (s["ask_30"] - s["ask_33"]) * 100 > max_slip_c:
                    aborts += 1
                    continue
                fired.append(s)
            if not fired: continue
            n = len(fired)
            wins = sum(1 for s in fired if s["won"])
            pnl = sum(edge(s["ask_30"], s["won"]) for s in fired)
            avg_ask = sum(s["ask_30"] for s in fired) / n
            wr = pct(wins, n)
            edge_pp = wr - be(avg_ask) * 100
            print(f"  {band:<8} {n:>8} {aborts:>7} {wr:>5.2f}% {pnl / n:>+6.3f} {edge_pp:>+11.2f}pp")
        print()

    # =========================================================================
    # CHECK 6: Depth-capped fill (walk the book)
    # =========================================================================
    print("=" * 90)
    print("CHECK 6: Depth-capped fill — what if depth < shares_needed?")
    print("=" * 90)
    print("If the book has less than shares_needed at best ask, we'd walk the book")
    print("(fill some at ask, more at ask + 1¢, etc). Collector schema only gives")
    print("total-ask-depth not per-level depth, so this is an approximation.")
    print()
    print(f"{'Band':<8} {'N':>6} {'Always feasible':>17} {'Always fillable w/$5 slip':>26} {'Depth-cap rate':>16}")
    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        feasible = 0  # depth at ask >= shares_needed
        fillable_partial = 0  # depth >= 50% of shares needed
        for s in bs:
            shares_needed = math.floor(TRADE_SIZE_USD / s["ask_33"])
            if s["depth_33"] >= shares_needed:
                feasible += 1
                fillable_partial += 1
            elif s["depth_33"] >= shares_needed * 0.5:
                fillable_partial += 1
        print(f"{band:<8} {len(bs):>6} {pct(feasible, len(bs)):>15.1f}% "
              f"{pct(fillable_partial, len(bs)):>25.1f}% "
              f"{100 - pct(feasible, len(bs)):>14.1f}%")
    print()

    # =========================================================================
    # CHECK 7: Fee impact double-check
    # =========================================================================
    print("=" * 90)
    print("CHECK 7: Fee impact at low prices (7% on winnings)")
    print("=" * 90)
    print("At 5¢ fill, a $5 stake = 100 shares. Win payout = 100 × $0.95 = $95. Fee = $6.65.")
    print("At 20¢ fill, $5 stake = 25 shares. Win payout = $20. Fee = $1.40.")
    print()
    print(f"{'Band':<8} {'AvgAsk':>7} {'Shares':>7} {'Gross win':>10} {'Fee':>7} {'Net win':>9} {'Loss':>7}")
    for band in ("05-10", "10-15", "15-20", "20-25", "25-30"):
        bs = [s for s in samples if s["band"] == band]
        if not bs: continue
        avg_ask = sum(s["ask_33"] for s in bs) / len(bs)
        shares = math.floor(TRADE_SIZE_USD / avg_ask)
        gross_win = shares * (1 - avg_ask)
        fee = gross_win * WINNER_FEE_PCT
        net_win = gross_win - fee
        loss = shares * avg_ask
        print(f"{band:<8} {avg_ask * 100:>6.2f}¢ {shares:>7} ${gross_win:>8.2f} ${fee:>5.2f} "
              f"${net_win:>7.2f} ${loss:>5.2f}")


if __name__ == "__main__":
    main()
