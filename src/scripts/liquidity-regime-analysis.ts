/**
 * Liquidity regime analysis for collector data.
 *
 * Focuses on tradability and late one-sided collapse:
 * - when markets first become tradable
 * - when they first become effectively one-sided
 * - whether they are still two-sided at T-120 / T-90 / T-60
 * - how T-120 underdog strategy results change across those regimes
 *
 * Usage: npx tsx src/scripts/liquidity-regime-analysis.ts [pricing-data.raw.jsonl]
 */

import { readFileSync } from 'node:fs';
import {
    findOneSidedSnapshotInWindow,
    findTradableSnapshotInWindow,
    findTwoSidedSnapshotInWindow,
    getLiquidityProfile,
    isStrategyUsableT120,
    type LiquidityProfile,
    type PricingRecordLike,
} from './pricing-data-utils.js';

const INPUT = process.argv[2] || 'pricing-data.raw.jsonl';
const POS_SIZE = 50;
const TAKER_FEE_RATE = 0.001;
const GAS_COST = 1.00;

interface Snapshot {
    secondsBeforeEnd: number;
    upBid: number;
    upAsk: number;
    upSpread?: number;
    upBidDepth?: number;
    downBid: number;
    downAsk: number;
    downSpread?: number;
    downBidDepth?: number;
    upMid: number;
    downMid: number;
}

interface SimulatedTrade {
    snapshotSecBefore: number;
    side: 'UP' | 'DOWN';
    entryAsk: number;
    won: boolean;
    favoriteImpliedProb: number;
}

interface MarketRecord extends PricingRecordLike {
    slug: string;
    resolution: 'UP' | 'DOWN' | 'UNKNOWN';
    snapshots: Snapshot[];
    simulatedTrades?: SimulatedTrade[];
    liquidityProfile?: LiquidityProfile;
}

function loadRecords(path: string): MarketRecord[] {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return [];

    return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
}

function pct(n: number, d: number): string {
    return d === 0 ? 'N/A' : `${(n / d * 100).toFixed(1)}%`;
}

function firstTimeBucket(secondsBeforeEnd: number | null): string {
    if (secondsBeforeEnd === null) return 'Never';
    if (secondsBeforeEnd >= 210) return 'T-210 or earlier';
    if (secondsBeforeEnd >= 180) return 'T-180 to T-209';
    if (secondsBeforeEnd >= 150) return 'T-150 to T-179';
    if (secondsBeforeEnd >= 120) return 'T-120 to T-149';
    if (secondsBeforeEnd >= 90) return 'T-90 to T-119';
    if (secondsBeforeEnd >= 60) return 'T-60 to T-89';
    if (secondsBeforeEnd >= 30) return 'T-30 to T-59';
    return 'Later than T-30';
}

function collapseBucket(secondsBeforeEnd: number | null): string {
    if (secondsBeforeEnd === null) return 'Never one-sided in sample';
    if (secondsBeforeEnd >= 110) return 'Already one-sided by T-120';
    if (secondsBeforeEnd >= 80) return 'Collapses between T-120 and T-90';
    if (secondsBeforeEnd >= 50) return 'Collapses between T-90 and T-60';
    return 'Still two-sided through T-60';
}

function getWindowState(snapshots: Snapshot[], minSeconds: number, maxSeconds: number): 'two-sided' | 'one-sided' | 'not-tradable' {
    if (findTwoSidedSnapshotInWindow(snapshots, minSeconds, maxSeconds)) return 'two-sided';
    if (findOneSidedSnapshotInWindow(snapshots, minSeconds, maxSeconds)) return 'one-sided';
    if (findTradableSnapshotInWindow(snapshots, minSeconds, maxSeconds)) return 'one-sided';
    return 'not-tradable';
}

function getT120Trade(record: MarketRecord): SimulatedTrade | undefined {
    return (record.simulatedTrades || []).find((trade) => trade.snapshotSecBefore >= 110 && trade.snapshotSecBefore <= 130);
}

function fixedSizePnl(trade: SimulatedTrade): number {
    const shares = POS_SIZE / trade.entryAsk;
    const cost = POS_SIZE + POS_SIZE * TAKER_FEE_RATE + GAS_COST;
    const payout = trade.won ? shares * 1.0 : 0;
    return payout - cost;
}

function printBucketCounts(title: string, counts: Map<string, number>, total: number, orderedLabels: string[]) {
    console.log(`\n${title}`);
    for (const label of orderedLabels) {
        const count = counts.get(label) ?? 0;
        console.log(`  ${label}: ${count} (${pct(count, total)})`);
    }
}

function evaluateTrades(label: string, records: MarketRecord[]) {
    let wins = 0;
    let pnl = 0;
    let trades = 0;
    let totalEntryAsk = 0;
    let totalFavoriteProb = 0;

    for (const record of records) {
        const trade = getT120Trade(record);
        if (!trade) continue;

        trades++;
        if (trade.won) wins++;
        pnl += fixedSizePnl(trade);
        totalEntryAsk += trade.entryAsk;
        totalFavoriteProb += trade.favoriteImpliedProb;
    }

    if (trades === 0) {
        console.log(`  ${label}: no T-120 trades`);
        return;
    }

    const losses = trades - wins;
    const avgPnl = pnl / trades;
    const roi = pnl / (POS_SIZE * trades) * 100;
    const avgEntryAsk = totalEntryAsk / trades * 100;
    const avgFavoriteProb = totalFavoriteProb / trades * 100;
    console.log(`  ${label}: ${wins}W/${losses}L (${pct(wins, trades)}) | $${pnl.toFixed(2)} total | $${avgPnl.toFixed(2)}/trade | ${roi.toFixed(1)}% ROI | avg ask ${avgEntryAsk.toFixed(1)}¢ | avg fav ${avgFavoriteProb.toFixed(1)}% | n=${trades}`);
}

