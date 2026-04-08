#!/usr/bin/env python3
"""
YES+NO arbitrage scanner for Polymarket crypto 5-min/15-min binary markets.

For each binary UP/DOWN market snapshot, checks:
  - ASK arb: upAsk + downAsk < 1.00  → buy both, redeem pair for $1, profit per share = 1 - askSum
  - BID arb: upBid + downBid > 1.00  → mint pair for $1, sell both, profit per share = bidSum - 1

Both arbs are gated by min depth available at the touch.

Run:
  python3 src/scripts/arb-scanner.py [--file pricing-data.raw.jsonl] [--min-depth 10] [--min-edge 0.005]
"""

import argparse
import json
import sys
from collections import defaultdict
from datetime import datetime, timezone

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument("--file", default="pricing-data.raw.jsonl")
    p.add_argument("--min-depth", type=float, default=10.0,
                   help="Min size (shares) available at touch on BOTH sides to count")
    p.add_argument("--min-edge", type=float, default=0.005,
                   help="Min raw edge (1 - askSum or bidSum - 1) to flag, in $/share")
    p.add_argument("--min-secs-before-end", type=int, default=30,
                   help="Reject snapshots within this many seconds of close (incl. post-resolution)")
    p.add_argument("--limit", type=int, default=0,
                   help="Stop after N records (0 = all)")
    return p.parse_args()

def iter_snapshots(path):
    """Yield every BookSnapshot from every market record in the jsonl."""
    with open(path, "r") as f:
        for line_num, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            snapshots = rec.get("snapshots") or []
            slug = rec.get("slug") or rec.get("marketSlug") or "?"
            crypto = rec.get("crypto", "?")
            interval = rec.get("interval", "?")
            for snap in snapshots:
                yield slug, crypto, interval, snap
            yield None, None, None, None  # record boundary marker

