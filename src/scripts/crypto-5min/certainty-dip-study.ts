/**
 * Certainty Dip Study
 *
 * HYPOTHESIS: Wait until outcome is nearly certain (3+ minutes in, large CL move),
 * then buy the winning token during temporary price dips caused by oscillation.
 *
 * From our data:
 * - After 180s (3 min), Chainlink direction was 100% accurate (8 candles)
 * - Mid oscillates 39-80c range — even the winner's price dips regularly
 * - If winner is at 70c avg but dips to 60c temporarily, buy at 60c → collect $1 = 40c profit
 *
 * This could explain:
 * - 90%+ win rate (only enter on high-confidence setups)
 * - "Not about predicting price" (outcome already decided, just buying the dip)
 * - "Not about being first" (dips happen repeatedly, no rush)
 *
 * The study tracks:
 * 1. At what point is the winner clear? (CL move threshold)
 * 2. How often does the winner's mid dip below its recent average?
 * 3. What's the best entry price achievable after the winner is known?
 * 4. What's the taker fee at that price?
 * 5. Net P&L per trade
 *
 * Run: npx tsx src/scripts/crypto-5min/certainty-dip-study.ts 20
 * Run via pm2: pm2 start --no-autorestart --name certainty-dip "npx tsx src/scripts/crypto-5min/certainty-dip-study.ts 20"
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'certainty-dip-results.json';

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0) {
            const m = data[0];
            if (new Date(m.endDate).getTime() > Date.now()) return m;
        }
    }
    return null;
}

interface BookSnapshot {
    timestamp: number;
    secondsLeft: number;
    bestBid: number;
    bestAsk: number;
    mid: number;
    clPrice: number;
    clMove: number; // from open
}

async function getBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number; mid: number } | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
    const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
    const bestBid = bids[0] ?? 0;
    const bestAsk = asks[0] ?? 1;
    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2 };
}

// Taker fee for crypto markets
function takerFee(price: number): number {
    const p = Math.max(0.01, Math.min(0.99, price));
    return p * 0.25 * Math.pow(p * (1 - p), 2);
}

interface DipResult {
    index: number;
    timestamp: number;
    question: string;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openChainlink: number;
    closeChainlink: number;
    clMove: number;
    snapshots: BookSnapshot[];
    // For each entry point strategy
    entries: {
        name: string;
        triggerTime: number;       // seconds into candle when condition met
        secondsLeft: number;
        entryMid: number;          // mid when we would enter
        entryAsk: number;          // actual ask (what taker pays)
        entryFee: number;          // taker fee
        totalCost: number;         // ask + fee
        pnl: number;               // $1 - totalCost (if winner), -totalCost (if loser)
        correct: boolean;          // did we pick the right side?
        // Dip entry: best ask price AFTER trigger, before resolution
        bestDipAsk: number;
        bestDipMid: number;
        dipPnl: number;
    }[];
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<DipResult | null> {
    const market = await findCurrentMarket();
    if (!market) {
        console.log(`  Candle ${candleIndex}: No market found`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    if (!upToken || !downToken) return null;

    const endDate = new Date(market.endDate);
    const endTime = endDate.getTime();
    const startTime = endTime - 300000;

    let openChainlink: number | null = null;

    const snapshots: BookSnapshot[] = [];
    const POLL_INTERVAL = 2000;
    const maxPolls = 160;

    console.log(`  Candle ${candleIndex}: ${market.question}`);

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;
        if (secondsLeft < -5) break;

        const clPrice = chainlink.getPrice();
        if (!openChainlink && clPrice > 0) openChainlink = clPrice;

        const book = await getBook(upToken);
        if (book && book.mid > 0.02 && book.mid < 0.98 && openChainlink) {
            snapshots.push({
                timestamp: now,
                secondsLeft,
                bestBid: book.bestBid,
                bestAsk: book.bestAsk,
                mid: book.mid,
                clPrice,
                clMove: clPrice - openChainlink,
            });
        }

        if (p % 30 === 0 && openChainlink) {
            const move = clPrice - openChainlink;
            console.log(
                `    ${Math.round(secondsLeft).toString().padStart(4)}s | ` +
                `Mid: ${book ? (book.mid * 100).toFixed(0) : '??'}c | ` +
                `CL: ${move >= 0 ? '+' : ''}$${move.toFixed(0)}`
            );
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    if (snapshots.length === 0 || !openChainlink) {
        console.log(`    No data captured`);
        return null;
    }

    // Resolution
    await new Promise(r => setTimeout(r, 6000));
    const clClose = chainlink.getPrice();
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    if (outcome === 'UNKNOWN' && clClose >= openChainlink) outcome = 'UP';
    else if (outcome === 'UNKNOWN') outcome = 'DOWN';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Entry strategies: At various time points and CL move thresholds
    const entries: DipResult['entries'] = [];

    // Strategy configs: { name, minSecondsIn, minClMove }
    const configs = [
        { name: '120s_$50', minSecondsIn: 120, minClMove: 50 },
        { name: '120s_$100', minSecondsIn: 120, minClMove: 100 },
        { name: '150s_$50', minSecondsIn: 150, minClMove: 50 },
        { name: '150s_$100', minSecondsIn: 150, minClMove: 100 },
        { name: '180s_any', minSecondsIn: 180, minClMove: 0 },
        { name: '180s_$50', minSecondsIn: 180, minClMove: 50 },
        { name: '180s_$100', minSecondsIn: 180, minClMove: 100 },
        { name: '200s_any', minSecondsIn: 200, minClMove: 0 },
        { name: '240s_any', minSecondsIn: 240, minClMove: 0 },
    ];

    for (const config of configs) {
        // Find the first snapshot that meets the trigger criteria
        const triggerSnap = snapshots.find(s => {
            const secondsIn = 300 - s.secondsLeft;
            return secondsIn >= config.minSecondsIn && Math.abs(s.clMove) >= config.minClMove;
        });

        if (!triggerSnap) {
            entries.push({
                name: config.name,
                triggerTime: -1,
                secondsLeft: -1,
                entryMid: 0,
                entryAsk: 0,
                entryFee: 0,
                totalCost: 0,
                pnl: 0,
                correct: false,
                bestDipAsk: 0,
                bestDipMid: 0,
                dipPnl: 0,
            });
            continue;
        }

        // Determine which side to buy based on CL move direction
        const buyUp = triggerSnap.clMove > 0;
        const correct = (buyUp && outcome === 'UP') || (!buyUp && outcome === 'DOWN');

        // For UP token: buy at ask. For DOWN token: need to invert (DOWN ask = 1 - UP bid)
        let entryAsk: number;
        let entryMid: number;
        if (buyUp) {
            entryAsk = triggerSnap.bestAsk;
            entryMid = triggerSnap.mid;
        } else {
            entryAsk = 1 - triggerSnap.bestBid; // DOWN ask ≈ 1 - UP bid
            entryMid = 1 - triggerSnap.mid;
        }

        const fee = takerFee(entryAsk);
        const totalCost = entryAsk + fee;
        const pnl = correct ? (1 - totalCost) * 100 : -totalCost * 100;

        // Find best dip AFTER trigger (lowest ask for the winning side)
        const postTriggerSnaps = snapshots.filter(s => s.timestamp >= triggerSnap.timestamp && s.secondsLeft > 10);
        let bestDipAsk = entryAsk;
        let bestDipMid = entryMid;

        for (const s of postTriggerSnaps) {
            const dipAsk = buyUp ? s.bestAsk : (1 - s.bestBid);
            const dipMid = buyUp ? s.mid : (1 - s.mid);
            if (dipAsk < bestDipAsk) {
                bestDipAsk = dipAsk;
                bestDipMid = dipMid;
            }
        }

        const dipFee = takerFee(bestDipAsk);
        const dipPnl = correct ? (1 - bestDipAsk - dipFee) * 100 : -(bestDipAsk + dipFee) * 100;

        entries.push({
            name: config.name,
            triggerTime: 300 - triggerSnap.secondsLeft,
            secondsLeft: triggerSnap.secondsLeft,
            entryMid,
            entryAsk,
            entryFee: fee,
            totalCost,
            pnl,
            correct,
            bestDipAsk,
            bestDipMid,
            dipPnl,
        });
    }

    const result: DipResult = {
        index: candleIndex,
        timestamp: Date.now(),
        question: market.question,
        outcome,
        volume,
        openChainlink,
        closeChainlink: clClose,
        clMove: clClose - openChainlink,
        snapshots,
        entries,
    };

    // Log key entries
    const e180 = entries.find(e => e.name === '180s_$50');
    if (e180 && e180.triggerTime > 0) {
        console.log(
            `    >>> ${outcome} | CL: ${result.clMove >= 0 ? '+' : ''}$${result.clMove.toFixed(0)} | ` +
            `180s/$50: ${e180.correct ? 'WIN' : 'LOSS'} at ${(e180.entryAsk * 100).toFixed(0)}c → $${e180.pnl.toFixed(1)} | ` +
            `Dip: ${(e180.bestDipAsk * 100).toFixed(0)}c → $${e180.dipPnl.toFixed(1)}`
        );
    } else {
        console.log(`    >>> ${outcome} | CL: ${result.clMove >= 0 ? '+' : ''}$${result.clMove.toFixed(0)} | No 180s/$50 trigger`);
    }

    return result;
}

function saveResults(results: DipResult[]) {
    writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function printAnalysis(results: DipResult[]) {
    console.log('\n' + '='.repeat(100));
    console.log('CERTAINTY DIP STUDY — ANALYSIS');
    console.log('='.repeat(100));

    console.log(`\nCandles: ${results.length}`);
    const ups = results.filter(r => r.outcome === 'UP').length;
    console.log(`Outcomes: ${ups} UP / ${results.length - ups} DOWN`);

    const clMoves = results.map(r => Math.abs(r.clMove));
    console.log(`CL move: avg $${(clMoves.reduce((a, b) => a + b, 0) / clMoves.length).toFixed(0)} | ` +
        `min $${Math.min(...clMoves).toFixed(0)} | max $${Math.max(...clMoves).toFixed(0)}`);

    // Strategy comparison
    console.log('\n--- Entry Strategy Results ---');
    console.log(
        `${'Strategy'.padEnd(14)} | ` +
        `${'Triggered'.padEnd(10)} | ` +
        `${'Correct'.padEnd(8)} | ` +
        `${'Win%'.padEnd(6)} | ` +
        `${'Avg Entry'.padEnd(10)} | ` +
        `${'Total P&L'.padStart(10)} | ` +
        `${'Per Trade'.padStart(10)} | ` +
        `${'Dip P&L'.padStart(10)} | ` +
        `${'Dip/Trade'.padStart(10)}`
    );
    console.log('-'.repeat(110));

    const configs = ['120s_$50', '120s_$100', '150s_$50', '150s_$100', '180s_any', '180s_$50', '180s_$100', '200s_any', '240s_any'];
    for (const name of configs) {
        const triggered = results.map(r => r.entries.find(e => e.name === name)!).filter(e => e.triggerTime > 0);
        if (triggered.length === 0) {
            console.log(`${name.padEnd(14)} | ${'0/' + results.length} never triggered`);
            continue;
        }

        const correct = triggered.filter(e => e.correct).length;
        const totalPnl = triggered.reduce((s, e) => s + e.pnl, 0);
        const totalDipPnl = triggered.reduce((s, e) => s + e.dipPnl, 0);
        const avgEntry = triggered.reduce((s, e) => s + e.entryAsk, 0) / triggered.length;

        console.log(
            `${name.padEnd(14)} | ` +
            `${triggered.length}/${results.length}`.padEnd(10) + ' | ' +
            `${correct}/${triggered.length}`.padEnd(8) + ' | ' +
            `${((correct / triggered.length) * 100).toFixed(0)}%`.padEnd(6) + ' | ' +
            `${(avgEntry * 100).toFixed(0)}c`.padEnd(10) + ' | ' +
            `$${totalPnl.toFixed(1)}`.padStart(10) + ' | ' +
            `$${(totalPnl / triggered.length).toFixed(1)}`.padStart(10) + ' | ' +
            `$${totalDipPnl.toFixed(1)}`.padStart(10) + ' | ' +
            `$${(totalDipPnl / triggered.length).toFixed(1)}`.padStart(10)
        );
    }

    // Entry price distribution
    console.log('\n--- Entry Price Distribution (180s/$50 strategy) ---');
    const e180 = results.map(r => r.entries.find(e => e.name === '180s_$50')!).filter(e => e.triggerTime > 0);
    if (e180.length > 0) {
        const entryPrices = e180.map(e => e.entryAsk).sort((a, b) => a - b);
        const dipPrices = e180.map(e => e.bestDipAsk).sort((a, b) => a - b);
        console.log(`  Entry asks: ${entryPrices.map(p => (p * 100).toFixed(0) + 'c').join(', ')}`);
        console.log(`  Best dips:  ${dipPrices.map(p => (p * 100).toFixed(0) + 'c').join(', ')}`);
        console.log(`  Avg improvement from dip: ${((e180.reduce((s, e) => s + (e.entryAsk - e.bestDipAsk), 0) / e180.length) * 100).toFixed(1)}c`);
    }

    // CL move vs accuracy
    console.log('\n--- CL Move vs Prediction Accuracy ---');
    const moveBuckets = [0, 25, 50, 100, 200, 500, 10000];
    for (let i = 0; i < moveBuckets.length - 1; i++) {
        const low = moveBuckets[i];
        const high = moveBuckets[i + 1];
        const bucket = results.filter(r => {
            const absCl = Math.abs(r.clMove);
            return absCl >= low && absCl < high;
        });
        if (bucket.length === 0) continue;

        // Check 180s accuracy for this bucket
        const entries180 = bucket.map(r => r.entries.find(e => e.name === '180s_any')!).filter(e => e.triggerTime > 0);
        const correct180 = entries180.filter(e => e.correct).length;

        console.log(
            `  $${low}-$${high}: ${bucket.length} candles | ` +
            `180s accuracy: ${entries180.length > 0 ? `${correct180}/${entries180.length} (${((correct180 / entries180.length) * 100).toFixed(0)}%)` : 'N/A'}`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '20');
    console.log(`=== Certainty Dip Study: ${NUM_CANDLES} candles ===`);
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    let results: DipResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Resuming from ${results.length} existing results\n`);
        } catch {}
    }

    const startIndex = results.length;
    const remaining = NUM_CANDLES - startIndex;
    if (remaining <= 0) {
        console.log('Already have enough candles.');
        printAnalysis(results);
        return;
    }

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
            saveResults(results);
            console.log(`    [Saved ${results.length}/${NUM_CANDLES} candles]`);
        }
    }

    chainlink.disconnect();
    console.log(`\nCompleted: ${new Date().toLocaleString()}`);
    printAnalysis(results);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
