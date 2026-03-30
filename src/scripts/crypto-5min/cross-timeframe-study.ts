/**
 * Cross-Timeframe Arbitrage Study
 *
 * Checks: Are there pricing discrepancies between the 5-min, 15-min,
 * 1h, and 4h BTC markets on Polymarket?
 *
 * If the 5-min UP token is at 70c but the 1h DOWN token is at 40c,
 * that's a mispricing opportunity.
 *
 * Also monitors: do larger timeframe markets have wider spreads,
 * more volume, or slower MM repricing?
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/cross-timeframe-study.ts [numSamples]
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'cross-timeframe-results.json';

const TIMEFRAMES = ['5M', '15M', '1H', '4H'] as const;
type Timeframe = typeof TIMEFRAMES[number];

// Slug patterns for each timeframe
const SLUG_PATTERNS: Record<Timeframe, { prefix: string; intervalSec: number }> = {
    '5M':  { prefix: 'btc-updown-5m-',  intervalSec: 300 },
    '15M': { prefix: 'btc-updown-15m-', intervalSec: 900 },
    '1H':  { prefix: 'btc-updown-1h-',  intervalSec: 3600 },
    '4H':  { prefix: 'btc-updown-4h-',  intervalSec: 14400 },
};

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

interface MarketSnapshot {
    timeframe: Timeframe;
    slug: string;
    question: string;
    endTime: number;
    secondsLeft: number;
    volume: number;
    upBid: number;
    upAsk: number;
    upMid: number;
    upSpread: number;
    downBid: number;
    downAsk: number;
    downMid: number;
    downSpread: number;
    upBidSize: number;
    upAskSize: number;
    downBidSize: number;
    downAskSize: number;
    // Arb opportunities
    combinedBids: number; // upBid + downBid — if > 1, free money selling both
    combinedAsks: number; // upAsk + downAsk — if < 1, free money buying both
    arbSpread: number; // 1 - combinedAsks (positive = buy both for < $1)
}

async function getDetailedBook(tokenId: string): Promise<{
    bestBid: number; bestAsk: number; bidSize: number; askSize: number;
} | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (raw.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    return {
        bestBid: parseFloat(bids[0]?.price || '0'),
        bestAsk: parseFloat(asks[0]?.price || '1'),
        bidSize: parseFloat(bids[0]?.size || '0'),
        askSize: parseFloat(asks[0]?.size || '0'),
    };
}

async function findMarket(tf: Timeframe): Promise<any> {
    const { prefix, intervalSec } = SLUG_PATTERNS[tf];
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / intervalSec) * intervalSec;

    // Try current and next interval
    for (const ts of [rounded, rounded + intervalSec]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=${prefix}${ts}`);
        if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
            return data[0];
        }
    }
    return null;
}

async function snapshotMarket(tf: Timeframe): Promise<MarketSnapshot | null> {
    const market = await findMarket(tf);
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    if (tokenIds.length < 2) return null;

    const [upBook, downBook] = await Promise.all([
        getDetailedBook(tokenIds[0]),
        getDetailedBook(tokenIds[1]),
    ]);
    if (!upBook || !downBook) return null;

    const endTime = new Date(market.endDate).getTime();
    const secondsLeft = (endTime - Date.now()) / 1000;

    return {
        timeframe: tf,
        slug: market.slug,
        question: market.question,
        endTime,
        secondsLeft,
        volume: parseFloat(market.volume || '0'),
        upBid: upBook.bestBid,
        upAsk: upBook.bestAsk,
        upMid: (upBook.bestBid + upBook.bestAsk) / 2,
        upSpread: upBook.bestAsk - upBook.bestBid,
        downBid: downBook.bestBid,
        downAsk: downBook.bestAsk,
        downMid: (downBook.bestBid + downBook.bestAsk) / 2,
        downSpread: downBook.bestAsk - downBook.bestBid,
        upBidSize: upBook.bidSize,
        upAskSize: upBook.askSize,
        downBidSize: downBook.bidSize,
        downAskSize: downBook.askSize,
        combinedBids: upBook.bestBid + downBook.bestBid,
        combinedAsks: upBook.bestAsk + downBook.bestAsk,
        arbSpread: 1 - (upBook.bestAsk + downBook.bestAsk),
    };
}

interface SampleResult {
    index: number;
    timestamp: number;
    clPrice: number;
    snapshots: MarketSnapshot[];
    // Cross-timeframe analysis
    crossArbs: {
        tf1: Timeframe;
        tf2: Timeframe;
        tf1UpMid: number;
        tf2UpMid: number;
        midDiff: number; // difference in UP probability between timeframes
    }[];
}

async function takeSample(index: number, chainlink: ChainlinkFeed): Promise<SampleResult> {
    const snapshots: MarketSnapshot[] = [];

    // Snapshot all timeframes in parallel
    const results = await Promise.all(TIMEFRAMES.map(tf => snapshotMarket(tf)));

    for (const snap of results) {
        if (snap) snapshots.push(snap);
    }

    const clPrice = chainlink.getPrice();

    // Cross-timeframe comparison
    const crossArbs: SampleResult['crossArbs'] = [];
    for (let i = 0; i < snapshots.length; i++) {
        for (let j = i + 1; j < snapshots.length; j++) {
            crossArbs.push({
                tf1: snapshots[i].timeframe,
                tf2: snapshots[j].timeframe,
                tf1UpMid: snapshots[i].upMid,
                tf2UpMid: snapshots[j].upMid,
                midDiff: Math.abs(snapshots[i].upMid - snapshots[j].upMid),
            });
        }
    }

    // Print summary
    console.log(`\nSample ${index} | BTC: $${clPrice.toFixed(0)} | ${new Date().toLocaleTimeString()}`);
    for (const snap of snapshots) {
        const tf = snap.timeframe.padEnd(4);
        console.log(
            `  ${tf} | UP: ${(snap.upBid * 100).toFixed(0)}/${(snap.upAsk * 100).toFixed(0)}c (${(snap.upSpread * 100).toFixed(0)}c spread) | ` +
            `DOWN: ${(snap.downBid * 100).toFixed(0)}/${(snap.downAsk * 100).toFixed(0)}c | ` +
            `Bids sum: ${(snap.combinedBids * 100).toFixed(0)}c | Asks sum: ${(snap.combinedAsks * 100).toFixed(0)}c | ` +
            `Arb: ${(snap.arbSpread * 100).toFixed(1)}c | ` +
            `Vol: $${snap.volume.toFixed(0)} | ${snap.secondsLeft.toFixed(0)}s left`
        );
    }

    // Flag any interesting cross-timeframe discrepancies
    for (const arb of crossArbs) {
        if (arb.midDiff > 0.10) {
            console.log(`  *** ${arb.tf1} vs ${arb.tf2}: UP mid diff ${(arb.midDiff * 100).toFixed(0)}c ***`);
        }
    }

    // Flag any within-market arb (asks sum < $1)
    for (const snap of snapshots) {
        if (snap.arbSpread > 0) {
            console.log(`  *** ${snap.timeframe}: Buy both for ${(snap.combinedAsks * 100).toFixed(0)}c < $1! Arb = ${(snap.arbSpread * 100).toFixed(1)}c ***`);
        }
    }

    return { index, timestamp: Date.now(), clPrice, snapshots, crossArbs };
}

function printAnalysis(results: SampleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('CROSS-TIMEFRAME STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Samples: ${results.length}\n`);

    // Per-timeframe stats
    console.log('--- Per-Timeframe Averages ---');
    for (const tf of TIMEFRAMES) {
        const snaps = results.flatMap(r => r.snapshots.filter(s => s.timeframe === tf));
        if (snaps.length === 0) { console.log(`  ${tf}: No data`); continue; }

        const avgSpreadUp = snaps.reduce((s, x) => s + x.upSpread, 0) / snaps.length;
        const avgSpreadDown = snaps.reduce((s, x) => s + x.downSpread, 0) / snaps.length;
        const avgVol = snaps.reduce((s, x) => s + x.volume, 0) / snaps.length;
        const avgCombinedAsks = snaps.reduce((s, x) => s + x.combinedAsks, 0) / snaps.length;
        const avgCombinedBids = snaps.reduce((s, x) => s + x.combinedBids, 0) / snaps.length;
        const avgArbSpread = snaps.reduce((s, x) => s + x.arbSpread, 0) / snaps.length;
        const arbPositive = snaps.filter(s => s.arbSpread > 0).length;
        const avgUpBidSize = snaps.reduce((s, x) => s + x.upBidSize, 0) / snaps.length;

        console.log(
            `  ${tf.padEnd(4)} | ${snaps.length} samples | ` +
            `Spread: ${(avgSpreadUp * 100).toFixed(1)}c UP, ${(avgSpreadDown * 100).toFixed(1)}c DOWN | ` +
            `Asks sum: ${(avgCombinedAsks * 100).toFixed(1)}c | Bids sum: ${(avgCombinedBids * 100).toFixed(1)}c | ` +
            `Arb: ${(avgArbSpread * 100).toFixed(2)}c (${arbPositive} positive) | ` +
            `Vol: $${avgVol.toFixed(0)} | Depth: ${avgUpBidSize.toFixed(0)}`
        );
    }

    // Cross-timeframe mid differences
    console.log('\n--- Cross-Timeframe UP Mid Differences ---');
    const pairs = new Map<string, number[]>();
    for (const r of results) {
        for (const arb of r.crossArbs) {
            const key = `${arb.tf1}-${arb.tf2}`;
            if (!pairs.has(key)) pairs.set(key, []);
            pairs.get(key)!.push(arb.midDiff);
        }
    }
    for (const [key, diffs] of pairs) {
        const avg = diffs.reduce((a, b) => a + b, 0) / diffs.length;
        const max = Math.max(...diffs);
        const gt5c = diffs.filter(d => d > 0.05).length;
        const gt10c = diffs.filter(d => d > 0.10).length;
        console.log(
            `  ${key.padEnd(8)} | avg: ${(avg * 100).toFixed(1)}c | max: ${(max * 100).toFixed(0)}c | ` +
            `>5c: ${gt5c}/${diffs.length} (${(gt5c / diffs.length * 100).toFixed(0)}%) | ` +
            `>10c: ${gt10c}/${diffs.length} (${(gt10c / diffs.length * 100).toFixed(0)}%)`
        );
    }

    // Arb opportunities summary
    console.log('\n--- Within-Market Arb (asks < $1) ---');
    for (const tf of TIMEFRAMES) {
        const snaps = results.flatMap(r => r.snapshots.filter(s => s.timeframe === tf));
        const arbOps = snaps.filter(s => s.arbSpread > 0);
        if (arbOps.length > 0) {
            const avgArb = arbOps.reduce((s, x) => s + x.arbSpread, 0) / arbOps.length;
            console.log(`  ${tf}: ${arbOps.length}/${snaps.length} samples had arb (avg ${(avgArb * 100).toFixed(1)}c)`);
        } else {
            console.log(`  ${tf}: 0 arb opportunities`);
        }
    }
}

async function main() {
    const NUM_SAMPLES = parseInt(process.argv[2] || '100');
    const SAMPLE_INTERVAL = parseInt(process.argv[3] || '30'); // seconds between samples
    console.log(`=== Cross-Timeframe Study: ${NUM_SAMPLES} samples, every ${SAMPLE_INTERVAL}s ===`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    let results: SampleResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Resuming from ${results.length} existing results\n`);
        } catch {}
    }

    const startIndex = results.length;
    const remaining = NUM_SAMPLES - startIndex;
    if (remaining <= 0) { printAnalysis(results); return; }

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    for (let i = 0; i < remaining; i++) {
        const result = await takeSample(startIndex + i + 1, chainlink);
        results.push(result);
        writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));

        if (i < remaining - 1) {
            await new Promise(r => setTimeout(r, SAMPLE_INTERVAL * 1000));
        }
    }

    chainlink.disconnect();
    printAnalysis(results);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
