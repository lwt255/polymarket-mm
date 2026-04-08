#!/usr/bin/env python3
"""For every market with an arb snapshot, measure how long the arb persisted.

An arb "persists" if consecutive snapshots (in secondsBeforeEnd order) also show askSum<1 or bidSum>1.
Gives us the distribution of arb-window durations to tell latency arbs (1-frame) from structural arbs.
"""
import json
from collections import Counter

MIN_SECS = 30
MIN_EDGE = 0.005

ask_runs = Counter()  # key: run length (consecutive snapshots with ask arb), value: count of runs
bid_runs = Counter()
one_off_ask_examples = []
multi_ask_examples = []

def scan_runs(snaps, side):
    """Yield run lengths for side='ask' (askSum<1) or 'bid' (bidSum>1)."""
    in_run = 0
    for s in snaps:
        secs = s.get("secondsBeforeEnd")
        if secs is None or secs < MIN_SECS:
            if in_run: yield in_run; in_run = 0
            continue
        ub = s.get("upBid", 0) or 0; ua = s.get("upAsk", 0) or 0
        db = s.get("downBid", 0) or 0; da = s.get("downAsk", 0) or 0
        uad = s.get("upAskDepth", 0) or 0; dad = s.get("downAskDepth", 0) or 0
        ubd = s.get("upBidDepth", 0) or 0; dbd = s.get("downBidDepth", 0) or 0
        if ub==0 or ua==0 or db==0 or da==0 or uad==0 or dad==0 or ubd==0 or dbd==0:
            if in_run: yield in_run; in_run = 0
            continue
        if ua <= ub or da <= db:
            if in_run: yield in_run; in_run = 0
            continue
        asksum = s.get("askSumCheck"); bidsum = s.get("bidSumCheck")
        hit = False
        if side == "ask" and asksum is not None and (1.0 - asksum) >= MIN_EDGE:
            hit = True
        if side == "bid" and bidsum is not None and (bidsum - 1.0) >= MIN_EDGE:
            hit = True
        if hit:
            in_run += 1
        else:
            if in_run: yield in_run; in_run = 0
    if in_run: yield in_run

with open("pricing-data.raw.jsonl", "r") as f:
    for line in f:
        rec = json.loads(line)
        snaps = rec.get("snapshots") or []
        # Ensure sorted by descending secondsBeforeEnd (should already be)
        snaps = sorted(snaps, key=lambda s: -(s.get("secondsBeforeEnd") or -999))
        slug = rec.get("slug", "")
        for rl in scan_runs(snaps, "ask"):
            ask_runs[rl] += 1
            if rl == 1 and len(one_off_ask_examples) < 3:
                one_off_ask_examples.append(slug)
            if rl >= 3 and len(multi_ask_examples) < 5:
                multi_ask_examples.append((rl, slug))
        for rl in scan_runs(snaps, "bid"):
            bid_runs[rl] += 1

print("ASK arb run lengths (# consecutive snapshots with askSum<1):")
total = sum(ask_runs.values())
for length in sorted(ask_runs.keys()):
    c = ask_runs[length]
    print(f"  len={length:>3}  runs={c:>4}  ({100*c/total:.1f}%)")
print(f"  total runs: {total}")
print()
print("BID arb run lengths:")
total = sum(bid_runs.values())
for length in sorted(bid_runs.keys()):
    c = bid_runs[length]
    print(f"  len={length:>3}  runs={c:>4}  ({100*c/total:.1f}%)")
print(f"  total runs: {total}")
print()
print("Multi-snapshot ASK arb examples:")
for rl, slug in multi_ask_examples:
    print(f"  len={rl}  {slug}")
