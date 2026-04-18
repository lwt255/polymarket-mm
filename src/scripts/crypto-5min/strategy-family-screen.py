#!/usr/bin/env python3
"""
Streaming executable-first strategy family screen.

Purpose:
  Search broad strategy families on the full collector file without materializing
  every candidate trade in memory. The screen is intentionally anti-overfit:
  it favors diversified families that stay positive on train/test/recent splits
  under realistic delayed-fill assumptions.

Usage:
  python3 src/scripts/crypto-5min/strategy-family-screen.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")
DECISION_SECONDS = (33, 60, 120)
TAKER_CAPS = (0.75, 0.80, None)
SIDE_MODES = ("leader", "favorite", "follower", "underdog")


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


def empty_bucket() -> dict:
    return {
        "n": 0,
        "wins": 0,
        "pnl": 0.0,
        "fill_sum": 0.0,
        "cryptos": Counter(),
        "intervals": Counter(),
    }


def update_bucket(bucket: dict, crypto: str, interval: str, won: bool, pnl: float, fill_price: float) -> None:
    bucket["n"] += 1
    bucket["wins"] += 1 if won else 0
    bucket["pnl"] += pnl
    bucket["fill_sum"] += fill_price
    bucket["cryptos"][crypto] += 1
    bucket["intervals"][interval] += 1


def summarize(bucket: dict) -> dict | None:
    if bucket["n"] == 0:
        return None
    return {
        "n": bucket["n"],
        "wr": bucket["wins"] / bucket["n"],
        "avg": bucket["pnl"] / bucket["n"],
        "pnl": bucket["pnl"],
        "fill": bucket["fill_sum"] / bucket["n"],
        "cryptos": bucket["cryptos"],
        "intervals": bucket["intervals"],
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


def max_share(counter: Counter) -> float:
    total = sum(counter.values())
    if total == 0:
        return 0.0
    return max(counter.values()) / total


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

    aggregates = defaultdict(
        lambda: {
            "train": empty_bucket(),
            "test": empty_bucket(),
            "recent": empty_bucket(),
            "full": empty_bucket(),
        }
    )

    prev_resolutions = {crypto: "UNKNOWN" for crypto in CRYPTOS}
    current_end = None
    batch = []

    def flush(records: list[dict]) -> None:
        if not records:
            return

        for record in records:
            slug = record.get("slug", "")
            crypto = slug.split("-")[0].upper()
            if crypto not in CRYPTOS:
                continue

            interval = interval_from_slug(slug)
            if interval not in ("5m", "15m"):
                continue

            resolution = record.get("resolution")
            if resolution not in ("UP", "DOWN"):
                continue

            snaps = record.get("snapshots") or []
            interval_tag = f"interval_{interval}"

            for decision_sec in DECISION_SECONDS:
                decision_snap = closest_snapshot_at_or_after(snaps, decision_sec)
                fill_snap = closest_snapshot(snaps, 30)
                if decision_snap is None or fill_snap is None:
                    continue

                leader = bid_leader(decision_snap)
                if leader == "TIE":
                    continue
                favorite = mid_favorite(decision_snap)
                side_lookup = {
                    "leader": leader,
                    "favorite": favorite,
                    "follower": other_side(leader),
                    "underdog": other_side(favorite),
                }

                t60 = snapshot_in_window(snaps, 55, 70, 60)
                t120 = snapshot_in_window(snaps, 100, 140, 120)
                t240 = snapshot_in_window(snaps, 230, 250, 240)
                ts = (
                    parse_ts(decision_snap.get("timestamp"))
                    or parse_ts(record.get("marketEnd"))
                    or parse_ts(record.get("collectedAt"))
                )
                hour = ts.hour if ts else 0
                dow = ts.weekday() if ts else 0

                for side_mode, selected_side in side_lookup.items():
                    selected_bid, selected_ask, selected_bid_depth, selected_ask_depth = side_fields(
                        decision_snap, selected_side
                    )
                    opposite_bid, _, _, _ = side_fields(decision_snap, other_side(selected_side))
                    if not (0.03 < selected_ask < 0.97):
                        continue

                    shares_needed = math.floor(TRADE_SIZE / selected_ask)
                    if shares_needed < 1 or selected_ask_depth < shares_needed:
                        continue

                    _, fill_ask, _, _ = side_fields(fill_snap, selected_side)
                    if not (0.03 < fill_ask < 0.99):
                        continue

                    selected_move = None
                    if t120 is not None:
                        selected_bid_t120, _, _, _ = side_fields(t120, selected_side)
                        selected_move = selected_bid - selected_bid_t120

                    depth_ratio = None
                    if selected_ask_depth > 0:
                        depth_ratio = selected_bid_depth / selected_ask_depth

                    cross_same = sum(
                        1
                        for other_crypto, prev in prev_resolutions.items()
                        if other_crypto != crypto and prev == selected_side
                    )
                    leader_flip60 = (
                        t60 is not None and bid_leader(t60) != "TIE" and bid_leader(t60) != leader
                    )
                    leader_late_flip = (
                        t240 is not None and bid_leader(t240) != "TIE" and bid_leader(t240) != leader
                    )

                    feature_tags = (
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
                    )

                    for cap in TAKER_CAPS:
                        if cap is not None and fill_ask > cap:
                            continue

                        shares = math.floor(TRADE_SIZE / fill_ask)
                        if shares < 1:
                            continue
                        won = selected_side == resolution
                        pnl = shares * (1 - fill_ask) if won else -(shares * fill_ask)

                        base = f"d{decision_sec}_cap{cap if cap is not None else 'none'}_{side_mode}"
                        rule_names = [
                            "BASELINE",
                            interval_tag,
                            *feature_tags,
                            *[f"{interval_tag},{tag}" for tag in feature_tags],
                        ]

                        for rule_name in rule_names:
                            aggregate = aggregates[(base, rule_name)]
                            update_bucket(aggregate["full"], crypto, interval, won, pnl, fill_ask)
                            if ts is not None and ts < train_cut:
                                update_bucket(aggregate["train"], crypto, interval, won, pnl, fill_ask)
                            else:
                                update_bucket(aggregate["test"], crypto, interval, won, pnl, fill_ask)
                            if ts is not None and ts >= recent_cut:
                                update_bucket(aggregate["recent"], crypto, interval, won, pnl, fill_ask)

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

    rows = []
    for (base, rule_name), aggregate in aggregates.items():
        train_summary = summarize(aggregate["train"])
        test_summary = summarize(aggregate["test"])
        recent_summary = summarize(aggregate["recent"])
        full_summary = summarize(aggregate["full"])
        if not train_summary or not test_summary or not recent_summary or not full_summary:
            continue
        if train_summary["n"] < 100 or test_summary["n"] < 30 or recent_summary["n"] < 12:
            continue
        if train_summary["avg"] <= 0 or test_summary["avg"] <= 0:
            continue

        diversified = len(full_summary["cryptos"]) >= 2 and max_share(full_summary["cryptos"]) <= 0.70
        recent_positive = recent_summary["avg"] > 0
        rows.append(
            {
                "base": base,
                "rule": rule_name,
                "train": train_summary,
                "test": test_summary,
                "recent": recent_summary,
                "full": full_summary,
                "diversified": diversified,
                "recent_positive": recent_positive,
                "score": min(train_summary["avg"], test_summary["avg"]),
            }
        )

    rows.sort(key=lambda row: (row["score"], row["recent"]["avg"], row["full"]["avg"]), reverse=True)
    diversified_rows = [row for row in rows if row["diversified"]]
    robust_rows = [row for row in diversified_rows if row["recent_positive"]]

    print(json.dumps({"path": PATH, "count": count, "first": first_ts, "last": last_ts}, indent=2))

    print("\n=== Top Robust Diversified Families ===")
    for row in robust_rows[:20]:
        print(f"{row['base']:24s} rule=[{row['rule']}]")
        print(f"  train  {fmt(row['train'])}")
        print(f"  test   {fmt(row['test'])}")
        print(f"  recent {fmt(row['recent'])}")
        print(
            f"  full   {fmt(row['full'])} "
            f"cryptos={dict(row['full']['cryptos'])} "
            f"intervals={dict(row['full']['intervals'])}"
        )

    print("\n=== Top Diversified Families (Train/Test Positive) ===")
    for row in diversified_rows[:20]:
        print(f"{row['base']:24s} rule=[{row['rule']}] recent_positive={row['recent_positive']}")
        print(f"  train  {fmt(row['train'])}")
        print(f"  test   {fmt(row['test'])}")
        print(f"  recent {fmt(row['recent'])}")
        print(
            f"  full   {fmt(row['full'])} "
            f"cryptos={dict(row['full']['cryptos'])} "
            f"intervals={dict(row['full']['intervals'])}"
        )


if __name__ == "__main__":
    main()
