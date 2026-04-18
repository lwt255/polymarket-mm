#!/usr/bin/env python3
"""
Executable edge study for the current v4 filter stack.

Purpose:
  Quantify which levers actually close the gap between decision-time edge and
  executable edge under realistic fill assumptions.

This script:
  - Replays the current bot filter stack with no lookahead
  - Sweeps decision timing, fill timing, taker cap, interval subset, and crypto subset
  - Reports which scenarios retain edge after delayed fills

Usage:
  python3 src/scripts/crypto-5min/executable-edge-study.py /path/to/pricing-data.jsonl
"""

from __future__ import annotations

import itertools
import json
import math
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Iterable

PATH = sys.argv[1] if len(sys.argv) > 1 else "pricing-data.jsonl"
TRADE_SIZE = 10.0
CRYPTOS = ("BTC", "ETH", "SOL", "XRP")
INTERVALS = ("5m", "15m")


def parse_ts(ts: str | int | float | None) -> datetime | None:
    if ts is None:
        return None
    if isinstance(ts, (int, float)):
        seconds = ts / 1000 if ts > 1e12 else ts
        return datetime.fromtimestamp(seconds, tz=timezone.utc)
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))


def interval_from_slug(slug: str) -> str | None:
    for part in slug.split("-"):
        if part in INTERVALS:
            return part
    return None


def side_from_snapshot(snap: dict) -> str:
    up_bid = snap.get("upBid", 0) or 0
    down_bid = snap.get("downBid", 0) or 0
    if up_bid > down_bid:
        return "UP"
    if down_bid > up_bid:
        return "DOWN"
    return "TIE"


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


@dataclass(frozen=True)
class Scenario:
    decision_sec: int
    fill_sec: int
    cap: float | None
    intervals: tuple[str, ...]
    cryptos: tuple[str, ...]
    name: str


@dataclass
class Trade:
    collected_at: datetime
    interval: str
    crypto: str
    pnl: float
    won: bool
    fill_price: float


def powerset(items: tuple[str, ...]) -> Iterable[tuple[str, ...]]:
    for size in range(1, len(items) + 1):
        yield from itertools.combinations(items, size)


