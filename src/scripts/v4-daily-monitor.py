#!/usr/bin/env python3
"""
v4 daily edge monitor — Layer 1 from v4-scaling-plan.md

Runs v4-sim logic against yesterday's (or specified date's) collector data
and appends a single JSON row to monitoring/v4-daily.jsonl.

Designed to be called daily via cron after midnight UTC.

Usage:
  python3 src/scripts/v4-daily-monitor.py                    # yesterday
  python3 src/scripts/v4-daily-monitor.py 2026-04-09         # specific date
  python3 src/scripts/v4-daily-monitor.py --all              # backfill all dates
"""
import json
import sys
import os
from collections import defaultdict
from datetime import datetime, timezone, timedelta

DATA_PATH = os.environ.get("V4_DATA_PATH", "pricing-data.jsonl")
OUTPUT_DIR = os.environ.get("V4_MONITOR_DIR", "monitoring")
TRADE_SIZE = 10.0

# Baseline from v4-scaling-plan.md
BASELINE_WR = 0.676
BASELINE_PER_TRADE = 0.78  # maker fill expected
BASELINE_DAILY_PNL = 31.0

def closest_snap(snaps, target):
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
    if side == "UP":
        return snap.get("upAskDepth", 0) or 0
    return snap.get("downAskDepth", 0) or 0

def run_sim_for_date(target_date):
    """Run v4 sim for a single date, return result dict."""
    date_str = target_date.isoformat()
    trades = []
    considered = 0
    rejected_reasons = defaultdict(int)
    records_total = 0

    with open(DATA_PATH, "r") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Check date
            slug = rec.get("slug", "")
            parts = slug.rsplit("-", 1)
            if len(parts) != 2:
                continue
            try:
                epoch = int(parts[1])
            except ValueError:
                continue
            ts = datetime.fromtimestamp(epoch, tz=timezone.utc)
            if ts.date() != target_date:
                continue

            records_total += 1
            snaps = rec.get("snapshots") or []
            if not snaps:
                continue

            s30 = closest_snap(snaps, 30)
            s120 = closest_snap(snaps, 120)
            if s30 is None or s120 is None:
                rejected_reasons["no_t30_or_t120"] += 1
                continue
            if abs(s30.get("secondsBeforeEnd", 999) - 30) > 25:
                rejected_reasons["t30_too_far"] += 1
                continue
            if abs(s120.get("secondsBeforeEnd", 999) - 120) > 40:
                rejected_reasons["t120_too_far"] += 1
                continue

            considered += 1

            upBid = s30.get("upBid", 0); upAsk = s30.get("upAsk", 0)
            downBid = s30.get("downBid", 0); downAsk = s30.get("downAsk", 0)

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

            if not (0.54 <= leaderAsk < 0.75):
                rejected_reasons["zone"] += 1
                continue
            if not (followerBid >= 0.05 and 0.03 < leaderAsk < 0.97):
                rejected_reasons["two_sided"] += 1
                continue
            if not (leaderBid > leaderBid120):
                rejected_reasons["not_rising"] += 1
                continue
            depth = leader_ask_depth(s30, leader_side)
            if depth < TRADE_SIZE / max(leaderAsk, 0.01):
                rejected_reasons["thin"] += 1
                continue

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
                "slug": slug,
                "leader": leader_side,
                "ask": leaderAsk,
                "outcome": outcome,
                "pnl": pnl,
            })

    n = len(trades)
    wins = sum(1 for t in trades if t["outcome"] == "W")
    total_pnl = sum(t["pnl"] for t in trades)
    wr = wins / n if n else 0
    per_trade = total_pnl / n if n else 0

    # Compute rolling stats against baseline
    wr_diff_pp = (wr - BASELINE_WR) * 100 if n else None
    per_trade_pct = (per_trade / BASELINE_PER_TRADE * 100) if n else None

    # Flag: Yellow if >1.5 SD off, Red if >2.5 SD off
    # Per-trade std dev ~$7.77, per-day ~$49 (40 trades)
    flag = "GREEN"
    if n >= 10:
        expected_wr_sd = (BASELINE_WR * (1 - BASELINE_WR) / n) ** 0.5
        wr_z = (wr - BASELINE_WR) / expected_wr_sd if expected_wr_sd > 0 else 0
        if abs(wr_z) > 2.5:
            flag = "RED"
        elif abs(wr_z) > 1.5:
            flag = "YELLOW"

    result = {
        "date": date_str,
        "records": records_total,
        "considered": considered,
        "trades": n,
        "wins": wins,
        "losses": n - wins,
        "win_rate": round(wr, 4),
        "total_pnl": round(total_pnl, 2),
        "per_trade": round(per_trade, 2),
        "wr_diff_pp": round(wr_diff_pp, 2) if wr_diff_pp is not None else None,
        "per_trade_pct_of_baseline": round(per_trade_pct, 1) if per_trade_pct is not None else None,
        "flag": flag,
        "rejected": dict(rejected_reasons),
    }

    return result

def main():
    target_date = None
    backfill = False

    if len(sys.argv) > 1:
        if sys.argv[1] == "--all":
            backfill = True
        else:
            target_date = datetime.strptime(sys.argv[1], "%Y-%m-%d").date()

    if target_date is None and not backfill:
        target_date = (datetime.now(timezone.utc) - timedelta(days=1)).date()

    os.makedirs(OUTPUT_DIR, exist_ok=True)
    output_path = os.path.join(OUTPUT_DIR, "v4-daily.jsonl")

    # Load existing dates to avoid duplicates
    existing_dates = set()
    if os.path.exists(output_path):
        with open(output_path, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    existing_dates.add(rec.get("date"))
                except:
                    pass

    if backfill:
        # Find all dates in the data
        dates_in_data = set()
        with open(DATA_PATH, "r") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                    slug = rec.get("slug", "")
                    parts = slug.rsplit("-", 1)
                    if len(parts) == 2:
                        epoch = int(parts[1])
                        ts = datetime.fromtimestamp(epoch, tz=timezone.utc)
                        dates_in_data.add(ts.date())
                except:
                    pass
        dates_to_run = sorted(d for d in dates_in_data if d.isoformat() not in existing_dates)
    else:
        dates_to_run = [target_date] if target_date.isoformat() not in existing_dates else []

    results = []
    for d in dates_to_run:
        r = run_sim_for_date(d)
        results.append(r)

    # Append results
    if results:
        with open(output_path, "a") as f:
            for r in results:
                f.write(json.dumps(r) + "\n")
        print(f"Wrote {len(results)} rows to {output_path}")
        for r in results:
            flag_str = f" [{r['flag']}]" if r['flag'] != "GREEN" else ""
            print(f"  {r['date']}: {r['trades']} trades, {100*r['win_rate']:.1f}% WR, ${r['total_pnl']:+.2f} P&L, ${r['per_trade']:+.2f}/trade{flag_str}")
    else:
        if backfill:
            print(f"All dates already in {output_path}, nothing to backfill")
        else:
            # Re-run for the target date (overwrite)
            r = run_sim_for_date(target_date)
            print(f"  {r['date']}: {r['trades']} trades, {100*r['win_rate']:.1f}% WR, ${r['total_pnl']:+.2f} P&L, ${r['per_trade']:+.2f}/trade [{r['flag']}]")
            print(f"  (date already in {output_path}, printed but not appended)")

if __name__ == "__main__":
    main()
