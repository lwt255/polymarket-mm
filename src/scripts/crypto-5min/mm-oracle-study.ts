/**
 * MM-as-Oracle Study
 *
 * Tests: Is the dominant market maker's book pricing a better predictor
 * of the outcome than Chainlink alone?
 *
 * At each checkpoint, we record:
 *   - Chainlink direction (CL price vs open)
 *   - MM direction (UP mid > 50c = MM thinks UP)
 *   - Combined signal (both agree vs disagree)
 *   - Winner ask price (entry cost)
 *
 * The hypothesis: when CL and MM agree, accuracy is very high.
 * When they disagree, the MM might be right more often (faster feeds).
 *
 * Also tracks: does the MM's confidence (distance from 50c) correlate
 * with accuracy? i.e., is a 70c mid more reliable than a 55c mid?
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/mm-oracle-study.ts [numCandles]
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'mm-oracle-results.json';

const CHECKPOINTS = [120, 90, 60, 45, 30, 20, 15, 10, 5];

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

async function getBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number; mid: number } | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (raw.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2 };
}

interface Checkpoint {
    secondsBefore: number;
    clPrice: number;
    clMove: number; // vs open
    clDirection: 'UP' | 'DOWN';
    clConfidence: number; // abs(clMove) — bigger move = more confident
    upMid: number;
    mmDirection: 'UP' | 'DOWN'; // upMid > 0.50 = UP
    mmConfidence: number; // abs(upMid - 0.50) — further from 50c = more confident
    agree: boolean; // CL and MM agree on direction
    // Entry costs if you wanted to buy the predicted winner
    clWinnerAsk: number; // ask price of CL's predicted winner
    mmWinnerAsk: number; // ask price of MM's predicted winner
}

interface CandleResult {
    index: number;
    timestamp: number;
    question: string;
    openClPrice: number;
    closeClPrice: number;
    actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    checkpoints: Checkpoint[];
    // Per-checkpoint accuracy
    accuracy: {
        secondsBefore: number;
        clCorrect: boolean;
        mmCorrect: boolean;
        agreed: boolean;
        agreementCorrect: boolean | null; // null if they disagreed
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
    console.log(`  Candle ${index}: ${market.question}`);

    const openClPrice = chainlink.getPrice();
    if (openClPrice <= 0) return null;

    const checkpoints: Checkpoint[] = [];
    const captured = new Set<number>();

    while (true) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;
        if (secondsLeft < -2) break;

        for (const cp of CHECKPOINTS) {
            if (!captured.has(cp) && secondsLeft <= cp + 0.5 && secondsLeft >= cp - 1.5) {
                captured.add(cp);

                const clPrice = chainlink.getPrice();
                const clMove = clPrice - openClPrice;
                const clDirection: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';

                const [upBook, downBook] = await Promise.all([
                    getBook(upToken),
                    getBook(downToken),
                ]);

                if (upBook && downBook) {
                    const mmDirection: 'UP' | 'DOWN' = upBook.mid >= 0.50 ? 'UP' : 'DOWN';
                    const agree = clDirection === mmDirection;

                    const clWinnerAsk = clDirection === 'UP' ? upBook.bestAsk : downBook.bestAsk;
                    const mmWinnerAsk = mmDirection === 'UP' ? upBook.bestAsk : downBook.bestAsk;

                    checkpoints.push({
                        secondsBefore: cp,
                        clPrice,
                        clMove,
                        clDirection,
                        clConfidence: Math.abs(clMove),
                        upMid: upBook.mid,
                        mmDirection,
                        mmConfidence: Math.abs(upBook.mid - 0.50),
                        agree,
                        clWinnerAsk,
                        mmWinnerAsk,
                    });

                    const tag = agree ? 'AGREE' : 'SPLIT';
                    console.log(
                        `    ${cp}s | CL: ${clDirection} ($${Math.abs(clMove).toFixed(0)}) | ` +
                        `MM: ${mmDirection} (${(upBook.mid * 100).toFixed(0)}c) | ` +
                        `${tag} | Winner ask: CL=${(clWinnerAsk * 100).toFixed(0)}c MM=${(mmWinnerAsk * 100).toFixed(0)}c`
                    );
                }
            }
        }

        await new Promise(r => setTimeout(r, secondsLeft < 130 ? 500 : 2000));
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

    const accuracy = checkpoints.map(cp => ({
        secondsBefore: cp.secondsBefore,
        clCorrect: cp.clDirection === actualOutcome,
        mmCorrect: cp.mmDirection === actualOutcome,
        agreed: cp.agree,
        agreementCorrect: cp.agree ? cp.clDirection === actualOutcome : null,
    }));

    // Summary
    const at30 = accuracy.find(a => a.secondsBefore === 30);
    const at10 = accuracy.find(a => a.secondsBefore === 10);
    console.log(
        `    >>> ${actualOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `30s: CL=${at30?.clCorrect ? 'OK' : 'X'} MM=${at30?.mmCorrect ? 'OK' : 'X'} | ` +
        `10s: CL=${at10?.clCorrect ? 'OK' : 'X'} MM=${at10?.mmCorrect ? 'OK' : 'X'}`
    );

    return {
        index, timestamp: Date.now(), question: market.question,
        openClPrice, closeClPrice, actualOutcome, volume,
        checkpoints, accuracy,
    };
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('MM-AS-ORACLE STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Candles: ${results.length}\n`);

    // Accuracy comparison: CL vs MM at each checkpoint
    console.log('--- Prediction Accuracy: Chainlink vs MM Book ---');
    console.log(`${'Time'.padEnd(6)} | ${'CL'.padEnd(14)} | ${'MM'.padEnd(14)} | ${'Both Agree'.padEnd(14)} | ${'Agree+Correct'.padEnd(14)} | ${'Disagree'.padEnd(10)} | MM wins disagree`);
    console.log('-'.repeat(100));

    for (const cp of CHECKPOINTS) {
        const accs = results.flatMap(r => r.accuracy.filter(a => a.secondsBefore === cp));
        if (accs.length === 0) continue;

        const clCorrect = accs.filter(a => a.clCorrect).length;
        const mmCorrect = accs.filter(a => a.mmCorrect).length;
        const agreed = accs.filter(a => a.agreed);
        const agreedCorrect = agreed.filter(a => a.agreementCorrect).length;
        const disagreed = accs.filter(a => !a.agreed);
        const mmWinsDisagree = disagreed.filter(a => a.mmCorrect).length;

        console.log(
            `${cp}s`.padEnd(6) + ' | ' +
            `${clCorrect}/${accs.length} (${(clCorrect/accs.length*100).toFixed(0)}%)`.padEnd(14) + ' | ' +
            `${mmCorrect}/${accs.length} (${(mmCorrect/accs.length*100).toFixed(0)}%)`.padEnd(14) + ' | ' +
            `${agreed.length}/${accs.length} (${(agreed.length/accs.length*100).toFixed(0)}%)`.padEnd(14) + ' | ' +
            `${agreedCorrect}/${agreed.length} (${agreed.length > 0 ? (agreedCorrect/agreed.length*100).toFixed(0) : 'N/A'}%)`.padEnd(14) + ' | ' +
            `${disagreed.length}`.padEnd(10) + ' | ' +
            `${mmWinsDisagree}/${disagreed.length}`
        );
    }

    // MM confidence vs accuracy
    console.log('\n--- MM Confidence vs Accuracy (at 30s) ---');
    const at30 = results.flatMap(r => {
        const cp = r.checkpoints.find(c => c.secondsBefore === 30);
        const acc = r.accuracy.find(a => a.secondsBefore === 30);
        if (!cp || !acc) return [];
        return [{ confidence: cp.mmConfidence, mmCorrect: acc.mmCorrect, clCorrect: acc.clCorrect }];
    });

    const confBuckets = [0, 0.05, 0.10, 0.20, 0.30, 0.50];
    for (let i = 0; i < confBuckets.length - 1; i++) {
        const lo = confBuckets[i];
        const hi = confBuckets[i + 1];
        const bucket = at30.filter(x => x.confidence >= lo && x.confidence < hi);
        if (bucket.length === 0) continue;
        const mmRight = bucket.filter(x => x.mmCorrect).length;
        const clRight = bucket.filter(x => x.clCorrect).length;
        console.log(
            `  MM conf ${(lo*100).toFixed(0)}-${(hi*100).toFixed(0)}c: ${bucket.length} candles | ` +
            `MM: ${mmRight}/${bucket.length} (${(mmRight/bucket.length*100).toFixed(0)}%) | ` +
            `CL: ${clRight}/${bucket.length} (${(clRight/bucket.length*100).toFixed(0)}%)`
        );
    }

    // Simulated P&L: buy MM's predicted winner at its ask
    console.log('\n--- Simulated P&L: Buy MM Winner at Ask ---');
    for (const cp of [60, 45, 30, 20, 15, 10]) {
        const trades = results.map(r => {
            const checkpoint = r.checkpoints.find(c => c.secondsBefore === cp);
            const acc = r.accuracy.find(a => a.secondsBefore === cp);
            if (!checkpoint || !acc) return null;
            const cost = checkpoint.mmWinnerAsk;
            const profit = acc.mmCorrect ? (1 - cost) : -cost;
            return { cost, profit, correct: acc.mmCorrect };
        }).filter(Boolean) as { cost: number; profit: number; correct: boolean }[];

        if (trades.length > 0) {
            const totalPnl = trades.reduce((s, t) => s + t.profit, 0);
            const avgCost = trades.reduce((s, t) => s + t.cost, 0) / trades.length;
            const wins = trades.filter(t => t.correct).length;
            console.log(
                `  ${String(cp).padStart(3)}s: ${wins}/${trades.length} wins (${(wins/trades.length*100).toFixed(0)}%) | ` +
                `Avg cost: ${(avgCost*100).toFixed(0)}c | ` +
                `P&L: $${totalPnl.toFixed(2)}/share ($${(totalPnl/trades.length).toFixed(4)}/candle)`
            );
        }
    }

    // The money question: when CL and MM agree with high confidence, what's the accuracy?
    console.log('\n--- High-Confidence Agreement Signal ---');
    for (const cp of [30, 20, 15, 10]) {
        const highConf = results.map(r => {
            const checkpoint = r.checkpoints.find(c => c.secondsBefore === cp);
            const acc = r.accuracy.find(a => a.secondsBefore === cp);
            if (!checkpoint || !acc) return null;
            // Both agree AND MM confidence > 10c from mid
            if (!checkpoint.agree || checkpoint.mmConfidence < 0.10) return null;
            return { correct: acc.clCorrect, cost: checkpoint.mmWinnerAsk, mmConf: checkpoint.mmConfidence };
        }).filter(Boolean) as { correct: boolean; cost: number; mmConf: number }[];

        if (highConf.length > 0) {
            const wins = highConf.filter(t => t.correct).length;
            const avgCost = highConf.reduce((s, t) => s + t.cost, 0) / highConf.length;
            const pnl = highConf.reduce((s, t) => s + (t.correct ? (1 - t.cost) : -t.cost), 0);
            console.log(
                `  ${cp}s (agree + MM>10c): ${wins}/${highConf.length} (${(wins/highConf.length*100).toFixed(0)}%) | ` +
                `Avg cost: ${(avgCost*100).toFixed(0)}c | P&L: $${pnl.toFixed(2)}/share`
            );
        }
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '100');
    console.log(`=== MM-as-Oracle Study: ${NUM_CANDLES} candles ===`);
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
