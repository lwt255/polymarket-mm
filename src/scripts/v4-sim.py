#!/usr/bin/env python3
"""
v4 9-signal filter paper sim.

Filter (matches microstructure-bot.ts):
  - Use T-30 snapshot (closest to 30s before end)
  - Determine leader from upMid vs downMid at T-30
  - Leader bid in 0.54..0.75 zone
  - leaderRising: leader bid at T-30 > leader bid at T-120
  - Two-sided: followerBid >= 0.05 AND leaderAsk in (0.03, 0.97)
  - Liquidity: leader ask depth from bookShape.topAsks[0] > 0
  - Trade size $10 at leader_ask (taker entry, no fees assumed for maker model)
  - P&L: shares * (1 - leader_ask) if leader won, else -$10

Usage: python3 src/scripts/v4-sim.py <jsonl-file>
"""
import json
import sys
from collections import defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "/tmp/today-04-07.jsonl"
TRADE_SIZE = 10.0

def closest_snap(snaps, target):
    """Return snapshot closest to target secondsBeforeEnd."""
    best = None
    best_diff = 10**9
    for s in snaps:
        sec = s.get("secondsBeforeEnd")
        if sec is None or sec < 0:
            continue
        d = abs(sec - target)
        if d < best_diff:
            best_diff = d
            best = s
    return best

def leader_ask_depth(snap, side):
    """Top-level depth fields on snapshot."""
    if side == "UP":
        return snap.get("upAskDepth", 0) or 0
    return snap.get("downAskDepth", 0) or 0

trades = []
considered = 0
rejected_reasons = defaultdict(int)

with open(PATH, "r") as f:
    for line in f:
        line = line.strip()
        if not line:
            continue
        try:
            rec = json.loads(line)
        except json.JSONDecodeError:
            continue
        snaps = rec.get("snapshots") or []
        if not snaps:
            continue

        s30 = closest_snap(snaps, 30)
        s120 = closest_snap(snaps, 120)
        if s30 is None or s120 is None:
            rejected_reasons["no_t30_or_t120"] += 1
            continue
        # Require we actually got near the targets
        if abs(s30.get("secondsBeforeEnd", 999) - 30) > 25:
            rejected_reasons["t30_too_far"] += 1
            continue
        if abs(s120.get("secondsBeforeEnd", 999) - 120) > 40:
            rejected_reasons["t120_too_far"] += 1
            continue

        considered += 1

        upBid = s30.get("upBid", 0); upAsk = s30.get("upAsk", 0)
        downBid = s30.get("downBid", 0); downAsk = s30.get("downAsk", 0)

        # Match microstructure-bot.ts:242 — leader by bid, TIE if equal
        if upBid > downBid:
            leader_side = "UP"
            leaderBid, leaderAsk = upBid, upAsk
            followerBid = downBid
            leaderBid120 = s120.get("upBid", 0)
        elif downBid > upBid:
            leader_side = "DOWN"
            leaderBid, leaderAsk = downBid, downAsk
            followerBid = upBid
            leaderBid120 = s120.get("downBid", 0)
        else:
            rejected_reasons["tie"] += 1
            continue

        # Filter: 54-75¢ zone — bot checks leaderASK (microstructure-bot.ts:381)
        if not (0.54 <= leaderAsk < 0.75):
            rejected_reasons["zone"] += 1
            continue
        # Filter: two-sided
        if not (followerBid >= 0.05 and 0.03 < leaderAsk < 0.97):
            rejected_reasons["two_sided"] += 1
            continue
        # Filter: leader rising
        if not (leaderBid > leaderBid120):
            rejected_reasons["not_rising"] += 1
            continue
        # Filter: liquidity
        depth = leader_ask_depth(s30, leader_side)
        if depth < TRADE_SIZE / max(leaderAsk, 0.01):
            rejected_reasons["thin"] += 1
            continue

        # Determine winner from record-level resolution
        resolution = rec.get("resolution")
        if resolution not in ("UP", "DOWN"):
            rejected_reasons["unresolved"] += 1
            continue

        shares = TRADE_SIZE / leaderAsk
        if leader_side == resolution:
            pnl = shares * (1 - leaderAsk)
            outcome = "W"
        else:
            pnl = -TRADE_SIZE
            outcome = "L"

        trades.append({
            "slug": rec.get("slug", "?"),
            "leader": leader_side,
            "ask": leaderAsk,
            "leader_bid": leaderBid,
            "leader_bid_120": leaderBid120,
            "outcome": outcome,
            "pnl": pnl,
        })

# Report
n = len(trades)
wins = sum(1 for t in trades if t["outcome"] == "W")
losses = n - wins
total_pnl = sum(t["pnl"] for t in trades)
wr = wins/n if n else 0

print("="*60)
print(f"v4 9-signal sim — {PATH}")
print("="*60)
print(f"Records considered    : {considered}")
print(f"Trades taken          : {n}")
print(f"Wins                  : {wins}")
print(f"Losses                : {losses}")
print(f"Win rate              : {100*wr:.1f}%")
print(f"Total P&L (@${TRADE_SIZE:.0f}) : ${total_pnl:+.2f}")
if n:
    print(f"Avg per trade         : ${total_pnl/n:+.2f}")
print()
print("Rejection reasons:")
for k, v in sorted(rejected_reasons.items(), key=lambda x: -x[1]):
    print(f"  {k:20s} {v:>5}")
print()
print("Last 10 trades:")
for t in trades[-10:]:
    sign = "+" if t["pnl"] > 0 else " "
    print(f"  {t['outcome']}  {sign}${t['pnl']:6.2f}  ask={t['ask']:.3f}  bid={t['leader_bid']:.3f}({t['leader_bid_120']:.3f})  {t['slug'][:50]}")
