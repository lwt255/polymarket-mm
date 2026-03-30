/**
 * Split-Based Straddle Study
 *
 * Tests: If you split $1 USDC into 1 YES + 1 NO token via the CTF contract,
 * then immediately sell the losing side on the CLOB, what's the P&L?
 *
 * The key insight: splitting bypasses the CLOB settlement delay entirely.
 * You instantly hold both tokens. No fill needed. Then sell one side.
 *
 * Two sub-strategies tested:
 *   A) Split at candle open, sell both at market → capture spread if profitable
 *   B) Split at candle open, wait for direction to become clear, sell the loser
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/split-straddle-study.ts [numCandles]
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'split-straddle-results.json';

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

interface BookState {
    bestBid: number;
    bestAsk: number;
    bidSize: number;
    askSize: number;
    bidDepth3c: number; // total size within 3c of best bid
}

async function getDetailedBook(tokenId: string): Promise<BookState | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (raw.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');

    // Calculate depth within 3c of best bid
    let bidDepth3c = 0;
    for (const b of bids) {
        if (parseFloat(b.price) >= bestBid - 0.03) {
            bidDepth3c += parseFloat(b.size);
        }
    }

    return {
        bestBid, bestAsk,
        bidSize: parseFloat(bids[0]?.size || '0'),
        askSize: parseFloat(asks[0]?.size || '0'),
        bidDepth3c,
    };
}

interface CandleResult {
    index: number;
    timestamp: number;
    question: string;
    volume: number;
    actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN';
    openClPrice: number;
    closeClPrice: number;

    // Strategy A: Split then immediately sell both sides at market
    // Revenue = sell UP at bid + sell DOWN at bid. Cost = $1 split.
    stratA: {
        upBid: number;
        downBid: number;
        totalRevenue: number; // upBid + downBid
        pnl: number; // totalRevenue - 1.0
    };

    // Strategy B: Split, wait for direction, sell loser at market
    // You keep the winner (resolves to $1), sell loser at its bid
    // Cost = $1 split. Revenue = $1 (winner) + loserBid (sell loser)
    stratB_checkpoints: {
        secondsBefore: number;
        predictedLoser: 'UP' | 'DOWN';
        loserBid: number;
        loserBidSize: number;
        // If prediction correct: pnl = 1 + loserBid - 1 = loserBid
        // If prediction wrong: pnl = 0 + winnerBid - 1 (sold the wrong one)
        pnlIfCorrect: number;
        pnlIfWrong: number;
        wasCorrect: boolean;
        actualPnl: number;
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

    // Get opening books for Strategy A
    const openUpBook = await getDetailedBook(upToken);
    const openDownBook = await getDetailedBook(downToken);
    if (!openUpBook || !openDownBook) return null;

    const stratA = {
        upBid: openUpBook.bestBid,
        downBid: openDownBook.bestBid,
        totalRevenue: openUpBook.bestBid + openDownBook.bestBid,
        pnl: openUpBook.bestBid + openDownBook.bestBid - 1.0,
    };
    console.log(`    Open: UP bid=${openUpBook.bestBid} DOWN bid=${openDownBook.bestBid} → Split P&L: ${(stratA.pnl * 100).toFixed(1)}c`);

    // Monitor for Strategy B checkpoints
    const checkpoints = [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10];
    const capturedCPs = new Set<number>();
    const stratB_data: { secondsBefore: number; predictedLoser: 'UP' | 'DOWN'; loserBid: number; loserBidSize: number; winnerBid: number }[] = [];

    while (true) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;
        if (secondsLeft < -2) break;

        for (const cp of checkpoints) {
            if (!capturedCPs.has(cp) && secondsLeft <= cp + 0.5 && secondsLeft >= cp - 1.5) {
                capturedCPs.add(cp);

                const clPrice = chainlink.getPrice();
                const clMove = clPrice - openClPrice;
                const predictedWinner: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';
                const predictedLoser: 'UP' | 'DOWN' = predictedWinner === 'UP' ? 'DOWN' : 'UP';

                const loserBook = await getDetailedBook(predictedLoser === 'UP' ? upToken : downToken);
                const winnerBook = await getDetailedBook(predictedWinner === 'UP' ? upToken : downToken);

                if (loserBook && winnerBook) {
                    stratB_data.push({
                        secondsBefore: cp,
                        predictedLoser,
                        loserBid: loserBook.bestBid,
                        loserBidSize: loserBook.bidSize,
                        winnerBid: winnerBook.bestBid,
                    });

                    console.log(
                        `    ${cp}s left | CL: ${predictedWinner} ($${Math.abs(clMove).toFixed(0)}) | ` +
                        `Loser(${predictedLoser}) bid: ${(loserBook.bestBid * 100).toFixed(0)}c | ` +
                        `Winner(${predictedWinner}) bid: ${(winnerBook.bestBid * 100).toFixed(0)}c`
                    );
                }
            }
        }

        await new Promise(r => setTimeout(r, secondsLeft < 70 ? 500 : secondsLeft < 200 ? 1000 : 2000));
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

    // Calculate Strategy B P&L at each checkpoint
    const stratB_checkpoints = stratB_data.map(d => {
        const wasCorrect = (d.predictedLoser === 'UP' && actualOutcome === 'DOWN') ||
                          (d.predictedLoser === 'DOWN' && actualOutcome === 'UP');
        // If correct: kept winner ($1 at resolution) + sold loser at bid
        const pnlIfCorrect = d.loserBid; // net = $1 + loserBid - $1 cost = loserBid
        // If wrong: kept loser ($0 at resolution) + sold winner at its bid
        const pnlIfWrong = d.winnerBid - 1.0; // net = $0 + winnerBid - $1 = winnerBid - 1
        const actualPnl = wasCorrect ? pnlIfCorrect : pnlIfWrong;

        return {
            secondsBefore: d.secondsBefore,
            predictedLoser: d.predictedLoser,
            loserBid: d.loserBid,
            loserBidSize: d.loserBidSize,
            pnlIfCorrect,
            pnlIfWrong,
            wasCorrect,
            actualPnl,
        };
    });

    // Summary
    const b30 = stratB_checkpoints.find(c => c.secondsBefore === 30);
    const b10 = stratB_checkpoints.find(c => c.secondsBefore === 10);
    console.log(
        `    >>> ${actualOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `SplitA: ${(stratA.pnl * 100).toFixed(1)}c | ` +
        `SplitB@30s: ${b30 ? (b30.wasCorrect ? '+' : '') + (b30.actualPnl * 100).toFixed(0) + 'c' : 'N/A'} | ` +
        `SplitB@10s: ${b10 ? (b10.wasCorrect ? '+' : '') + (b10.actualPnl * 100).toFixed(0) + 'c' : 'N/A'}`
    );

    return {
        index, timestamp: Date.now(), question: market.question,
        volume, actualOutcome, openClPrice, closeClPrice,
        stratA, stratB_checkpoints,
    };
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('SPLIT-BASED STRADDLE STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Candles: ${results.length}\n`);

    // Strategy A: instant split + sell both
    const avgStratA = results.reduce((s, r) => s + r.stratA.pnl, 0) / results.length;
    const profitable = results.filter(r => r.stratA.pnl > 0).length;
    console.log('--- Strategy A: Split $1 → Sell Both at Market ---');
    console.log(`  Avg P&L: ${(avgStratA * 100).toFixed(2)}c/pair`);
    console.log(`  Profitable: ${profitable}/${results.length} (${((profitable / results.length) * 100).toFixed(0)}%)`);
    console.log(`  (Negative = the market correctly prices YES+NO > $1 including spread)\n`);

    // Strategy B: split + sell loser at various checkpoints
    console.log('--- Strategy B: Split $1 → Wait → Sell Predicted Loser ---');
    console.log(`${'Time'.padStart(5)} | ${'Acc'.padEnd(10)} | ${'Avg P&L'.padEnd(10)} | ${'Loser Bid'.padEnd(10)} | ${'≤30c Acc'.padEnd(10)} | ${'≤30c P&L'.padEnd(10)} | ${'≤30c Trades'.padEnd(12)}`);
    console.log('-'.repeat(85));
    for (const cp of [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10]) {
        const trades = results.flatMap(r => r.stratB_checkpoints.filter(c => c.secondsBefore === cp));
        if (trades.length === 0) continue;
        const correct = trades.filter(t => t.wasCorrect).length;
        const totalPnl = trades.reduce((s, t) => s + t.actualPnl, 0);
        const avgPnl = totalPnl / trades.length;
        const avgLoserBid = trades.filter(t => t.wasCorrect).reduce((s, t) => s + t.loserBid, 0) / (correct || 1);

        // Filtered: only trades where loser bid ≤ 30c
        const filtered = trades.filter(t => t.loserBid <= 0.30);
        const filtCorrect = filtered.filter(t => t.wasCorrect).length;
        const filtPnl = filtered.length > 0 ? filtered.reduce((s, t) => s + t.actualPnl, 0) / filtered.length : 0;

        console.log(
            `${String(cp).padStart(4)}s | ` +
            `${correct}/${trades.length} (${((correct / trades.length) * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${(avgPnl * 100).toFixed(1)}c`.padEnd(10) + ' | ' +
            `${(avgLoserBid * 100).toFixed(0)}c`.padEnd(10) + ' | ' +
            `${filtered.length > 0 ? `${filtCorrect}/${filtered.length} (${((filtCorrect / filtered.length) * 100).toFixed(0)}%)` : 'N/A'}`.padEnd(10) + ' | ' +
            `${filtered.length > 0 ? `${(filtPnl * 100).toFixed(1)}c` : 'N/A'}`.padEnd(10) + ' | ' +
            `${filtered.length}/${trades.length}`
        );
    }

    // Expected value comparison: which checkpoint maximizes EV?
    console.log('\n--- Expected Value per $100 Split (with ≤30c filter) ---');
    for (const cp of [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10]) {
        const trades = results.flatMap(r => r.stratB_checkpoints.filter(c => c.secondsBefore === cp));
        const filtered = trades.filter(t => t.loserBid <= 0.30);
        if (filtered.length < 3) continue;

        const filtCorrect = filtered.filter(t => t.wasCorrect).length;
        const accuracy = filtCorrect / filtered.length;
        const avgWinBid = filtered.filter(t => t.wasCorrect).reduce((s, t) => s + t.loserBid, 0) / (filtCorrect || 1);
        const avgLossBid = filtered.filter(t => !t.wasCorrect).reduce((s, t) => s + t.loserBid, 0) / ((filtered.length - filtCorrect) || 1);

        const winPayout = avgWinBid * 100;     // $ won per correct trade on $100 split
        const lossAmount = (1 - avgLossBid) * 100; // $ lost per wrong trade on $100 split
        const ev = accuracy * winPayout - (1 - accuracy) * lossAmount;
        const skipRate = 1 - (filtered.length / trades.length);

        console.log(
            `  T-${String(cp).padStart(3)}s: ` +
            `Acc ${(accuracy * 100).toFixed(0)}% | ` +
            `Win: +$${winPayout.toFixed(2)} | Loss: -$${lossAmount.toFixed(2)} | ` +
            `EV: $${ev >= 0 ? '+' : ''}${ev.toFixed(2)}/trade | ` +
            `Skip: ${(skipRate * 100).toFixed(0)}% | ` +
            `(n=${filtered.length})`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '50');
    console.log(`=== Split-Based Straddle Study: ${NUM_CANDLES} candles ===`);
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

        if (intoCandle > 100) { // Wait for next candle if >100s in (need T-180s checkpoint)
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
