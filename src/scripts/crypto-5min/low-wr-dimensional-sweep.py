#!/usr/bin/env python3
"""
Final dimensional sweep before deploying low-wr. Can we do better than
cross_0 @ 05-20c as a deployment target?

Tests:
  D1. Per-crypto breakdown — are some cryptos' underdogs more profitable?
  D2. Interval breakdown — 5m vs 15m at each band
  D3. Finer price-band granularity — 05-08, 08-11, 11-14, ...
  D4. Time-of-day — is there a best window?
  D5. Cross_0 + additional features we haven't fully tested
  D6. Implied-prob drift — leader strengthening vs weakening matters?
  D7. Depth imbalance — leader-ask-depth vs underdog-ask-depth

Usage:
  python3 src/scripts/crypto-5min/low-wr-dimensional-sweep.py pricing-data.jsonl
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
    return s[min(len(s) - 1, max(0, int(len(s) * q)))]


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

    all_volumes = [r.get("volume") for r in rows_raw if r.get("volume") is not None]
    volume_p25 = quantile(all_volumes, 0.25)
    volume_p50 = quantile(all_volumes, 0.50)

    all_cl_moves = {}
    for row in rows_raw:
        c = crypto_from_slug(row["slug"])
        iv = interval_from_slug(row["slug"])
        cm = row.get("chainlinkMoveDollars")
        if cm is not None:
            all_cl_moves.setdefault((c, iv), []).append(abs(cm))
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

        # Only cross_0 for this sweep
        cross_match = sum(1 for c in ("BTC", "ETH", "SOL", "XRP") if c != crypto and last_res.get(c) == leader_side)
        if cross_match != 0: finalize(); continue

        underdog_side = other_side(leader_side)
        underdog_ask = ask_for(snap33, underdog_side)
        underdog_bid = bid_for(snap33, underdog_side) or 0
        if underdog_ask is None or underdog_ask <= 0.02 or underdog_ask >= 0.30: finalize(); continue

        underdog_ask_depth = snap33.get("upAskDepth", 0) if underdog_side == "UP" else snap33.get("downAskDepth", 0)
        leader_ask_depth = snap33.get("upAskDepth", 0) if leader_side == "UP" else snap33.get("downAskDepth", 0)
        shares_needed = math.floor(TRADE_SIZE_USD / underdog_ask)
        if shares_needed < 1 or underdog_ask_depth < shares_needed: finalize(); continue

        leader_240 = side_from_snap(snap240) if snap240 else "TIE"
        leader_bid_33 = bid_for(snap33, leader_side) or 0
        leader_bid_240 = bid_for(snap240, leader_side) if snap240 else None
        leader_strengthening = leader_bid_240 is not None and leader_bid_33 > leader_bid_240

        prev_cls = list(last_cl_moves[(crypto, interval)])
        cl_thr = cl_thresholds.get((crypto, interval), (0, 0, 0))
        prev_cl_3_avg = sum(prev_cls) / len(prev_cls) if prev_cls else None
        volume = row.get("volume") or 0

        tod = datetime.fromtimestamp(end_ms / 1000, tz=timezone.utc) if end_ms else None
        hour_bucket = tod.hour if tod else -1

        depth_ratio = leader_ask_depth / underdog_ask_depth if underdog_ask_depth > 0 else None

        won = underdog_side == resolution
        samples.append({
            "crypto": crypto, "interval": interval,
            "underdog_ask": underdog_ask,
            "won": won,
            "leader_strengthening": leader_strengthening,
            "leader_just_flipped": leader_240 not in (leader_side, "TIE"),
            "hour": hour_bucket,
            "cl_3c_calm": prev_cl_3_avg is not None and prev_cl_3_avg <= cl_thr[0] and len(prev_cls) == 3,
            "cl_3c_violent": prev_cl_3_avg is not None and prev_cl_3_avg >= cl_thr[2] and len(prev_cls) == 3,
            "volume_high": volume >= volume_p50,
            "volume_low": 0 < volume <= volume_p25,
            "depth_ratio": depth_ratio,  # leader_ask / underdog_ask
            "end_ms": end_ms,
        })
        finalize()

    def eval_(sub):
        if not sub: return None
        n = len(sub)
        wins = sum(1 for s in sub if s["won"])
        avg_ask = sum(s["underdog_ask"] for s in sub) / n
        pnl = sum(simulate(s["underdog_ask"], s["won"]) for s in sub)
        be = breakeven_wr(avg_ask) * 100
        wr = wins / n * 100
        return {"n": n, "wr": wr, "be": be, "edge": wr - be, "pnl": pnl, "per_tr": pnl / n, "avg_ask": avg_ask}

    print(f"cross_0 universe (2-30¢ underdog): {len(samples)} samples")
    print()

    # D1: Per-crypto
    print("=" * 95)
    print("D1: Per-crypto breakdown (cross_0, all bands 02-30c)")
    print("=" * 95)
    print(f"{'Crypto':<8} {'N':>5} {'WR':>7} {'AvgAsk':>7} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
    for c in ("BTC", "ETH", "SOL", "XRP"):
        sub = [s for s in samples if s["crypto"] == c]
        r = eval_(sub)
        if not r: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"{c:<8} {r['n']:>5} {r['wr']:>6.2f}% {r['avg_ask'] * 100:>6.2f}¢ {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f} {mk}")
    print()

    # D2: Interval
    print("=" * 95)
    print("D2: Interval breakdown (cross_0, all bands)")
    print("=" * 95)
    print(f"{'Interval':<10} {'N':>5} {'WR':>7} {'AvgAsk':>7} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
    for iv in ("5m", "15m"):
        sub = [s for s in samples if s["interval"] == iv]
        r = eval_(sub)
        if not r: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"{iv:<10} {r['n']:>5} {r['wr']:>6.2f}% {r['avg_ask'] * 100:>6.2f}¢ {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f} {mk}")
    print()

    # D3: Finer bands
    print("=" * 95)
    print("D3: Finer price-band granularity (cross_0)")
    print("=" * 95)
    print(f"{'Band':<7} {'N':>5} {'WR':>7} {'Breakeven':>10} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
    bands = [(0.02, 0.04, "02-04"), (0.04, 0.06, "04-06"), (0.06, 0.08, "06-08"),
             (0.08, 0.10, "08-10"), (0.10, 0.12, "10-12"), (0.12, 0.14, "12-14"),
             (0.14, 0.16, "14-16"), (0.16, 0.18, "16-18"), (0.18, 0.20, "18-20"),
             (0.20, 0.22, "20-22"), (0.22, 0.25, "22-25"), (0.25, 0.30, "25-30")]
    for lo, hi, label in bands:
        sub = [s for s in samples if lo <= s["underdog_ask"] < hi]
        r = eval_(sub)
        if not r or r["n"] < 20: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"{label:<7} {r['n']:>5} {r['wr']:>6.2f}% {r['be']:>9.2f}% {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f} {mk}")
    print()

    # D4: Time-of-day
    print("=" * 95)
    print("D4: Time-of-day — is there a best UTC-hour window?")
    print("=" * 95)
    print(f"{'UTC hour bucket':<18} {'N':>5} {'WR':>7} {'Edge':>8} {'$/tr':>7}")
    for lo, hi, label in [(0, 6, "00-06"), (6, 12, "06-12"), (12, 18, "12-18"), (18, 24, "18-24")]:
        sub = [s for s in samples if lo <= s["hour"] < hi]
        r = eval_(sub)
        if not r: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"{label:<18} {r['n']:>5} {r['wr']:>6.2f}% {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {mk}")
    print()

    # D5: Cross_0 + feature combos in low bands (refined list)
    print("=" * 95)
    print("D5: cross_0 AND feature — at price bands 05-20c only")
    print("=" * 95)
    print(f"{'Feature':<24} {'N':>5} {'WR':>7} {'AvgAsk':>7} {'Edge':>8} {'$/tr':>7} {'Total':>9}")
    base_sub = [s for s in samples if 0.05 <= s["underdog_ask"] < 0.20]
    for feat_name, f in [
        ("(no filter)", lambda s: True),
        ("cl_3c_calm", lambda s: s["cl_3c_calm"]),
        ("cl_3c_violent", lambda s: s["cl_3c_violent"]),
        ("volume_high", lambda s: s["volume_high"]),
        ("volume_low", lambda s: s["volume_low"]),
        ("leader_strengthening", lambda s: s["leader_strengthening"]),
        ("NOT leader_strengthening", lambda s: not s["leader_strengthening"]),
        ("leader_just_flipped", lambda s: s["leader_just_flipped"]),
        ("depth_ratio > 2", lambda s: s["depth_ratio"] and s["depth_ratio"] > 2),
        ("depth_ratio > 5", lambda s: s["depth_ratio"] and s["depth_ratio"] > 5),
        ("interval_15m", lambda s: s["interval"] == "15m"),
        ("interval_5m", lambda s: s["interval"] == "5m"),
    ]:
        sub = [s for s in base_sub if f(s)]
        r = eval_(sub)
        if not r or r["n"] < 30: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"{feat_name:<24} {r['n']:>5} {r['wr']:>6.2f}% {r['avg_ask'] * 100:>6.2f}¢ {r['edge']:>+7.2f}pp {r['per_tr']:>+6.3f} {r['pnl']:>+8.2f} {mk}")
    print()

    # D6: Leader strengthening vs weakening
    print("=" * 95)
    print("D6: Does leader's T-240 → T-33 trajectory matter?")
    print("=" * 95)
    print("If leader bid is WEAKENING (market pricing out the favorite), underdog may be")
    print("even more underpriced. Sample at 05-20c.")
    sub_strength = [s for s in base_sub if s["leader_strengthening"] is True]
    sub_weak = [s for s in base_sub if s["leader_strengthening"] is False]
    r_s = eval_(sub_strength)
    r_w = eval_(sub_weak)
    if r_s:
        print(f"  Leader strengthening: N={r_s['n']:>4} WR={r_s['wr']:.2f}% edge={r_s['edge']:+.2f}pp $/tr={r_s['per_tr']:+.3f}")
    if r_w:
        print(f"  Leader weakening:     N={r_w['n']:>4} WR={r_w['wr']:.2f}% edge={r_w['edge']:+.2f}pp $/tr={r_w['per_tr']:+.3f}")
    print()

    # D7: Depth imbalance
    print("=" * 95)
    print("D7: Order-book depth imbalance (leader-ask-depth / underdog-ask-depth)")
    print("=" * 95)
    print("High ratio = lots of ask-side selling pressure on leader, less on underdog.")
    print("Could mean leader is being offered heavily (weakness); underdog is spare.")
    bins = [(0, 1, "<1"), (1, 2, "1-2"), (2, 5, "2-5"), (5, 10, "5-10"), (10, 9999, ">10")]
    for lo, hi, label in bins:
        sub = [s for s in base_sub if s["depth_ratio"] and lo <= s["depth_ratio"] < hi]
        r = eval_(sub)
        if not r or r["n"] < 30: continue
        mk = "✓" if r["edge"] > 0 else "✗"
        print(f"  ratio {label:<6} N={r['n']:>4} WR={r['wr']:.2f}% edge={r['edge']:+.2f}pp $/tr={r['per_tr']:+.3f} total=${r['pnl']:+.2f} {mk}")


if __name__ == "__main__":
    main()
