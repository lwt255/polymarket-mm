#!/usr/bin/env python3
"""Inspect raw snapshots for a slug — show all askSum/bidSum across all records."""
import json
import sys

target_slug = sys.argv[1] if len(sys.argv) > 1 else "btc-updown-5m-1774790400"

with open("pricing-data.raw.jsonl", "r") as f:
    for line in f:
        rec = json.loads(line)
        slug = rec.get("slug") or ""
        if target_slug not in slug:
            continue
        print(f"=== slug={slug}  resolution={rec.get('resolution')}  finalUpBid={rec.get('finalUpBid')}  finalDownBid={rec.get('finalDownBid')} ===")
        for snap in (rec.get("snapshots") or []):
            t = snap.get("secondsBeforeEnd")
            ub = snap.get("upBid"); ua = snap.get("upAsk")
            db = snap.get("downBid"); da = snap.get("downAsk")
            uad = snap.get("upAskDepth", 0); dad = snap.get("downAskDepth", 0)
            ubd = snap.get("upBidDepth", 0); dbd = snap.get("downBidDepth", 0)
            asksum = snap.get("askSumCheck")
            bidsum = snap.get("bidSumCheck")
            flag = ""
            if asksum is not None and asksum < 1.0: flag += " ASK_ARB"
            if bidsum is not None and bidsum > 1.0: flag += " BID_ARB"
            print(f"  T-{t:>5}  up b/a={ub:.3f}/{ua:.3f} d={ubd:.0f}/{uad:.0f}  down b/a={db:.3f}/{da:.3f} d={dbd:.0f}/{dad:.0f}  askSum={asksum:.3f} bidSum={bidsum:.3f}{flag}")
        print()