def current_v4_trade(
    record: dict,
    prev_resolutions: dict[str, str],
    decision_sec: int,
    fill_sec: int,
    taker_cap: float | None,
) -> Trade | None:
    slug = record.get("slug", "")
    crypto = slug.split("-")[0].upper()
    if crypto not in CRYPTOS:
        return None

    interval = interval_from_slug(slug)
    if interval not in INTERVALS:
        return None

    resolution = record.get("resolution")
    if resolution not in ("UP", "DOWN"):
        return None

    snaps = record.get("snapshots") or []
    decision_snap = closest_snapshot_at_or_after(snaps, decision_sec)
    if decision_snap is None:
        return None

    leader_side = side_from_snapshot(decision_snap)
    if leader_side == "TIE":
        return None

    t60 = snapshot_in_window(snaps, 55, 70, 60)
    t120 = snapshot_in_window(snaps, 100, 140, 120)
    t240 = snapshot_in_window(snaps, 230, 250, 240)

    leader_bid = decision_snap["upBid"] if leader_side == "UP" else decision_snap["downBid"]
    leader_ask = decision_snap["upAsk"] if leader_side == "UP" else decision_snap["downAsk"]
    follower_bid = decision_snap["downBid"] if leader_side == "UP" else decision_snap["upBid"]
    leader_ask_depth = decision_snap.get("upAskDepth", 0) if leader_side == "UP" else decision_snap.get("downAskDepth", 0)
    leader_bid_depth = decision_snap.get("upBidDepth", 0) if leader_side == "UP" else decision_snap.get("downBidDepth", 0)

    flip60 = t60 is not None and side_from_snapshot(t60) != "TIE" and side_from_snapshot(t60) != leader_side
    odd_flips = t60 is not None and t120 is not None and side_from_snapshot(t60) != side_from_snapshot(t120)

    ts = parse_ts(decision_snap.get("timestamp")) or parse_ts(record.get("marketEnd")) or parse_ts(record.get("collectedAt"))
    hour = ts.hour if ts else 0
    dow = ts.weekday() if ts else 0
    is_us_eve = hour >= 18 or hour < 2
    is_weekend = dow >= 5
    cross_same = sum(1 for c, res in prev_resolutions.items() if c != crypto and res == leader_side)

    sweet_zone = (0.55 <= leader_ask < 0.60) or (0.68 <= leader_ask <= 0.75)
    accelerating = False
    if t60 is not None and t120 is not None:
        leader_bid_t60 = t60["upBid"] if leader_side == "UP" else t60["downBid"]
        leader_bid_t120 = t120["upBid"] if leader_side == "UP" else t120["downBid"]
        accelerating = ((leader_bid - leader_bid_t60) - (leader_bid_t60 - leader_bid_t120)) > 0.02
    strong_depth = leader_ask_depth > 0 and (leader_bid_depth / leader_ask_depth) >= 2.0
    late_flip = t240 is not None and side_from_snapshot(t240) != "TIE" and side_from_snapshot(t240) != leader_side

    signal_count = sum(
        [
            flip60,
            odd_flips,
            is_us_eve,
            cross_same >= 2,
            is_weekend,
            sweet_zone,
            accelerating,
            strong_depth,
            late_flip,
        ]
    )

    if not (follower_bid >= 0.05 and 0.03 < leader_ask < 0.97):
        return None
    if leader_ask < 0.54 or leader_ask >= 0.75:
        return None
    if 0.60 <= leader_ask < 0.65:
        return None
    if signal_count < 2:
        return None
    if crypto == "BTC" and 0.65 <= leader_ask < 0.75:
        return None

    shares_needed = math.floor(TRADE_SIZE / leader_ask)
    if leader_ask_depth < shares_needed:
        return None

    fill_snap = closest_snapshot(snaps, fill_sec)
    if fill_snap is None:
        return None
    fill_price = fill_snap["upAsk"] if leader_side == "UP" else fill_snap["downAsk"]
    if taker_cap is not None and fill_price > taker_cap:
        return None

    shares = math.floor(TRADE_SIZE / fill_price)
    if shares < 1:
        return None
    pnl = shares * (1 - fill_price) if leader_side == resolution else -(shares * fill_price)

    return Trade(
        collected_at=parse_ts(record.get("collectedAt")) or ts,
        interval=interval,
        crypto=crypto,
        pnl=pnl,
        won=(leader_side == resolution),
        fill_price=fill_price,
    )


def summarize(trades: list[Trade]) -> dict:
    n = len(trades)
    if n == 0:
        return {"n": 0}
    wins = sum(1 for trade in trades if trade.won)
    pnl = sum(trade.pnl for trade in trades)
    avg_fill = sum(trade.fill_price for trade in trades) / n
    return {
        "n": n,
        "wr": wins / n,
        "pnl": pnl,
        "avg": pnl / n,
        "avg_fill": avg_fill,
    }


def fmt_summary(summary: dict) -> str:
    if summary["n"] == 0:
        return "n=0"
    return (
        f"n={summary['n']:4d} "
        f"wr={summary['wr']*100:5.1f}% "
        f"avg={summary['avg']:+.3f}/tr "
        f"pnl={summary['pnl']:+.2f} "
        f"fill={summary['avg_fill']:.3f}"
    )


