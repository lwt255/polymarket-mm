#!/usr/bin/env python3
"""
Audit candidate-stack paper/live runs against collector assumptions.

Compares:
  - Bot decision-time diagnostics vs collector T-33 snapshot
  - Bot recorded fills vs collector T-30 ask on the traded side

Usage:
  python3 src/scripts/crypto-5min/candidate-stack-parity-audit.py \
    --collector /tmp/pricing-data.jsonl \
    --ledger candidate-stack-trades.dry-run.jsonl \
    --diag candidate-stack-diagnostics.dry-run.jsonl
"""

from __future__ import annotations

import argparse
import json
import os
from collections import defaultdict
from datetime import datetime, timezone


def parse_ts(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        seconds = ts / 1000 if ts > 1e12 else ts
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def open_jsonl(path):
    rows = []
    with open(path, "r") as handle:
        for line in handle:
            if not line.strip():
                continue
            rows.append(json.loads(line))
    return rows


def closest_snapshot_at_or_after(snaps, target_sec):
    best = None
    best_key = None
    for snap in snaps:
        sec = snap.get("secondsBeforeEnd")
        if not isinstance(sec, (int, float)) or sec < target_sec:
            continue
        key = (sec - target_sec, abs(sec - target_sec))
        if best_key is None or key < best_key:
            best = snap
            best_key = key
    return best


def closest_snapshot(snaps, target_sec):
    best = None
    best_key = None
    for snap in snaps:
        sec = snap.get("secondsBeforeEnd")
        if not isinstance(sec, (int, float)):
            continue
        key = (abs(sec - target_sec), 0 if sec >= target_sec else 1, sec)
        if best_key is None or key < best_key:
            best = snap
            best_key = key
    return best


def side_from_snapshot(snap):
    up_bid = snap.get("upBid", 0) or 0
    down_bid = snap.get("downBid", 0) or 0
    if up_bid > down_bid:
        return "UP"
    if down_bid > up_bid:
        return "DOWN"
    return "TIE"


def side_values(snap, side):
    if side == "UP":
        return snap.get("upBid", 0) or 0, snap.get("upAsk", 1) or 1
    return snap.get("downBid", 0) or 0, snap.get("downAsk", 1) or 1


def mean(values):
    return sum(values) / len(values) if values else 0.0


def percentile(values, pct):
    if not values:
        return 0.0
    ordered = sorted(values)
    idx = min(len(ordered) - 1, max(0, round((len(ordered) - 1) * pct)))
    return ordered[idx]


def fmt_cents(x):
    return f"{x * 100:.2f}¢"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--collector", default="/tmp/pricing-data.jsonl")
    parser.add_argument("--ledger", default="candidate-stack-trades.dry-run.jsonl")
    parser.add_argument("--diag", default="candidate-stack-diagnostics.dry-run.jsonl")
    args = parser.parse_args()

    if not os.path.exists(args.collector):
        raise SystemExit(f"Collector file not found: {args.collector}")
    if not os.path.exists(args.ledger):
        raise SystemExit(f"Ledger file not found: {args.ledger}")
    if not os.path.exists(args.diag):
        raise SystemExit(f"Diagnostics file not found: {args.diag}")

    ledger_rows = open_jsonl(args.ledger)
    diag_rows = open_jsonl(args.diag)

    # Build the slug set we actually care about so we can stream the
    # collector file and only retain rows for those slugs. The VPS
    # pricing-data.jsonl is ~4GB and the VPS has ~2GB RAM, so loading
    # everything is an OOM guarantee.
    wanted_slugs = set()
    for row in ledger_rows:
        s = row.get("slug")
        if s: wanted_slugs.add(s)
    for row in diag_rows:
        s = row.get("slug")
        if s: wanted_slugs.add(s)

    collector_by_slug = {}
    collector_count = 0
    first = None
    last = None
    with open(args.collector, "r") as handle:
        for line in handle:
            if not line.strip():
                continue
            collector_count += 1
            # Cheap substring prefilter: skip JSON parse unless one of the
            # wanted slugs appears in the line. Keeps RSS low on 4GB files.
            if not any(f'"slug":"{s}"' in line for s in wanted_slugs):
                continue
            try:
                row = json.loads(line)
            except Exception:
                continue
            ts = row.get("collectedAt")
            if ts:
                if first is None:
                    first = ts
                last = ts
            slug = row.get("slug")
            if slug in wanted_slugs:
                collector_by_slug[slug] = row

    diag_by_slug = defaultdict(list)
    for row in diag_rows:
        diag_by_slug[row.get("slug")].append(row)

    decision_ask_diffs = []
    decision_bid_diffs = []
    decision_side_mismatches = 0
    diag_compared = 0

    for slug, rows in diag_by_slug.items():
        collector = collector_by_slug.get(slug)
        if not collector:
            continue
        snaps = collector.get("snapshots") or []
        collector_decision = closest_snapshot_at_or_after(snaps, 33)
        if collector_decision is None:
            continue
        # Use the latest diagnostic row for the slug's entry phase
        diag_entry = sorted(rows, key=lambda row: row.get("timestamp") or "")[-1]
        live_side = diag_entry.get("leader")
        collector_side = side_from_snapshot(collector_decision)
        if live_side != collector_side:
            decision_side_mismatches += 1
        if live_side in ("UP", "DOWN") and collector_side in ("UP", "DOWN"):
            live_bid = diag_entry["up"]["bestBid"] if live_side == "UP" else diag_entry["down"]["bestBid"]
            live_ask = diag_entry["up"]["bestAsk"] if live_side == "UP" else diag_entry["down"]["bestAsk"]
            collector_bid, collector_ask = side_values(collector_decision, live_side)
            decision_bid_diffs.append(live_bid - collector_bid)
            decision_ask_diffs.append(live_ask - collector_ask)
            diag_compared += 1

    fill_diffs = []
    fill_side_mismatches = 0
    fill_compared = 0

    for row in ledger_rows:
        if row.get("execution", {}).get("status") != "FILLED":
            continue
        slug = row.get("slug")
        collector = collector_by_slug.get(slug)
        if not collector:
            continue
        snaps = collector.get("snapshots") or []
        collector_fill = closest_snapshot(snaps, 30)
        if collector_fill is None:
            continue
        side = row.get("underdogSide")
        if side not in ("UP", "DOWN"):
            continue
        collector_side = side_from_snapshot(collector_fill)
        if collector_side not in ("UP", "DOWN"):
            continue
        if side != collector_side:
            fill_side_mismatches += 1
        _, collector_ask = side_values(collector_fill, side)
        fill_price = row.get("execution", {}).get("fillPrice", 0) or 0
        fill_diffs.append(fill_price - collector_ask)
        fill_compared += 1

    print(json.dumps({
        "collector_path": args.collector,
        "collector_lines_scanned": collector_count,
        "collector_rows_matched": len(collector_by_slug),
        "collector_first": first,
        "collector_last": last,
        "ledger_path": args.ledger,
        "ledger_count": len(ledger_rows),
        "diag_path": args.diag,
        "diag_count": len(diag_rows),
        "wanted_slugs": len(wanted_slugs),
    }, indent=2))

    print("\n=== Decision Snapshot Parity ===")
    print(f"compared={diag_compared} side_mismatches={decision_side_mismatches}")
    if diag_compared:
        print(
            f"ask_diff avg={fmt_cents(mean(decision_ask_diffs))} "
            f"p50={fmt_cents(percentile(decision_ask_diffs, 0.50))} "
            f"p90={fmt_cents(percentile(decision_ask_diffs, 0.90))}"
        )
        print(
            f"bid_diff avg={fmt_cents(mean(decision_bid_diffs))} "
            f"p50={fmt_cents(percentile(decision_bid_diffs, 0.50))} "
            f"p90={fmt_cents(percentile(decision_bid_diffs, 0.90))}"
        )

    print("\n=== Fill Parity ===")
    print(f"compared={fill_compared} side_mismatches={fill_side_mismatches}")
    if fill_compared:
        print(
            f"fill_diff avg={fmt_cents(mean(fill_diffs))} "
            f"p50={fmt_cents(percentile(fill_diffs, 0.50))} "
            f"p90={fmt_cents(percentile(fill_diffs, 0.90))}"
        )

    # ── Friction budget ──
    # Decompose live-vs-collector gap into its components so we know what's
    # actually eating the edge vs what the collector already knew about.
    #
    # Definitions:
    #   slippage  = (bot fillPrice - collector T-30 ask) × shares
    #               Negative = bot paid less than collector model, positive = paid more
    #   fees_gas  = expectedPnl (collector math) - actual wallet balance delta
    #               Fees on both sides: taker fee on entry, gas on redeem
    #   phantom   = for UNFILLED rows with non-trivial balance delta OR rows
    #               flagged execution.recoveredFromPhantom=true
    # Everything is signed so summing gives the total cost vs the collector's
    # zero-friction projection.
    print("\n=== Friction Budget ===")
    total_slippage = 0.0
    total_fees = 0.0
    phantom_count = 0
    phantom_loss = 0.0
    recovered_count = 0
    filled_count = 0
    total_expected = 0.0
    total_actual = 0.0

    for row in ledger_rows:
        execution = row.get("execution", {}) or {}
        status = execution.get("status")
        bb = row.get("balanceBefore")
        ba = row.get("balanceAfter")
        expected = row.get("expectedPnl", 0) or 0
        delta = (ba - bb) if isinstance(bb, (int, float)) and isinstance(ba, (int, float)) and bb > 0 and ba > 0 else None

        if execution.get("recoveredFromPhantom"):
            recovered_count += 1

        if status == "FILLED":
            filled_count += 1
            total_expected += expected
            if delta is not None:
                total_actual += delta
                # fees_gas = expected - actual; positive means live kept less than collector math
                total_fees += (expected - delta)
            # slippage vs collector T-30 ask
            slug = row.get("slug")
            collector = collector_by_slug.get(slug)
            if collector:
                snap = closest_snapshot(collector.get("snapshots") or [], 30)
                if snap is not None:
                    side = row.get("underdogSide")
                    if side in ("UP", "DOWN"):
                        _, col_ask = side_values(snap, side)
                        bot_fill = execution.get("fillPrice", 0) or 0
                        shares = execution.get("fillSize", 0) or 0
                        total_slippage += (bot_fill - col_ask) * shares
        elif status == "UNFILLED":
            if delta is not None and abs(delta) > 0.50:
                # Declared unfilled but wallet moved — real hidden impact.
                phantom_count += 1
                phantom_loss += delta
                if delta < 0:
                    total_actual += delta  # loss still counts against real PnL

    print(f"Filled trades:       {filled_count}")
    print(f"Recovered phantoms:  {recovered_count}   (false-positive UNFILLED auto-corrected)")
    print(f"Hidden phantoms:     {phantom_count}   (UNFILLED with balance anomaly)")
    print(f"Collector expected:  {fmt_dollars(total_expected)}   (sum of ledger expectedPnl for FILLED)")
    print(f"Wallet actual:       {fmt_dollars(total_actual)}   (sum of real balance deltas)")
    print(f"Live-vs-collector:   {fmt_dollars(total_actual - total_expected)}")
    print()
    print(f"  Breakdown of the gap:")
    print(f"    Fill slippage:   {fmt_dollars(-total_slippage)}   (bot fill vs collector T-30 ask × shares; neg = paid more)")
    print(f"    Fees + gas:      {fmt_dollars(-total_fees)}       (collector math - wallet on FILLED)")
    print(f"    Phantom loss:    {fmt_dollars(phantom_loss)}      (UNFILLED with balance move, not captured in expected)")
    if filled_count:
        per_trade = (total_actual - total_expected) / filled_count
        print(f"  Per-trade friction: {fmt_dollars(per_trade)}   over {filled_count} filled trades")


def fmt_dollars(x):
    if abs(x) < 0.005:
        x = 0.0  # collapse signed-zero and sub-cent noise to a clean 0
    sign = "+" if x > 0 else ("" if x < 0 else "")
    return f"{sign}${x:.2f}"


if __name__ == "__main__":
    main()
