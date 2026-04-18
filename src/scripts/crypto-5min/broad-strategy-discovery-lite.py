#!/usr/bin/env python3
"""
Faster broad executable strategy discovery.

Keeps the search broad across different strategy families, but limits rule
depth to get an answer quickly on the full VPS collector file.
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
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")
DECISION_SECONDS = (33, 60)
TAKER_CAPS = (0.75, None)
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
    return "UP" if up_mid >= down_mid else "DOWN"


def closest_snapshot_at_or_after(snaps, target_sec):
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float)) and s["secondsBeforeEnd"] >= target_sec]
    if not candidates:
        return None
    return min(candidates, key=lambda s: (s["secondsBeforeEnd"] - target_sec, abs(s["secondsBeforeEnd"] - target_sec)))


def closest_snapshot(snaps, target_sec):
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float))]
    if not candidates:
        return None
    return min(candidates, key=lambda s: (abs(s["secondsBeforeEnd"] - target_sec), 0 if s["secondsBeforeEnd"] >= target_sec else 1, s["secondsBeforeEnd"]))


def snapshot_in_window(snaps, lo, hi, target):
    candidates = [s for s in snaps if isinstance(s.get("secondsBeforeEnd"), (int, float)) and lo <= s["secondsBeforeEnd"] <= hi]
    if not candidates:
        return None
    return min(candidates, key=lambda s: abs(s["secondsBeforeEnd"] - target))


def other_side(side):
    return "DOWN" if side == "UP" else "UP"


def side_fields(snap, side):
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


def price_bucket(price):
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


def momentum_bucket(move):
    if move is None:
        return "mom_unknown"
    if move > 0.02:
        return "mom_up"
    if move < -0.02:
        return "mom_down"
    return "mom_flat"


def depth_bucket(ratio):
    if ratio is None:
        return "depth_unknown"
    if ratio >= 2.0:
        return "depth_strong"
    if ratio <= 0.7:
        return "depth_weak"
    return "depth_balanced"


def cross_bucket(count):
    return "cross_2plus" if count >= 2 else f"cross_{count}"


@dataclass
class Candidate:
    base: str
    collected_at: datetime
    crypto: str
    interval: str
    pnl: float
    won: bool
    fill_price: float
    tags: frozenset[str]


def build_candidate(record, prev_resolutions, decision_sec, taker_cap, side_mode):
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

    selected_side = {
        "leader": leader,
        "follower": follower,
        "favorite": favorite,
        "underdog": underdog,
    }[side_mode]

    selected_bid, selected_ask, selected_bid_depth, selected_ask_depth = side_fields(decision_snap, selected_side)
    opposite_bid, _, _, _ = side_fields(decision_snap, other_side(selected_side))
    if not (0.03 < selected_ask < 0.97):
        return None
    shares_needed = math.floor(TRADE_SIZE / selected_ask)
    if shares_needed < 1 or selected_ask_depth < shares_needed:
        return None

    _, fill_ask, _, _ = side_fields(fill_snap, selected_side)
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
    leader_late_flip = t240 is not None and bid_leader(t240) != "TIE" and bid_leader(t240) != leader
    selected_move = None
    if t120 is not None:
        selected_bid_t120, _, _, _ = side_fields(t120, selected_side)
        selected_move = selected_bid - selected_bid_t120

    depth_ratio = None
    if selected_ask_depth > 0:
        depth_ratio = selected_bid_depth / selected_ask_depth

    ts = parse_ts(decision_snap.get("timestamp")) or parse_ts(record.get("marketEnd")) or parse_ts(record.get("collectedAt"))
    hour = ts.hour if ts else 0
    dow = ts.weekday() if ts else 0

    tags = frozenset(
        {
            f"interval_{interval}",
            price_bucket(selected_ask),
            momentum_bucket(selected_move),
            depth_bucket(depth_ratio),
            cross_bucket(cross_same),
            "prev_match" if prev_match else "prev_miss",
            "us_eve" if (hour >= 18 or hour < 2) else "not_us_eve",
            "weekend" if dow >= 5 else "weekday",
            "leader_flip60" if leader_flip60 else "no_leader_flip60",
            "leader_late_flip" if leader_late_flip else "no_leader_late_flip",
            "selected_gt_opp_bid" if selected_bid > opposite_bid else "selected_lte_opp_bid",
        }
    )

    return Candidate(
        base=f"d{decision_sec}_cap{taker_cap if taker_cap is not None else 'none'}_{side_mode}",
        collected_at=ts,
        crypto=crypto,
        interval=interval,
        pnl=pnl,
        won=(selected_side == resolution),
        fill_price=fill_ask,
        tags=tags,
    )


def summarize(candidates):
    n = len(candidates)
    if n == 0:
        return None
    wins = sum(1 for c in candidates if c.won)
    pnl = sum(c.pnl for c in candidates)
    fill = sum(c.fill_price for c in candidates) / n
    return {
        "n": n,
        "wr": wins / n,
        "avg": pnl / n,
        "pnl": pnl,
        "fill": fill,
        "crypto_counts": Counter(c.crypto for c in candidates),
        "interval_counts": Counter(c.interval for c in candidates),
    }


def fmt(summary):
    if summary is None:
        return "n=0"
    return f"n={summary['n']:4d} wr={summary['wr']*100:5.1f}% avg={summary['avg']:+.3f}/tr pnl={summary['pnl']:+.2f} fill={summary['fill']:.3f}"


def max_share(counter):
    total = sum(counter.values())
    return 0 if total == 0 else max(counter.values()) / total


def main():
    by_base = defaultdict(list)
    prev_resolutions = {crypto: "UNKNOWN" for crypto in CRYPTOS}
    current_end = None
    batch = []
    first_ts = None
    last_ts = None
    count = 0

    def flush(records):
        if not records:
            return
        for record in records:
            for decision_sec in DECISION_SECONDS:
                for cap in TAKER_CAPS:
                    for side_mode in SIDE_MODES:
                        candidate = build_candidate(record, prev_resolutions, decision_sec, cap, side_mode)
                        if candidate is not None:
                            by_base[candidate.base].append(candidate)
        for record in records:
            slug = record.get("slug", "")
            crypto = slug.split("-")[0].upper()
            if "-5m-" in slug and record.get("resolution") in ("UP", "DOWN") and crypto in prev_resolutions:
                prev_resolutions[crypto] = record["resolution"]

    with open(PATH) as handle:
        for line in handle:
            if not line.strip():
                continue
            record = json.loads(line)
            count += 1
            ts = record.get("collectedAt")
            if first_ts is None:
                first_ts = ts
            last_ts = ts
            end = record.get("marketEnd")
            if current_end is None:
                current_end = end
            if end != current_end:
                flush(batch)
                batch = []
                current_end = end
            batch.append(record)
    flush(batch)

    last_dt = parse_ts(last_ts)
    train_cut = last_dt - timedelta(days=7)
    recent_cut = last_dt - timedelta(days=3)

    print(json.dumps({"path": PATH, "count": count, "first": first_ts, "last": last_ts}, indent=2))

    rows = []
    for base, candidates in by_base.items():
        tag_vocab = sorted({tag for c in candidates for tag in c.tags})
        interval_tags = [tag for tag in tag_vocab if tag.startswith("interval_")]
        feature_tags = [tag for tag in tag_vocab if not tag.startswith("interval_")]
        rule_sets = [tuple(), *[(tag,) for tag in feature_tags], *[(itag, ftag) for itag in interval_tags for ftag in feature_tags]]

        for rules in rule_sets:
            selected = [c for c in candidates if all(rule in c.tags for rule in rules)]
            train = [c for c in selected if c.collected_at < train_cut]
            test = [c for c in selected if c.collected_at >= train_cut]
            recent = [c for c in selected if c.collected_at >= recent_cut]
            train_s = summarize(train)
            test_s = summarize(test)
            recent_s = summarize(recent)
            full_s = summarize(selected)
            if not train_s or not test_s or not recent_s or not full_s:
                continue
            if train_s["n"] < 100 or test_s["n"] < 30 or recent_s["n"] < 12:
                continue
            if train_s["avg"] <= 0 or test_s["avg"] <= 0:
                continue
            diversified = len(full_s["crypto_counts"]) >= 2 and max_share(full_s["crypto_counts"]) <= 0.70
            rows.append(
                {
                    "base": base,
                    "rules": rules,
                    "train": train_s,
                    "test": test_s,
                    "recent": recent_s,
                    "full": full_s,
                    "diversified": diversified,
                    "score": min(train_s["avg"], test_s["avg"]),
                }
            )

    rows.sort(key=lambda row: (row["score"], row["recent"]["avg"], row["full"]["avg"]), reverse=True)
    diversified_rows = [row for row in rows if row["diversified"]]

    print("\n=== Top Diversified Strategies ===")
    for row in diversified_rows[:15]:
        rules = ",".join(row["rules"]) if row["rules"] else "BASELINE"
        print(f"{row['base']:22s} rules=[{rules}]")
        print(f"  train  {fmt(row['train'])}")
        print(f"  test   {fmt(row['test'])}")
        print(f"  recent {fmt(row['recent'])}")
        print(f"  full   {fmt(row['full'])} cryptos={dict(row['full']['crypto_counts'])} intervals={dict(row['full']['interval_counts'])}")

    print("\n=== Top Raw Strategies ===")
    for row in rows[:15]:
        rules = ",".join(row["rules"]) if row["rules"] else "BASELINE"
        print(f"{row['base']:22s} rules=[{rules}] diversified={row['diversified']}")
        print(f"  train  {fmt(row['train'])}")
        print(f"  test   {fmt(row['test'])}")
        print(f"  recent {fmt(row['recent'])}")
        print(f"  full   {fmt(row['full'])} cryptos={dict(row['full']['crypto_counts'])} intervals={dict(row['full']['interval_counts'])}")


if __name__ == "__main__":
    main()