def build_scenarios() -> list[Scenario]:
    scenarios: list[Scenario] = []

    decision_fill_pairs = [
        (33, 33),
        (33, 32),
        (33, 31),
        (33, 30),
        (40, 30),
        (45, 30),
        (60, 30),
        (120, 30),
    ]
    caps = [None, 0.75, 0.77, 0.80]
    interval_sets = [("5m", "15m"), ("5m",), ("15m",)]

    for decision_sec, fill_sec in decision_fill_pairs:
        for cap in caps:
            for intervals in interval_sets:
                scenarios.append(
                    Scenario(
                        decision_sec=decision_sec,
                        fill_sec=fill_sec,
                        cap=cap,
                        intervals=intervals,
                        cryptos=CRYPTOS,
                        name=f"d{decision_sec}_f{fill_sec}_cap{cap if cap is not None else 'none'}_{'+'.join(intervals)}_ALL",
                    )
                )

    for cryptos in powerset(CRYPTOS):
        scenarios.append(
            Scenario(
                decision_sec=33,
                fill_sec=30,
                cap=0.75,
                intervals=("5m", "15m"),
                cryptos=cryptos,
                name=f"d33_f30_cap075_5m+15m_{'+'.join(cryptos)}",
            )
        )
        scenarios.append(
            Scenario(
                decision_sec=33,
                fill_sec=30,
                cap=0.75,
                intervals=("5m",),
                cryptos=cryptos,
                name=f"d33_f30_cap075_5m_{'+'.join(cryptos)}",
            )
        )

    return scenarios


def main() -> None:
    scenarios = build_scenarios()
    trades_by_scenario: dict[str, list[Trade]] = {scenario.name: [] for scenario in scenarios}

    prev_resolutions = {crypto: "UNKNOWN" for crypto in CRYPTOS}
    current_end = None
    batch: list[dict] = []
    first_ts = None
    last_ts = None
    record_count = 0

    def flush_batch(records: list[dict]) -> None:
        if not records:
            return
        for record in records:
            for scenario in scenarios:
                trade = current_v4_trade(
                    record=record,
                    prev_resolutions=prev_resolutions,
                    decision_sec=scenario.decision_sec,
                    fill_sec=scenario.fill_sec,
                    taker_cap=scenario.cap,
                )
                if trade is None:
                    continue
                if trade.interval not in scenario.intervals:
                    continue
                if trade.crypto not in scenario.cryptos:
                    continue
                trades_by_scenario[scenario.name].append(trade)

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

    print(json.dumps({"path": PATH, "count": record_count, "first": first_ts, "last": last_ts}, indent=2))

    ranked = []
    for scenario in scenarios:
        summary = summarize(trades_by_scenario[scenario.name])
        ranked.append((scenario, summary))

    print("\n=== Top Executable Scenarios ===")
    for scenario, summary in sorted(ranked, key=lambda item: item[1].get("avg", float("-inf")), reverse=True)[:20]:
        print(f"{scenario.name:45s} {fmt_summary(summary)}")

    print("\n=== Speed Sensitivity (All Cryptos, Current Filter Stack) ===")
    for scenario, summary in ranked:
        if scenario.cryptos != CRYPTOS:
            continue
        if scenario.intervals not in (("5m", "15m"), ("5m",), ("15m",)):
            continue
        if scenario.cap not in (None, 0.75):
            continue
        if scenario.name.startswith(("d33_", "d40_", "d45_", "d60_", "d120_")):
            print(f"{scenario.name:45s} {fmt_summary(summary)}")

    print("\n=== Current Live Window Focus ===")
    live_start = datetime.fromisoformat("2026-04-15T23:24:30+00:00")
    live_end = datetime.fromisoformat("2026-04-17T15:23:36+00:00")
    for scenario, _ in ranked:
        if scenario.name not in (
            "d33_f33_capnone_5m+15m_ALL",
            "d33_f30_capnone_5m+15m_ALL",
            "d33_f30_cap0.75_5m+15m_ALL",
            "d33_f30_cap0.75_5m_ALL",
            "d33_f30_cap0.75_15m_ALL",
        ):
            continue
        window_trades = [
            trade
            for trade in trades_by_scenario[scenario.name]
            if live_start <= trade.collected_at <= live_end
        ]
        print(f"{scenario.name:45s} {fmt_summary(summarize(window_trades))}")


if __name__ == "__main__":
    main()
