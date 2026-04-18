#!/usr/bin/env python3
"""
Stress-test shortlisted 15m executable families.

For a small set of candidate rule families, this script reports:
  - full / train / test / recent performance
  - weekly slice stability
  - pairwise overlap between the families' trade sets

Usage:
  python3 src/scripts/crypto-5min/strategy-family-stability.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0
DECISION_SEC = 33
TAKER_CAP = 0.75
SIDE_MODE = "leader"
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")


@dataclass(frozen=True)
class CandidateRule:
    name: str
    tags: tuple[str, ...]


CANDIDATES = (
    CandidateRule("baseline_15m", ("interval_15m",)),
    CandidateRule("late_flip", ("interval_15m", "leader_late_flip")),
    CandidateRule("cross_0", ("interval_15m", "cross_0")),
    CandidateRule("mom_up", ("interval_15m", "mom_up")),
    CandidateRule("weekday", ("interval_15m", "weekday")),
    CandidateRule("price_55_65", ("interval_15m", "price_55_65")),
    CandidateRule("prev_match", ("interval_15m", "prev_match")),
    CandidateRule("cross_2plus", ("interval_15m", "cross_2plus")),
)


def parse_ts(ts):
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        seconds = ts / 1000 if ts > 1e12 else ts
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def interval_from_slug(slug: str) -> str | None:
    for part in slug.split("-"):
        if part in ("5m", "15m"):
            return part
    return None


def bid_leader(snap: dict) -> str:
    up_bid = snap.get("upBid", 0) or 0
    down_bid = snap.get("downBid", 0) or 0
    if up_bid > down_bid:
        return "UP"
    if down_bid > up_bid:
        return "DOWN"
    return "TIE"


def mid_favorite(snap: dict) -> str:
    up_mid = snap.get("upMid", 0) or 0
    down_mid = snap.get("downMid", 0) or 0
    return "UP" if up_mid >= down_mid else "DOWN"


def other_side(side: str) -> str:
    return "DOWN" if side == "UP" else "UP"


def closest_snapshot_at_or_after(snaps: list[dict], target_sec: int) -> dict | None:
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


def closest_snapshot(snaps: list[dict], target_sec: int) -> dict | None:
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


def snapshot_in_window(snaps: list[dict], lo: int, hi: int, target: int) -> dict | None:
    best = None
    best_key = None
    for snap in snaps:
        sec = snap.get("secondsBeforeEnd")
        if not isinstance(sec, (int, float)) or sec < lo or sec > hi:
            continue
        key = abs(sec - target)
        if best_key is None or key < best_key:
            best = snap
            best_key = key
    return best


def side_fields(snap: dict, side: str) -> tuple[float, float, float, float]:
    if side == "UP":
        return (
            snap.get("upBid", 0) or 0,
            snap.get("upAsk", 1) or 1,
            snap.get("upBidDepth", 0) or 0,
            snap.get("upAskDepth", 0) or 0,
        )
    return (
        snap.get("downBid", 0) or 0,
        snap.get("downAsk", 1) or 1,
        snap.get("downBidDepth", 0) or 0,
        snap.get("downAskDepth", 0) or 0,
    )


def price_bucket(price: float) -> str:
    if price < 0.25:
        return "price_05_25"
    if price < 0.45:
        return "price_25_45"
    if price < 0.55:
        return "price_45_55"
    if price < 0.65:
        return "price_55_65"
    if price < 0.75:
        return "price_65_75"
    return "price_75_95"


def momentum_bucket(move: float | None) -> str:
    if move is None:
        return "mom_unknown"
    if move > 0.02:
        return "mom_up"
    if move < -0.02:
        return "mom_down"
    return "mom_flat"


def depth_bucket(ratio: float | None) -> str:
    if ratio is None:
        return "depth_unknown"
    if ratio >= 2.0:
        return "depth_strong"
    if ratio <= 0.7:
        return "depth_weak"
    return "depth_balanced"


def cross_bucket(count: int) -> str:
    return "cross_2plus" if count >= 2 else f"cross_{count}"


def summarize(rows: list[dict]) -> dict | None:
    if not rows:
        return None
    n = len(rows)
    pnl = sum(row["pnl"] for row in rows)
    wins = sum(1 for row in rows if row["won"])
    avg_fill = sum(row["fill_price"] for row in rows) / n
    return {
        "n": n,
        "wr": wins / n,
        "avg": pnl / n,
        "pnl": pnl,
        "fill": avg_fill,
        "cryptos": Counter(row["crypto"] for row in rows),
    }


def fmt(summary: dict | None) -> str:
    if summary is None:
        return "n=0"
    return (
        f"n={summary['n']:4d} "
        f"wr={summary['wr']*100:5.1f}% "
        f"avg={summary['avg']:+.3f}/tr "
        f"pnl={summary['pnl']:+.2f} "
        f"fill={summary['fill']:.3f}"
    )


def week_start(ts: datetime) -> datetime:
    return datetime(ts.year, ts.month, ts.day, tzinfo=timezone.utc) - timedelta(days=ts.weekday())


def build_trade(record: dict, prev_resolutions: dict[str, str]) -> dict | None:
    slug = record.get("slug", "")
    crypto = slug.split("-")[0].upper()
    if crypto not in CRYPTOS:
        return None

    interval = interval_from_slug(slug)
    if interval != "15m":
        return None

    resolution = record.get("resolution")
    if resolution not in ("UP", "DOWN"):
        return None

    snaps = record.get("snapshots") or []
    decision_snap = closest_snapshot_at_or_after(snaps, DECISION_SEC)
    fill_snap = closest_snapshot(snaps, 30)
    if decision_snap is None or fill_snap is None:
        return None

    leader = bid_leader(decision_snap)
    if leader == "TIE":
        return None
    favorite = mid_favorite(decision_snap)
    selected_side = leader if SIDE_MODE == "leader" else favorite

    selected_bid, selected_ask, selected_bid_depth, selected_ask_depth = side_fields(
        decision_snap, selected_side
    )
    opposite_bid, _, _, _ = side_fields(decision_snap, other_side(selected_side))
    if not (0.03 < selected_ask < 0.97):
        return None

    shares_needed = math.floor(TRADE_SIZE / selected_ask)
    if shares_needed < 1 or selected_ask_depth < shares_needed:
        return None

    _, fill_ask, _, _ = side_fields(fill_snap, selected_side)
    if not (0.03 < fill_ask < 0.99) or fill_ask > TAKER_CAP:
        return None

    shares = math.floor(TRADE_SIZE / fill_ask)
    if shares < 1:
        return None

    t60 = snapshot_in_window(snaps, 55, 70, 60)
    t120 = snapshot_in_window(snaps, 100, 140, 120)
    t240 = snapshot_in_window(snaps, 230, 250, 240)

    selected_move = None
    if t120 is not None:
        selected_bid_t120, _, _, _ = side_fields(t120, selected_side)
        selected_move = selected_bid - selected_bid_t120

    depth_ratio = None
    if selected_ask_depth > 0:
        depth_ratio = selected_bid_depth / selected_ask_depth

    ts = (
        parse_ts(decision_snap.get("timestamp"))
        or parse_ts(record.get("marketEnd"))
        or parse_ts(record.get("collectedAt"))
    )
    if ts is None:
        return None
    hour = ts.hour
    dow = ts.weekday()

    cross_same = sum(
        1
        for other_crypto, prev in prev_resolutions.items()
        if other_crypto != crypto and prev == selected_side
    )
    leader_flip60 = t60 is not None and bid_leader(t60) != "TIE" and bid_leader(t60) != leader
    leader_late_flip = t240 is not None and bid_leader(t240) != "TIE" and bid_leader(t240) != leader

    tags = {
        "interval_15m",
        price_bucket(selected_ask),
        momentum_bucket(selected_move),
        depth_bucket(depth_ratio),
        cross_bucket(cross_same),
        "prev_match" if prev_resolutions.get(crypto) == selected_side else "prev_miss",
        "us_eve" if (hour >= 18 or hour < 2) else "not_us_eve",
        "weekend" if dow >= 5 else "weekday",
        "leader_flip60" if leader_flip60 else "no_leader_flip60",
        "leader_late_flip" if leader_late_flip else "no_leader_late_flip",
        "selected_gt_opp_bid" if selected_bid > opposite_bid else "selected_lte_opp_bid",
    }

    won = selected_side == resolution
    pnl = shares * (1 - fill_ask) if won else -(shares * fill_ask)
    trade_id = f"{slug}|{record.get('marketEnd')}|{ts.isoformat()}"
    return {
        "id": trade_id,
        "slug": slug,
        "ts": ts,
        "crypto": crypto,
        "won": won,
        "pnl": pnl,
        "fill_price": fill_ask,
        "tags": frozenset(tags),
    }


def main() -> None:
    first_ts = None
    last_ts = None
    count = 0
    with open(PATH, "r") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            count += 1
            ts = record.get("collectedAt")
            if first_ts is None:
                first_ts = ts
            last_ts = ts

    last_dt = parse_ts(last_ts)
    if last_dt is None:
        raise RuntimeError("Could not determine collector end time")
    train_cut = last_dt - timedelta(days=7)
    recent_cut = last_dt - timedelta(days=3)

    trade_lists = {candidate.name: [] for candidate in CANDIDATES}
    trade_sets = {candidate.name: set() for candidate in CANDIDATES}

    prev_resolutions = {crypto: "UNKNOWN" for crypto in CRYPTOS}
    current_end = None
    batch = []

    def flush(records: list[dict]) -> None:
        if not records:
            return
        for record in records:
            trade = build_trade(record, prev_resolutions)
            if trade is None:
                continue
            for candidate in CANDIDATES:
                if all(tag in trade["tags"] for tag in candidate.tags):
                    trade_lists[candidate.name].append(trade)
                    trade_sets[candidate.name].add(trade["id"])
        for record in records:
            slug = record.get("slug", "")
            crypto = slug.split("-")[0].upper()
            if "-5m-" in slug and record.get("resolution") in ("UP", "DOWN") and crypto in prev_resolutions:
                prev_resolutions[crypto] = record["resolution"]

    with open(PATH, "r") as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            market_end = record.get("marketEnd")
            if current_end is None:
                current_end = market_end
            if market_end != current_end:
                flush(batch)
                batch = []
                current_end = market_end
            batch.append(record)
    flush(batch)

    print(json.dumps({"path": PATH, "count": count, "first": first_ts, "last": last_ts}, indent=2))

    print("\n=== Candidate Stability ===")
    for candidate in CANDIDATES:
        rows = trade_lists[candidate.name]
        train = [row for row in rows if row["ts"] < train_cut]
        test = [row for row in rows if row["ts"] >= train_cut]
        recent = [row for row in rows if row["ts"] >= recent_cut]
        weekly = defaultdict(list)
        for row in rows:
            weekly[week_start(row["ts"])].append(row)
        weekly_summaries = []
        for start, week_rows in sorted(weekly.items()):
            summary = summarize(week_rows)
            if summary is not None:
                weekly_summaries.append((start, summary))

        positive_weeks = sum(1 for _, summary in weekly_summaries if summary["avg"] > 0)
        negative_weeks = sum(1 for _, summary in weekly_summaries if summary["avg"] <= 0)
        worst_week = min(weekly_summaries, key=lambda item: item[1]["avg"]) if weekly_summaries else None
        best_week = max(weekly_summaries, key=lambda item: item[1]["avg"]) if weekly_summaries else None
        last_four = weekly_summaries[-4:]

        print(f"{candidate.name:14s} tags={candidate.tags}")
        print(f"  full   {fmt(summarize(rows))}")
        print(f"  train  {fmt(summarize(train))}")
        print(f"  test   {fmt(summarize(test))}")
        print(f"  recent {fmt(summarize(recent))}")
        print(
            f"  weeks  total={len(weekly_summaries)} positive={positive_weeks} negative={negative_weeks}"
        )
        if worst_week is not None and best_week is not None:
            print(
                f"  range  worst={worst_week[0].date()} {fmt(worst_week[1])} "
                f"best={best_week[0].date()} {fmt(best_week[1])}"
            )
        if last_four:
            recent_week_line = " | ".join(
                f"{start.date()} {summary['avg']:+.3f}/tr n={summary['n']}"
                for start, summary in last_four
            )
            print(f"  last4  {recent_week_line}")

    print("\n=== Pairwise Overlap ===")
    for i, left in enumerate(CANDIDATES):
        for right in CANDIDATES[i + 1 :]:
            left_set = trade_sets[left.name]
            right_set = trade_sets[right.name]
            overlap = left_set & right_set
            union = left_set | right_set
            jaccard = (len(overlap) / len(union)) if union else 0.0
            left_in_right = (len(overlap) / len(left_set)) if left_set else 0.0
            right_in_left = (len(overlap) / len(right_set)) if right_set else 0.0
            print(
                f"{left.name:14s} vs {right.name:14s} "
                f"overlap={len(overlap):4d} "
                f"jaccard={jaccard:5.1%} "
                f"{left.name}_in_{right.name}={left_in_right:5.1%} "
                f"{right.name}_in_{left.name}={right_in_left:5.1%}"
            )


if __name__ == "__main__":
    main()
