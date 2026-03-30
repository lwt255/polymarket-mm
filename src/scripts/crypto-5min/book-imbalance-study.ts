/**
 * Book Imbalance & Flow Signal Study
 *
 * Tests whether order book imbalance predicts direction:
 *   - Bid depth vs ask depth on UP token
 *   - Last trade direction (buy vs sell pressure)
 *   - Rate of mid-price change (momentum)
 *   - Combined signals
 *
 * Also tests a "delayed entry" straddle: wait 60-120s into the candle
 * for the first oscillation, THEN place the straddle centered on current mid.
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/book-imbalance-study.ts [numCandles]
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'book-imbalance-results.json';

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
            return data[0];
        }
    }
    return null;
}

interface FullBook {
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
    bestBid: number;
    bestAsk: number;
    mid: number;
    totalBidDepth: number;
    totalAskDepth: number;
    bidDepth5c: number; // depth within 5c of best bid
    askDepth5c: number; // depth within 5c of best ask
    imbalance: number;  // (bidDepth - askDepth) / (bidDepth + askDepth), -1 to +1
}

async function getFullBook(tokenId: string): Promise<FullBook | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;

    const bids = (raw.bids || [])
        .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || [])
        .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price || 0;
    const bestAsk = asks[0]?.price || 1;
    const mid = (bestBid + bestAsk) / 2;

    const totalBidDepth = bids.reduce((s: number, b: any) => s + b.size, 0);
    const totalAskDepth = asks.reduce((s: number, a: any) => s + a.size, 0);
    const bidDepth5c = bids.filter((b: any) => b.price >= bestBid - 0.05).reduce((s: number, b: any) => s + b.size, 0);
    const askDepth5c = asks.filter((a: any) => a.price <= bestAsk + 0.05).reduce((s: number, a: any) => s + a.size, 0);

    const total = totalBidDepth + totalAskDepth;
    const imbalance = total > 0 ? (totalBidDepth - totalAskDepth) / total : 0;

    return { bids, asks, bestBid, bestAsk, mid, totalBidDepth, totalAskDepth, bidDepth5c, askDepth5c, imbalance };
}

async function getLastTrade(tokenId: string): Promise<{ price: number; side: string } | null> {
    const data = await fetchJSON(`${CLOB}/last-trade-price?token_id=${tokenId}`);
    if (!data) return null;
    return { price: parseFloat(data.price || '0'), side: data.side || 'unknown' };
}

interface Snapshot {
    secondsInto: number; // seconds into candle
    secondsLeft: number;
    upMid: number;
    downMid: number;
    upImbalance: number;
    downImbalance: number;
    upBidDepth: number;
    upAskDepth: number;
    clPrice: number;
    clMove: number;
    lastTradePrice: number;
    lastTradeSide: string;
    // Mid velocity: change from previous snapshot
    midVelocity: number;
}

interface CandleResult {
    index: number;
    timestamp: number;
    question: string;
    actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openClPrice: number;
    closeClPrice: number;
    snapshots: Snapshot[];
    // Delayed entry straddle simulation
    delayedStraddles: {
        entrySecond: number; // how many seconds into candle we entered
        entryMid: number;
        // Did mid oscillate enough after entry for both sides to fill?
        highMidAfter: number; // highest mid AFTER entry
        lowMidAfter: number;  // lowest mid AFTER entry
        rangeAfter: number;
        bothFill2c: boolean;
        bothFill3c: boolean;
        bothFill4c: boolean;
    }[];
    // Imbalance-based direction prediction
    imbalancePredictions: {
        secondsInto: number;
        imbalanceSignal: 'UP' | 'DOWN'; // positive imbalance = more bids = bullish
        correct: boolean;
    }[];
}

async function monitorCandle(index: number, chainlink: ChainlinkFeed): Promise<CandleResult | null> {
    const market = await findCurrentMarket();
    if (!market) { console.log(`  Candle ${index}: No market`); return null; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    if (!upToken || !downToken) return null;

    const endTime = new Date(market.endDate).getTime();
    const startTime = endTime - 300000;
    console.log(`  Candle ${index}: ${market.question}`);

    const openClPrice = chainlink.getPrice();
    if (openClPrice <= 0) return null;

    const snapshots: Snapshot[] = [];
    let prevMid = 0;

    while (true) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;
        const secondsInto = 300 - secondsLeft;
        if (secondsLeft < -2) break;

        const [upBook, downBook, lastTrade] = await Promise.all([
            getFullBook(upToken),
            getFullBook(downToken),
            getLastTrade(upToken),
        ]);

        if (upBook && downBook) {
            const clPrice = chainlink.getPrice();
            const midVelocity = prevMid > 0 ? upBook.mid - prevMid : 0;
            prevMid = upBook.mid;

            snapshots.push({
                secondsInto,
                secondsLeft,
                upMid: upBook.mid,
                downMid: downBook.mid,
                upImbalance: upBook.imbalance,
                downImbalance: downBook.imbalance,
                upBidDepth: upBook.totalBidDepth,
                upAskDepth: upBook.totalAskDepth,
                clPrice,
                clMove: clPrice - openClPrice,
                lastTradePrice: lastTrade?.price || 0,
                lastTradeSide: lastTrade?.side || 'unknown',
                midVelocity,
            });

            // Log every ~30 seconds
            if (snapshots.length % 15 === 1) {
                const imbDir = upBook.imbalance > 0.05 ? 'BID-HEAVY' : upBook.imbalance < -0.05 ? 'ASK-HEAVY' : 'BALANCED';
                console.log(
                    `    ${secondsInto.toFixed(0)}s in | Mid: ${(upBook.mid * 100).toFixed(0)}c | ` +
                    `Imb: ${(upBook.imbalance * 100).toFixed(0)}% ${imbDir} | ` +
                    `Depth: ${upBook.totalBidDepth.toFixed(0)}b/${upBook.totalAskDepth.toFixed(0)}a | ` +
                    `CL: ${chainlink.getPrice() >= openClPrice ? '+' : ''}$${(clPrice - openClPrice).toFixed(0)}`
                );
            }
        }

        await new Promise(r => setTimeout(r, 2000));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 8000));
    const closeClPrice = chainlink.getPrice();
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
    if (prices[0] >= 0.95) actualOutcome = 'UP';
    else if (prices[1] >= 0.95) actualOutcome = 'DOWN';
    else if (closeClPrice >= openClPrice) actualOutcome = 'UP';
    else actualOutcome = 'DOWN';

    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Simulate delayed entry straddles
    const delayedStraddles: CandleResult['delayedStraddles'] = [];
    for (const entrySecond of [0, 30, 60, 90, 120, 150, 180]) {
        const entrySnap = snapshots.find(s => s.secondsInto >= entrySecond);
        if (!entrySnap) continue;

        const afterEntry = snapshots.filter(s => s.secondsInto > entrySnap.secondsInto);
        if (afterEntry.length < 5) continue;

        const midsAfter = afterEntry.map(s => s.upMid);
        const highMidAfter = Math.max(...midsAfter);
        const lowMidAfter = Math.min(...midsAfter);
        const rangeAfter = highMidAfter - lowMidAfter;

        // Check if straddle at entry mid would both-fill
        const entryMid = entrySnap.upMid;
        const bothFill2c = lowMidAfter <= entryMid - 0.015 && highMidAfter >= entryMid + 0.015;
        const bothFill3c = lowMidAfter <= entryMid - 0.025 && highMidAfter >= entryMid + 0.025;
        const bothFill4c = lowMidAfter <= entryMid - 0.035 && highMidAfter >= entryMid + 0.035;

        delayedStraddles.push({
            entrySecond,
            entryMid,
            highMidAfter,
            lowMidAfter,
            rangeAfter,
            bothFill2c,
            bothFill3c,
            bothFill4c,
        });
    }

    // Imbalance-based predictions at various points
    const imbalancePredictions = snapshots
        .filter(s => s.secondsInto >= 30 && s.secondsInto <= 240)
        .filter((_, i) => i % 10 === 0) // sample every ~20s
        .map(s => ({
            secondsInto: Math.round(s.secondsInto),
            imbalanceSignal: (s.upImbalance > 0 ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
            correct: (s.upImbalance > 0 ? 'UP' : 'DOWN') === actualOutcome,
        }));

    // Summary
    const d60 = delayedStraddles.find(d => d.entrySecond === 60);
    const d120 = delayedStraddles.find(d => d.entrySecond === 120);
    const avgImb = snapshots.length > 0 ? snapshots.reduce((s, x) => s + x.upImbalance, 0) / snapshots.length : 0;
    const imbPred = avgImb > 0 ? 'UP' : 'DOWN';
    const imbCorrect = imbPred === actualOutcome;

    console.log(
        `    >>> ${actualOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `Avg imb: ${(avgImb * 100).toFixed(0)}% (pred ${imbPred} ${imbCorrect ? 'OK' : 'X'}) | ` +
        `Delayed@60s: ${d60?.bothFill2c ? 'BOTH' : 'no'} | ` +
        `Delayed@120s: ${d120?.bothFill2c ? 'BOTH' : 'no'}`
    );

    return {
        index, timestamp: Date.now(), question: market.question,
        actualOutcome, volume, openClPrice, closeClPrice,
        snapshots, delayedStraddles, imbalancePredictions,
    };
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('BOOK IMBALANCE & FLOW STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Candles: ${results.length}\n`);

    // Imbalance as predictor
    console.log('--- Book Imbalance as Direction Predictor ---');
    const allPreds = results.flatMap(r => r.imbalancePredictions);
    if (allPreds.length > 0) {
        const correct = allPreds.filter(p => p.correct).length;
        console.log(`  Overall: ${correct}/${allPreds.length} (${(correct/allPreds.length*100).toFixed(0)}%)`);

        // By imbalance magnitude (from snapshots)
        for (const thresh of [0.05, 0.10, 0.20, 0.30]) {
            const strong = results.map(r => {
                const snaps = r.snapshots.filter(s => Math.abs(s.upImbalance) > thresh);
                if (snaps.length < 3) return null;
                const avgImb = snaps.reduce((s, x) => s + x.upImbalance, 0) / snaps.length;
                const pred = avgImb > 0 ? 'UP' : 'DOWN';
                return { correct: pred === r.actualOutcome };
            }).filter(Boolean) as { correct: boolean }[];

            if (strong.length > 0) {
                const c = strong.filter(s => s.correct).length;
                console.log(`  Imbalance > ${(thresh * 100).toFixed(0)}%: ${c}/${strong.length} (${(c/strong.length*100).toFixed(0)}%) [${strong.length} candles had signal]`);
            }
        }
    }

    // Delayed entry straddle
    console.log('\n--- Delayed Entry Straddle (enter later, center on current mid) ---');
    for (const entry of [0, 30, 60, 90, 120, 150, 180]) {
        const ds = results.flatMap(r => r.delayedStraddles.filter(d => d.entrySecond === entry));
        if (ds.length === 0) continue;

        const both2 = ds.filter(d => d.bothFill2c).length;
        const both3 = ds.filter(d => d.bothFill3c).length;
        const avgRange = ds.reduce((s, d) => s + d.rangeAfter, 0) / ds.length;

        console.log(
            `  Enter @${entry}s: ${ds.length} candles | ` +
            `2c both: ${both2}/${ds.length} (${(both2/ds.length*100).toFixed(0)}%) | ` +
            `3c both: ${both3}/${ds.length} (${(both3/ds.length*100).toFixed(0)}%) | ` +
            `Avg range after: ${(avgRange * 100).toFixed(0)}c`
        );
    }

    // Depth analysis
    console.log('\n--- Average Book Depth Over Time ---');
    const timeSlots = [30, 60, 120, 180, 240, 270, 290];
    for (const t of timeSlots) {
        const snaps = results.flatMap(r => r.snapshots.filter(s => Math.abs(s.secondsInto - t) < 5));
        if (snaps.length === 0) continue;
        const avgBid = snaps.reduce((s, x) => s + x.upBidDepth, 0) / snaps.length;
        const avgAsk = snaps.reduce((s, x) => s + x.upAskDepth, 0) / snaps.length;
        const avgImb = snaps.reduce((s, x) => s + x.upImbalance, 0) / snaps.length;
        console.log(
            `  ${t}s in: Bid depth: ${avgBid.toFixed(0)} | Ask depth: ${avgAsk.toFixed(0)} | Avg imbalance: ${(avgImb*100).toFixed(1)}%`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '50');
    console.log(`=== Book Imbalance & Flow Study: ${NUM_CANDLES} candles ===`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    let results: CandleResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Resuming from ${results.length} existing results\n`);
        } catch {}
    }

    const startIndex = results.length;
    const remaining = NUM_CANDLES - startIndex;
    if (remaining <= 0) { printAnalysis(results); return; }

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    for (let i = 0; i < remaining; i++) {
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(startIndex + i + 1, chainlink);
        if (result) {
            results.push(result);
            writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
            console.log(`    [Saved ${results.length}/${NUM_CANDLES}]\n`);
        }
    }

    chainlink.disconnect();
    printAnalysis(results);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
