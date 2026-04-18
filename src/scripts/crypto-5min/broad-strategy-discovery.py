#!/usr/bin/env python3
"""
Broad executable strategy discovery on collector data.

Searches materially different rule families under realistic execution:
  - side choice: leader, follower, favorite, underdog
  - decision timing: T-33, T-60, T-120
  - executable fill at T-30
  - optional taker cap
  - rule conjunctions over price, momentum, flips, depth, time, and interval

Strategies are ranked by out-of-sample performance, with diversification guards
to avoid collapsing into single-token overfits.

Usage:
  python3 src/scripts/crypto-5min/broad-strategy-discovery.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import itertools
import json
import math
import sys
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")
DECISION_SECONDS = (33, 60, 120)
TAKER_CAPS = (0.75, 0.80, None)
SIDE_MODES = ("leader", "follower", "favorite", "underdog")


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
    if up_mid >= down_mid:
        return "UP"
    return "DOWN"


def closest_snapshot_at_or_after(snaps: list[dict], target_sec: int) -> dict | None:
    candidates = [
        snap
        for snap in snaps
        if isinstance(snap.get("secondsBeforeEnd"), (int, float))
        and snap["secondsBeforeEnd"] >= target_sec
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda snap: (
            snap["secondsBeforeEnd"] - target_sec,
            abs(snap["secondsBeforeEnd"] - target_sec),
        ),
    )


def closest_snapshot(snaps: list[dict], target_sec: int) -> dict | None:
    candidates = [
        snap
        for snap in snaps
        if isinstance(snap.get("secondsBeforeEnd"), (int, float))
    ]
    if not candidates:
        return None
    return min(
        candidates,
        key=lambda snap: (
            abs(snap["secondsBeforeEnd"] - target_sec),
            0 if snap["secondsBeforeEnd"] >= target_sec else 1,
            snap["secondsBeforeEnd"],
        ),
    )


def snapshot_in_window(snaps: list[dict], lo: int, hi: int, target: int) -> dict | None:
    candidates = [
        snap
        for snap in snaps
        if isinstance(snap.get("secondsBeforeEnd"), (int, float))
        and lo <= snap["secondsBeforeEnd"] <= hi
    ]
    if not candidates:
        return None
    return min(candidates, key=lambda snap: abs(snap["secondsBeforeEnd"] - target))


def other_side(side: str) -> str:
    return "DOWN" if side == "UP" else "UP"


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
    if price < 0.15:
        return "price_05_15"
    if price < 0.25:
        return "price_15_25"
    if price < 0.35:
        return "price_25_35"
    if price < 0.45:
        return "price_35_45"
    if price < 0.55:
        return "price_45_55"
    if price < 0.65:
        return "price_55_65"
    if price < 0.75:
        return "price_65_75"
    if price < 0.85:
        return "price_75_85"
    return "price_85_95"


def spread_bucket(spread: float) -> str:
    if spread <= 0.01:
        return "spread_tight"
    if spread <= 0.03:
        return "spread_medium"
    return "spread_wide"


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
    if count >= 2:
        return "cross_2plus"
    return f"cross_{count}"


@dataclass
class Candidate:
    base_name: str
    collected_at: datetime
    crypto: str
    interval: str
    pnl: float
    won: bool
    fill_price: float
    tags: frozenset[str]


def build_candidate(
    record: dict,
    prev_resolutions: dict[str, str],
    decision_sec: int,
    taker_cap: float | None,
    side_mode: str,
) -> Candidate | None:
    slug = record.get("slug", "")
    crypto = slug.split("-")[0].upper()
    if crypto not in CRYPTOS:
        return None

    interval = interval_from_slug(slug)
    if interval not in ("5m", "15m"):
        return None

    resolution = record.get("resolution")
    if resolution not in ("UP", "DOWN"):
        return None

    snaps = record.get("snapshots") or []
    decision_snap = closest_snapshot_at_or_after(snaps, decision_sec)
    fill_snap = closest_snapshot(snaps, 30)
    if decision_snap is None or fill_snap is None:
        return None

    leader = bid_leader(decision_snap)
    if leader == "TIE":
        return None
    follower = other_side(leader)
    favorite = mid_favorite(decision_snap)
    underdog = other_side(favorite)

    if side_mode == "leader":
        selected_side = leader
    elif side_mode == "follower":
        selected_side = follower
    elif side_mode == "favorite":
        selected_side = favorite
    elif side_mode == "underdog":
        selected_side = underdog
    else:
        raise ValueError(side_mode)

    selected_bid, selected_ask, selected_bid_depth, selected_ask_depth = side_fields(decision_snap, selected_side)
    opposite_bid, _, _, _ = side_fields(decision_snap, other_side(selected_side))

    if not (0.03 < selected_ask < 0.97):
        return None
    shares_needed = math.floor(TRADE_SIZE / selected_ask)
    if shares_needed < 1:
        return None
    if selected_ask_depth < shares_needed:
        return None

    fill_bid, fill_ask, _, _ = side_fields(fill_snap, selected_side)
    if not (0.03 < fill_ask < 0.99):
        return None
    if taker_cap is not None and fill_ask > taker_cap:
        return None

    shares = math.floor(TRADE_SIZE / fill_ask)
    if shares < 1:
        return None
    pnl = shares * (1 - fill_ask) if selected_side == resolution else -(shares * fill_ask)

    t60 = snapshot_in_window(snaps, 55, 70, 60)
    t120 = snapshot_in_window(snaps, 100, 140, 120)
    t240 = snapshot_in_window(snaps, 230, 250, 240)
    prev_match = prev_resolutions.get(crypto) == selected_side
    cross_same = sum(1 for c, res in prev_resolutions.items() if c != crypto and res == selected_side)

    leader_flip60 = t60 is not None and bid_leader(t60) != "TIE" and bid_leader(t60) != leader
    leader_odd_flips = t60 is not None and t120 is not None and bid_leader(t60) != bid_leader(t120)
    leader_late_flip = t240 is not None and bid_leader(t240) != "TIE" and bid_leader(t240) != leader

    selected_move = None
    selected_accel = None
    if t120 is not None:
        selected_bid_t120, _, _, _ = side_fields(t120, selected_side)
        selected_move = selected_bid - selected_bid_t120
    if t60 is not None and t120 is not None:
        selected_bid_t60, _, _, _ = side_fields(t60, selected_side)
        selected_bid_t120, _, _, _ = side_fields(t120, selected_side)
        selected_accel = ((selected_bid - selected_bid_t60) - (selected_bid_t60 - selected_bid_t120)) > 0.02

    depth_ratio = None
    if selected_ask_depth > 0:
        depth_ratio = selected_bid_depth / selected_ask_depth

    ts = parse_ts(decision_snap.get("timestamp")) or parse_ts(record.get("marketEnd")) or parse_ts(record.get("collectedAt"))
    hour = ts.hour if ts else 0
    dow = ts.weekday() if ts else 0

    tags = {
        f"interval_{interval}",
        price_bucket(selected_ask),
        spread_bucket(max(selected_ask - selected_bid, 0)),
        momentum_bucket(selected_move),
        depth_bucket(depth_ratio),
        cross_bucket(cross_same),
        "prev_match" if prev_match else "prev_miss",
        "us_eve" if (hour >= 18 or hour < 2) else "not_us_eve",
        "weekend" if dow >= 5 else "weekday",
        "leader_flip60" if leader_flip60 else "no_leader_flip60",
        "leader_odd_flips" if leader_odd_flips else "no_leader_odd_flips",
        "leader_late_flip" if leader_late_flip else "no_leader_late_flip",
        "selected_accel" if selected_accel else "selected_not_accel",
        "selected_above_opp_bid" if selected_bid > opposite_bid else "selected_not_above_opp_bid",
    }

    base_name = f"d{decision_sec}_cap{taker_cap if taker_cap is not None else 'none'}_{side_mode}"
    return Candidate(
        base_name=base_name,
        collected_at=ts or parse_ts(record.get("collectedAt")) or datetime.now(timezone.utc),
        crypto=crypto,
        interval=interval,
        pnl=pnl,
        won=(selected_side == resolution),
        fill_price=fill_ask,
        tags=frozenset(tags),
    )


def summarize(candidates: list[Candidate]) -> dict | None:
    n = len(candidates)
    if n == 0:
        return None
    wins = sum(1 for candidate in candidates if candidate.won)
    pnl = sum(candidate.pnl for candidate in candidates)
    avg_fill = sum(candidate.fill_price for candidate in candidates) / n
    crypto_counts = Counter(candidate.crypto for candidate in candidates)
    interval_counts = Counter(candidate.interval for candidate in candidates)
    return {
        "n": n,
        "wr": wins / n,
        "avg": pnl / n,
        "pnl": pnl,
        "avg_fill": avg_fill,
        "crypto_counts": crypto_counts,
        "interval_counts": interval_counts,
    }


def fmt_summary(summary: dict | None) -> str:
    if summary is None:
        return "n=0"
    return (
        f"n={summary['n']:4d} "
        f"wr={summary['wr']*100:5.1f}% "
        f"avg={summary['avg']:+.3f}/tr "
        f"pnl={summary['pnl']:+.2f} "
        f"fill={summary['avg_fill']:.3f}"
    )


def max_share(counter: Counter) -> float:
    total = sum(counter.values())
    if total == 0:
        return 0.0
    return max(counter.values()) / total


def main() -> None:
    by_base: dict[str, list[Candidate]] = defaultdict(list)
    prev_resolutions = {crypto: "UNKNOWN" for crypto in CRYPTOS}
    current_end = None
    batch: list[dict] = []
    last_ts = None
    first_ts = None
    record_count = 0

    def flush_batch(records: list[dict]) -> None:
        if not records:
            return
        for record in records:
            for decision_sec in DECISION_SECONDS:
                for cap in TAKER_CAPS:
                    for side_mode in SIDE_MODES:
                        candidate = build_candidate(record, prev_resolutions, decision_sec, cap, side_mode)
                        if candidate is not None:
                            by_base[candidate.base_name].append(candidate)

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
            record_count += 1
            ts = record.get("collectedAt")
            if first_ts is None:
                first_ts = ts
            last_ts = ts
            market_end = record.get("marketEnd")
            if current_end is None:
                current_end = market_end
            if market_end != current_end:
                flush_batch(batch)
                batch = []
                current_end = market_end
            batch.append(record)
    flush_batch(batch)

    last_dt = parse_ts(last_ts)
    if last_dt is None:
        raise RuntimeError("Could not determine collector end time")

    train_cut = last_dt - timedelta(days=7)
    recent_cut = last_dt - timedelta(days=3)

    print(json.dumps({"path": PATH, "count": record_count, "first": first_ts, "last": last_ts}, indent=2))

    ranked_rows = []
    for base_name, candidates in by_base.items():
        tag_vocab = sorted({tag for candidate in candidates for tag in candidate.tags})

        candidate_rule_sets = [tuple()] + [(tag,) for tag in tag_vocab]
        candidate_rule_sets += [
            combo
            for combo in itertools.combinations(tag_vocab, 2)
            if len({tag.split("_", 1)[0] for tag in combo}) == len(combo)
        ]

        for rule_tags in candidate_rule_sets:
            selected = [
                candidate
                for candidate in candidates
                if all(tag in candidate.tags for tag in rule_tags)
            ]
            if not selected:
                continue

            train = [candidate for candidate in selected if candidate.collected_at < train_cut]
            test = [candidate for candidate in selected if candidate.collected_at >= train_cut]
            recent = [candidate for candidate in selected if candidate.collected_at >= recent_cut]

            train_summary = summarize(train)
            test_summary = summarize(test)
            recent_summary = summarize(recent)
            full_summary = summarize(selected)
            if train_summary is None or test_summary is None or recent_summary is None or full_summary is None:
                continue

            if train_summary["n"] < 80 or test_summary["n"] < 25 or recent_summary["n"] < 10:
                continue
            if train_summary["avg"] <= 0 or test_summary["avg"] <= 0:
                continue

            diversified = (
                len(full_summary["crypto_counts"]) >= 2
                and max_share(full_summary["crypto_counts"]) <= 0.70
            )

            ranked_rows.append(
                {
                    "base": base_name,
                    "rules": rule_tags,
                    "train": train_summary,
                    "test": test_summary,
                    "recent": recent_summary,
                    "full": full_summary,
                    "diversified": diversified,
                    "score": min(train_summary["avg"], test_summary["avg"]),
                }
            )

    diversified_rows = [row for row in ranked_rows if row["diversified"]]
    diversified_rows.sort(key=lambda row: (row["score"], row["recent"]["avg"], row["full"]["avg"]), reverse=True)
    ranked_rows.sort(key=lambda row: (row["score"], row["recent"]["avg"], row["full"]["avg"]), reverse=True)

    print("\n=== Top Diversified Strategies (Train/Test Positive) ===")
    for row in diversified_rows[:20]:
        rules = ",".join(row["rules"]) if row["rules"] else "BASELINE"
        print(f"{row['base']:22s} rules=[{rules}]")
        print(f"  train  {fmt_summary(row['train'])}")
        print(f"  test   {fmt_summary(row['test'])}")
        print(f"  recent {fmt_summary(row['recent'])}")
        print(f"  full   {fmt_summary(row['full'])} cryptos={dict(row['full']['crypto_counts'])} intervals={dict(row['full']['interval_counts'])}")

    print("\n=== Top Raw Strategies (May Be Narrower) ===")
    for row in ranked_rows[:20]:
        rules = ",".join(row["rules"]) if row["rules"] else "BASELINE"
        print(f"{row['base']:22s} rules=[{rules}] diversified={row['diversified']}")
        print(f"  train  {fmt_summary(row['train'])}")
        print(f"  test   {fmt_summary(row['test'])}")
        print(f"  recent {fmt_summary(row['recent'])}")
        print(f"  full   {fmt_summary(row['full'])} cryptos={dict(row['full']['crypto_counts'])} intervals={dict(row['full']['interval_counts'])}")


if __name__ == "__main__":
    main()