const records = loadRecords(INPUT);
const resolved = records.filter((record) => record.resolution !== 'UNKNOWN');
const strategyUsable = resolved.filter(isStrategyUsableT120);

console.log(`Loaded ${records.length} raw records from ${INPUT}`);
console.log(`Resolved markets: ${resolved.length}`);
console.log(`Strategy-usable T-120 markets: ${strategyUsable.length}`);

const tradableCounts = new Map<string, number>();
const oneSidedCounts = new Map<string, number>();
for (const record of resolved) {
    const profile = getLiquidityProfile(record);
    tradableCounts.set(firstTimeBucket(profile.earliestTradableSecondsBeforeEnd), (tradableCounts.get(firstTimeBucket(profile.earliestTradableSecondsBeforeEnd)) ?? 0) + 1);
    oneSidedCounts.set(collapseBucket(profile.earliestOneSidedSecondsBeforeEnd), (oneSidedCounts.get(collapseBucket(profile.earliestOneSidedSecondsBeforeEnd)) ?? 0) + 1);
}

printBucketCounts(
    'First Tradable Quote',
    tradableCounts,
    resolved.length,
    ['T-210 or earlier', 'T-180 to T-209', 'T-150 to T-179', 'T-120 to T-149', 'T-90 to T-119', 'T-60 to T-89', 'T-30 to T-59', 'Later than T-30', 'Never'],
);

printBucketCounts(
    'First One-Sided Quote',
    oneSidedCounts,
    resolved.length,
    ['Already one-sided by T-120', 'Collapses between T-120 and T-90', 'Collapses between T-90 and T-60', 'Still two-sided through T-60', 'Never one-sided in sample'],
);

console.log('\nState At Key Windows');
for (const [label, minSeconds, maxSeconds] of [
    ['T-120', 110, 130],
    ['T-90', 80, 100],
    ['T-60', 50, 70],
] as const) {
    let twoSided = 0;
    let oneSided = 0;
    let notTradable = 0;

    for (const record of resolved) {
        const state = getWindowState(record.snapshots, minSeconds, maxSeconds);
        if (state === 'two-sided') twoSided++;
        else if (state === 'one-sided') oneSided++;
        else notTradable++;
    }

    console.log(`  ${label}: two-sided ${twoSided} (${pct(twoSided, resolved.length)}) | one-sided ${oneSided} (${pct(oneSided, resolved.length)}) | not tradable ${notTradable} (${pct(notTradable, resolved.length)})`);
}

console.log('\nT-120 Strategy Results By Entry State');
evaluateTrades('All T-120 trades', strategyUsable);
evaluateTrades(
    'T-120 still two-sided',
    strategyUsable.filter((record) => getWindowState(record.snapshots, 110, 130) === 'two-sided'),
);
evaluateTrades(
    'T-120 already one-sided',
    strategyUsable.filter((record) => getWindowState(record.snapshots, 110, 130) === 'one-sided'),
);

console.log('\nT-120 Strategy Results By Collapse Timing');
evaluateTrades(
    'Already one-sided by T-120',
    strategyUsable.filter((record) => getLiquidityProfile(record).earliestOneSidedSecondsBeforeEnd !== null && getLiquidityProfile(record).earliestOneSidedSecondsBeforeEnd! >= 110),
);
evaluateTrades(
    'Collapses between T-120 and T-90',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestOneSidedSecondsBeforeEnd;
        return sec !== null && sec >= 80 && sec < 110;
    }),
);
evaluateTrades(
    'Collapses between T-90 and T-60',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestOneSidedSecondsBeforeEnd;
        return sec !== null && sec >= 50 && sec < 80;
    }),
);
evaluateTrades(
    'Still two-sided through T-60',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestOneSidedSecondsBeforeEnd;
        return sec === null || sec < 50;
    }),
);

console.log('\nT-120 Strategy Results By First Tradable Time');
evaluateTrades(
    'Tradable by T-210 or earlier',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestTradableSecondsBeforeEnd;
        return sec !== null && sec >= 210;
    }),
);
evaluateTrades(
    'First tradable between T-180 and T-149',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestTradableSecondsBeforeEnd;
        return sec !== null && sec >= 150 && sec < 210;
    }),
);
evaluateTrades(
    'First tradable between T-120 and T-89',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestTradableSecondsBeforeEnd;
        return sec !== null && sec >= 90 && sec < 150;
    }),
);
evaluateTrades(
    'First tradable after T-90',
    strategyUsable.filter((record) => {
        const sec = getLiquidityProfile(record).earliestTradableSecondsBeforeEnd;
        return sec !== null && sec < 90;
    }),
);
