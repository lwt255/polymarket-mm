/**
 * Extended Straddle Study — 30 candles
 *
 * Validates the relative straddle strategy (mid ± offset) over a large sample.
 * Writes results to a JSON file as it goes, so partial results are preserved
 * if the process crashes.
 *
 * Run with pm2: pm2 start --no-autorestart --name straddle-study "npx tsx src/scripts/crypto-5min/extended-straddle-study.ts 30"
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'straddle-study-results.json';

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
    spread: number;
}

async function getBook(tokenId: string): Promise<BookSnapshot | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
    const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
    const bestBid = bids[0] ?? 0;
    const bestAsk = asks[0] ?? 1;
    return { timestamp: Date.now(), secondsLeft: 0, bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid };
}

interface CandleResult {
    index: number;
    timestamp: number;
    question: string;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openMid: number;
    highMid: number;
    lowMid: number;
    range: number;
    snapshotCount: number;
    openChainlink: number;
    closeChainlink: number;
    // Strategy results for different offsets
    strategies: {
        offset: number;
        bidPrice: number;
        askPrice: number;
        bidFilled: boolean;
        askFilled: boolean;
        bothFilled: boolean;
        pnl: number;
    }[];
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<CandleResult | null> {
    const market = await findCurrentMarket();
    if (!market) {
        console.log(`  Candle ${candleIndex}: No market found`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    const endTime = endDate.getTime();

    let openChainlink: number | null = null;
    let openMid: number | null = null;
    const mids: number[] = [];

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
        if (book && book.mid > 0.02 && book.mid < 0.98) {
            if (!openMid) openMid = book.mid;
            mids.push(book.mid);
        }

        // Brief status every 60 seconds
        if (p % 30 === 0 && book) {
            const move = openChainlink ? clPrice - openChainlink : 0;
            console.log(
                `    ${Math.round(secondsLeft).toString().padStart(4)}s | ` +
                `Mid: ${(book.mid * 100).toFixed(0)}c | ` +
                `CL: ${move >= 0 ? '+' : ''}$${move.toFixed(0)}`
            );
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    if (mids.length === 0 || !openMid || !openChainlink) {
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
    const highMid = Math.max(...mids);
    const lowMid = Math.min(...mids);

    // Test multiple offset strategies
    const offsets = [0.01, 0.02, 0.03, 0.04, 0.045, 0.05, 0.06, 0.08, 0.10];
    const strategies = offsets.map(offset => {
        const bidPrice = Math.round((openMid! - offset) * 100) / 100;
        const askPrice = Math.round((openMid! + offset) * 100) / 100;

        if (bidPrice <= 0.01 || askPrice >= 0.99) {
            return { offset, bidPrice, askPrice, bidFilled: false, askFilled: false, bothFilled: false, pnl: 0 };
        }

        // Check fills: did mid ever go below bid or above ask?
        const bidFilled = mids.some(m => m <= bidPrice + 0.005);
        const askFilled = mids.some(m => m >= askPrice - 0.005);
        const bothFilled = bidFilled && askFilled;

        let pnl = 0;
        if (bothFilled) {
            pnl = (askPrice - bidPrice) * 100; // $100 per side
        } else if (bidFilled) {
            pnl = outcome === 'UP' ? (1 - bidPrice) * 100 : -bidPrice * 100;
        } else if (askFilled) {
            pnl = outcome === 'DOWN' ? askPrice * 100 : -(1 - askPrice) * 100;
        }

        return { offset, bidPrice, askPrice, bidFilled, askFilled, bothFilled, pnl };
    });

    const result: CandleResult = {
        index: candleIndex,
        timestamp: Date.now(),
        question: market.question,
        outcome,
        volume,
        openMid,
        highMid,
        lowMid,
        range: highMid - lowMid,
        snapshotCount: mids.length,
        openChainlink,
        closeChainlink: clClose,
        strategies,
    };

    // Log summary
    const s3c = strategies.find(s => s.offset === 0.03)!;
    const s4c = strategies.find(s => s.offset === 0.04)!;
    console.log(
        `    >>> ${outcome} | Vol: $${volume.toFixed(0)} | ` +
        `Range: ${(lowMid * 100).toFixed(0)}-${(highMid * 100).toFixed(0)}c (${((highMid - lowMid) * 100).toFixed(0)}c) | ` +
        `3c: ${s3c.bothFilled ? 'BOTH' : s3c.bidFilled ? 'bid' : s3c.askFilled ? 'ask' : 'none'} $${s3c.pnl.toFixed(0)} | ` +
        `4c: ${s4c.bothFilled ? 'BOTH' : s4c.bidFilled ? 'bid' : s4c.askFilled ? 'ask' : 'none'} $${s4c.pnl.toFixed(0)}`
    );

    return result;
}

function saveResults(results: CandleResult[]) {
    writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(90));
    console.log('EXTENDED STRADDLE STUDY — FINAL ANALYSIS');
    console.log('='.repeat(90));

    console.log(`\nCandles: ${results.length}`);
    const ups = results.filter(r => r.outcome === 'UP').length;
    const downs = results.filter(r => r.outcome === 'DOWN').length;
    console.log(`Outcomes: ${ups} UP / ${downs} DOWN`);

    const ranges = results.map(r => r.range);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const minRange = Math.min(...ranges);
    const maxRange = Math.max(...ranges);
    console.log(`Range: avg ${(avgRange * 100).toFixed(0)}c | min ${(minRange * 100).toFixed(0)}c | max ${(maxRange * 100).toFixed(0)}c`);

    const avgVol = results.reduce((s, r) => s + r.volume, 0) / results.length;
    console.log(`Avg volume: $${avgVol.toFixed(0)}`);

    // Strategy comparison
    console.log('\n--- Strategy Results ---');
    console.log(`${'Offset'.padEnd(8)} | Both  | Bid   | Ask   | None  | Win%  | Total P&L   | Per Candle  | Daily Est`);
    console.log('-'.repeat(100));

    const offsets = [0.01, 0.02, 0.03, 0.04, 0.045, 0.05, 0.06, 0.08, 0.10];
    for (const offset of offsets) {
        let both = 0, bidOnly = 0, askOnly = 0, none = 0, totalPnL = 0, wins = 0;

        for (const r of results) {
            const s = r.strategies.find(s => s.offset === offset);
            if (!s) continue;

            if (s.bothFilled) { both++; wins++; }
            else if (s.bidFilled) { bidOnly++; if (s.pnl > 0) wins++; }
            else if (s.askFilled) { askOnly++; if (s.pnl > 0) wins++; }
            else { none++; }
            totalPnL += s.pnl;
        }

        const total = both + bidOnly + askOnly + none;
        const perCandle = totalPnL / total;
        const daily = perCandle * 288;

        console.log(
            `${(offset * 100).toFixed(1)}c`.padEnd(8) + ' | ' +
            `${both}/${total}`.padEnd(5) + ' | ' +
            `${bidOnly}`.padEnd(5) + ' | ' +
            `${askOnly}`.padEnd(5) + ' | ' +
            `${none}`.padEnd(5) + ' | ' +
            `${((wins / total) * 100).toFixed(0)}%`.padEnd(5) + ' | ' +
            `$${totalPnL.toFixed(2)}`.padStart(11) + ' | ' +
            `$${perCandle.toFixed(2)}`.padStart(11) + ' | ' +
            `$${daily.toFixed(0)}`.padStart(9)
        );
    }

    // Adverse selection analysis
    console.log('\n--- Adverse Selection Analysis (single-side fills) ---');
    for (const offset of [0.03, 0.04, 0.05]) {
        const bidOnlyResults = results.filter(r => {
            const s = r.strategies.find(s => s.offset === offset);
            return s && s.bidFilled && !s.askFilled;
        });
        const askOnlyResults = results.filter(r => {
            const s = r.strategies.find(s => s.offset === offset);
            return s && s.askFilled && !s.bidFilled;
        });

        if (bidOnlyResults.length > 0) {
            const bidCorrect = bidOnlyResults.filter(r => r.outcome === 'UP').length;
            console.log(`  ${(offset * 100).toFixed(0)}c bid-only: ${bidCorrect}/${bidOnlyResults.length} resolved UP (${((bidCorrect / bidOnlyResults.length) * 100).toFixed(0)}%)`);
        }
        if (askOnlyResults.length > 0) {
            const askCorrect = askOnlyResults.filter(r => r.outcome === 'DOWN').length;
            console.log(`  ${(offset * 100).toFixed(0)}c ask-only: ${askCorrect}/${askOnlyResults.length} resolved DOWN (${((askCorrect / askOnlyResults.length) * 100).toFixed(0)}%)`);
        }
    }

    // Range distribution
    console.log('\n--- Range Distribution ---');
    const rangeBuckets = [0, 10, 20, 30, 40, 50, 60, 70, 80, 100];
    for (let i = 0; i < rangeBuckets.length - 1; i++) {
        const low = rangeBuckets[i] / 100;
        const high = rangeBuckets[i + 1] / 100;
        const count = results.filter(r => r.range >= low && r.range < high).length;
        if (count > 0) {
            console.log(`  ${rangeBuckets[i]}-${rangeBuckets[i + 1]}c: ${count} candles (${((count / results.length) * 100).toFixed(0)}%)`);
        }
    }

    // Statistical significance
    console.log('\n--- Statistical Notes ---');
    const s4 = results.map(r => r.strategies.find(s => s.offset === 0.04)!);
    const bothRate = s4.filter(s => s.bothFilled).length / s4.length;
    const se = Math.sqrt(bothRate * (1 - bothRate) / s4.length);
    console.log(`  4c offset both-fill rate: ${(bothRate * 100).toFixed(1)}% ± ${(se * 100 * 1.96).toFixed(1)}% (95% CI)`);
    console.log(`  Break-even both-fill rate (assuming 50/50 adverse selection): ~50%`);
    console.log(`  ${bothRate > 0.5 ? 'ABOVE break-even' : 'BELOW break-even'}`);
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '30');
    console.log(`=== Extended Straddle Study: ${NUM_CANDLES} candles ===`);
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    // Load existing results if resuming
    let results: CandleResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Resuming from ${results.length} existing results\n`);
        } catch {}
    }

    const startIndex = results.length;
    const remaining = NUM_CANDLES - startIndex;
    if (remaining <= 0) {
        console.log('Already have enough candles. Running analysis...');
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
            console.log(`    [Saved ${results.length}/${NUM_CANDLES} candles to ${OUTPUT_FILE}]`);
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
