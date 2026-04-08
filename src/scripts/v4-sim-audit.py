#!/usr/bin/env python3
"""
Audit v4-sim.py for lookahead bias and other correctness issues.

Reports:
  1. Distribution of actual secondsBeforeEnd for the snapshots picked as "T-30" and "T-120",
     split by win/loss. If lookahead is inflating WR, the distribution for wins should
     skew toward smaller secs (closer to resolution).
  2. Re-runs the sim with progressively tighter tolerance and prints WR/P&L deltas.
"""
import json
import sys
from collections import Counter, defaultdict

PATH = sys.argv[1] if len(sys.argv) > 1 else "/tmp/today-04-08.jsonl"
TRADE_SIZE = 10.0

def closest_snap(snaps, target, max_diff):
    best = None
    best_diff = 10**9
    for s in snaps:
        sec = s.get("secondsBeforeEnd")
        if sec is None or sec < 0:
            continue
        d = abs(sec - target)
        if d > max_diff:
            continue
        if d < best_diff:
            best_diff = d
            best = s
    return best

def leader_depth(snap, side):
    return (snap.get("upAskDepth" if side == "UP" else "downAskDepth", 0) or 0)

def run_sim(records, t30_max_diff, t120_max_diff):
    trades = []
    t30_secs_used = []
    t120_secs_used = []
    for rec in records:
        snaps = rec.get("snapshots") or []
        s30 = closest_snap(snaps, 30, t30_max_diff)
        s120 = closest_snap(snaps, 120, t120_max_diff)
        if s30 is None or s120 is None:
            continue
        upMid = s30.get("upMid", 0); downMid = s30.get("downMid", 0)
        upBid = s30.get("upBid", 0); upAsk = s30.get("upAsk", 0)
        downBid = s30.get("downBid", 0); downAsk = s30.get("downAsk", 0)
        if upMid >= downMid:
            leader_side = "UP"; leaderBid, leaderAsk = upBid, upAsk
            followerBid = downBid; leaderBid120 = s120.get("upBid", 0)
        else:
            leader_side = "DOWN"; leaderBid, leaderAsk = downBid, downAsk
            followerBid = upBid; leaderBid120 = s120.get("downBid", 0)
        if not (0.54 <= leaderBid <= 0.75): continue
        if not (followerBid >= 0.05 and 0.03 < leaderAsk < 0.97): continue
        if not (leaderBid > leaderBid120): continue
        depth = leader_depth(s30, leader_side)
        if depth < TRADE_SIZE / max(leaderAsk, 0.01): continue
        resolution = rec.get("resolution")
        if resolution not in ("UP", "DOWN"): continue
        shares = TRADE_SIZE / leaderAsk
        won = (leader_side == resolution)
        pnl = shares * (1 - leaderAsk) if won else -TRADE_SIZE
        trades.append({"won": won, "pnl": pnl,
                       "t30_sec": s30.get("secondsBeforeEnd"),
                       "t120_sec": s120.get("secondsBeforeEnd")})
        t30_secs_used.append(s30.get("secondsBeforeEnd"))
        t120_secs_used.append(s120.get("secondsBeforeEnd"))
    return trades, t30_secs_used, t120_secs_used

# Load all records
records = []
with open(PATH) as f:
    for line in f:
        line = line.strip()
        if not line: continue
        try: records.append(json.loads(line))
        except: pass

print(f"=== AUDIT — {PATH}, {len(records)} records ===\n")

# 1) Run with current loose tolerance and dump distributions
trades, t30s, t120s = run_sim(records, t30_max_diff=25, t120_max_diff=40)
n = len(trades); wins = sum(1 for t in trades if t["won"])
pnl = sum(t["pnl"] for t in trades)
print(f"BASELINE (t30 tol=25, t120 tol=40)")
print(f"  trades={n}  wins={wins}  WR={100*wins/max(n,1):.1f}%  P&L=${pnl:+.2f}\n")

print("Chosen T-30 secondsBeforeEnd distribution (split by outcome):")
win_t30 = [t["t30_sec"] for t in trades if t["won"]]
loss_t30 = [t["t30_sec"] for t in trades if not t["won"]]
def histo(values):
    buckets = Counter()
    for v in values:
        b = (v // 10) * 10
        buckets[b] += 1
    return buckets
print(f"  Wins  ({len(win_t30)})  : avg={sum(win_t30)/max(len(win_t30),1):.1f}s  min={min(win_t30) if win_t30 else 0}  max={max(win_t30) if win_t30 else 0}")
print(f"  Losses({len(loss_t30)}) : avg={sum(loss_t30)/max(len(loss_t30),1):.1f}s  min={min(loss_t30) if loss_t30 else 0}  max={max(loss_t30) if loss_t30 else 0}")
print()
print("  Win  T-30 buckets:", dict(sorted(histo(win_t30).items())))
print("  Loss T-30 buckets:", dict(sorted(histo(loss_t30).items())))
print()

# Sanity check the T-120 lookups too
win_t120 = [t["t120_sec"] for t in trades if t["won"]]
loss_t120 = [t["t120_sec"] for t in trades if not t["won"]]
print(f"T-120 chosen secondsBeforeEnd:")
print(f"  Wins  avg={sum(win_t120)/max(len(win_t120),1):.1f}s")
print(f"  Losses avg={sum(loss_t120)/max(len(loss_t120),1):.1f}s")
print()

# 2) Tighten tolerance progressively
print("=== TOLERANCE SWEEP ===")
for t30_tol, t120_tol in [(25, 40), (15, 25), (10, 15), (5, 10), (3, 5)]:
    trades, _, _ = run_sim(records, t30_tol, t120_tol)
    n = len(trades); wins = sum(1 for t in trades if t["won"])
    pnl = sum(t["pnl"] for t in trades)
    wr = 100*wins/max(n,1)
    print(f"  t30±{t30_tol}s, t120±{t120_tol}s  →  n={n:>4}  WR={wr:.1f}%  P&L=${pnl:+8.2f}")