def main():
    args = parse_args()

    n_records = 0
    n_snapshots = 0
    n_ask_arb = 0
    n_bid_arb = 0
    n_ask_arb_with_depth = 0
    n_bid_arb_with_depth = 0
    total_ask_edge = 0.0
    total_bid_edge = 0.0
    total_ask_dollars = 0.0  # edge * min_depth (capped fill)
    total_bid_dollars = 0.0

    biggest_ask = []  # (edge, slug, crypto, interval, secondsBeforeEnd, askSum, depth)
    biggest_bid = []

    by_crypto_interval = defaultdict(lambda: {"ask": 0, "bid": 0, "snaps": 0})

    for slug, crypto, interval, snap in iter_snapshots(args.file):
        if slug is None:
            n_records += 1
            if args.limit and n_records >= args.limit:
                break
            continue
        n_snapshots += 1
        # Derive crypto/interval from slug like "btc-updown-5m-1774790400"
        key = "?-?m"
        parts = (slug or "").split("-")
        if len(parts) >= 3:
            key = f"{parts[0]}-{parts[2]}"
        by_crypto_interval[key]["snaps"] += 1

        ask_sum = snap.get("askSumCheck")
        bid_sum = snap.get("bidSumCheck")
        if ask_sum is None or bid_sum is None:
            continue

        # Reject post-resolution and last-N-seconds snapshots (latency-arb territory we can't touch)
        secs = snap.get("secondsBeforeEnd")
        if secs is None or secs < args.min_secs_before_end:
            continue

        up_bid = snap.get("upBid", 0) or 0
        up_ask = snap.get("upAsk", 0) or 0
        down_bid = snap.get("downBid", 0) or 0
        down_ask = snap.get("downAsk", 0) or 0
        up_ask_depth = snap.get("upAskDepth", 0) or 0
        down_ask_depth = snap.get("downAskDepth", 0) or 0
        up_bid_depth = snap.get("upBidDepth", 0) or 0
        down_bid_depth = snap.get("downBidDepth", 0) or 0

        # Reject empty-book artifacts (any zero price or zero depth on either side)
        if (up_bid == 0 or up_ask == 0 or down_bid == 0 or down_ask == 0
                or up_ask_depth == 0 or down_ask_depth == 0
                or up_bid_depth == 0 or down_bid_depth == 0):
            continue
        # Reject obviously crossed/garbage books
        if up_ask <= up_bid or down_ask <= down_bid:
            continue

        # ASK arb: buy both sides
        if ask_sum < 1.0:
            edge = 1.0 - ask_sum
            if edge >= args.min_edge:
                n_ask_arb += 1
                total_ask_edge += edge
                fill_depth = min(up_ask_depth, down_ask_depth)
                if fill_depth >= args.min_depth:
                    n_ask_arb_with_depth += 1
                    total_ask_dollars += edge * fill_depth
                    by_crypto_interval[key]["ask"] += 1
                    biggest_ask.append((edge, slug, crypto, interval,
                                        snap.get("secondsBeforeEnd"), ask_sum, fill_depth))

        # BID arb: mint pair, sell both
        if bid_sum > 1.0:
            edge = bid_sum - 1.0
            if edge >= args.min_edge:
                n_bid_arb += 1
                total_bid_edge += edge
                fill_depth = min(up_bid_depth, down_bid_depth)
                if fill_depth >= args.min_depth:
                    n_bid_arb_with_depth += 1
                    total_bid_dollars += edge * fill_depth
                    by_crypto_interval[key]["bid"] += 1
                    biggest_bid.append((edge, slug, crypto, interval,
                                        snap.get("secondsBeforeEnd"), bid_sum, fill_depth))

    biggest_ask.sort(reverse=True)
    biggest_bid.sort(reverse=True)

    print("=" * 70)
    print(f"ARB SCAN — file={args.file}")
    print(f"  min-depth={args.min_depth} shares  min-edge=${args.min_edge:.4f}/share")
    print("=" * 70)
    print(f"Records scanned       : {n_records:,}")
    print(f"Snapshots scanned     : {n_snapshots:,}")
    print()
    print("ASK arb (buy both, redeem):")
    print(f"  raw violations      : {n_ask_arb:,}")
    print(f"  with ≥{args.min_depth:.0f} depth      : {n_ask_arb_with_depth:,}")
    if n_ask_arb_with_depth:
        print(f"  avg edge ($/share)  : {total_ask_edge/max(n_ask_arb,1):.4f}")
        print(f"  total $ if all hit  : ${total_ask_dollars:,.2f}")
    print()
    print("BID arb (mint pair, sell both):")
    print(f"  raw violations      : {n_bid_arb:,}")
    print(f"  with ≥{args.min_depth:.0f} depth      : {n_bid_arb_with_depth:,}")
    if n_bid_arb_with_depth:
        print(f"  avg edge ($/share)  : {total_bid_edge/max(n_bid_arb,1):.4f}")
        print(f"  total $ if all hit  : ${total_bid_dollars:,.2f}")
    print()
    print("By crypto/interval (with-depth counts):")
    for key in sorted(by_crypto_interval.keys()):
        d = by_crypto_interval[key]
        print(f"  {key:10s}  snaps={d['snaps']:>8,}  ask_arb={d['ask']:>4}  bid_arb={d['bid']:>4}")

    print()
    print("Top 10 ASK arbs (edge, slug, secs_before_end, askSum, depth):")
    for row in biggest_ask[:10]:
        edge, slug, crypto, interval, sec, ask_sum, depth = row
        print(f"  ${edge:.4f}  {slug[:55]:55s}  T-{sec or '?':>4}  askSum={ask_sum:.4f}  depth={depth:.0f}")
    print()
    print("Top 10 BID arbs (edge, slug, secs_before_end, bidSum, depth):")
    for row in biggest_bid[:10]:
        edge, slug, crypto, interval, sec, bid_sum, depth = row
        print(f"  ${edge:.4f}  {slug[:55]:55s}  T-{sec or '?':>4}  bidSum={bid_sum:.4f}  depth={depth:.0f}")

if __name__ == "__main__":
    main()
