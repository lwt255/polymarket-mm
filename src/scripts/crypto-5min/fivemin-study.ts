/**
 * 5-Minute BTC Market Study (New Regime)
 *
 * Same structure as fifteenmin-study.ts but for 5-minute markets.
 * Captures real order book data at key checkpoints to understand
 * how the market is pricing in the new high-reversal regime.
 *
 * Tracks:
 *   - CL direction accuracy at checkpoints (180s, 120s, 90s, 60s, 45s, 30s, 20s, 15s, 10s, 5s)
 *   - Winner ask price at each checkpoint (entry cost for buy-winner)
 *   - Loser bid price at each checkpoint (split strategy exit / underdog value)
 *   - Book depth and spread dynamics over the candle
 *   - BTC move size at each checkpoint
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/fivemin-study.ts [numCandles]
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'fivemin-study-results.json';

const CHECKPOINTS = [180, 120, 90, 60, 45, 30, 20, 15, 10, 5];

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300; // 5-min intervals
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
    mid: number;
    bidSize: number;
    askSize: number;
    totalBidDepth: number;
    totalAskDepth: number;
}

async function getBook(tokenId: string): Promise<BookState | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (raw.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    const totalBidDepth = bids.reduce((s: number, b: any) => s + parseFloat(b.size), 0);
    const totalAskDepth = asks.reduce((s: number, a: any) => s + parseFloat(a.size), 0);
    return {
        bestBid, bestAsk,
        mid: (bestBid + bestAsk) / 2,
        bidSize: parseFloat(bids[0]?.size || '0'),
        askSize: parseFloat(asks[0]?.size || '0'),
        totalBidDepth,
        totalAskDepth,
    };
}

interface Checkpoint {
    secondsBefore: number;
    clPrice: number;
    clMove: number;
    clMoveBps: number;
    clDirection: 'UP' | 'DOWN';
    upMid: number;
    upSpread: number;
    downMid: number;
    downSpread: number;
    winnerAsk: number;
    winnerBid: number;
    loserBid: number;
    loserAsk: number;
    loserBidSize: number;
    upBidDepth: number;
    upAskDepth: number;
    downBidDepth: number;
    downAskDepth: number;
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
    accuracy: {
        secondsBefore: number;
        clCorrect: boolean;
        winnerAsk: number;
        winnerBid: number;
        loserBid: number;
        loserAsk: number;
        clMoveBps: number;
        snipePnl: number; // buy winner at ask: (1 - ask) if correct, -ask if wrong
        splitPnl: number; // sell loser at bid: loserBid if correct, -(1-winnerBid) if wrong
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
            if (!captured.has(cp) && secondsLeft <= cp + 0.5 && secondsLeft >= cp - 2) {
                captured.add(cp);

                const clPrice = chainlink.getPrice();
                const clMove = clPrice - openClPrice;
                const clMoveBps = Math.abs(clMove) / openClPrice * 10000;
                const clDirection: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';

                const [upBook, downBook] = await Promise.all([
                    getBook(upToken),
                    getBook(downToken),
                ]);

                if (upBook && downBook) {
                    const winnerAsk = clDirection === 'UP' ? upBook.bestAsk : downBook.bestAsk;
                    const winnerBid = clDirection === 'UP' ? upBook.bestBid : downBook.bestBid;
                    const loserBid = clDirection === 'UP' ? downBook.bestBid : upBook.bestBid;
                    const loserAsk = clDirection === 'UP' ? downBook.bestAsk : upBook.bestAsk;
                    const loserBidSize = clDirection === 'UP' ? downBook.bidSize : upBook.bidSize;

                    checkpoints.push({
                        secondsBefore: cp,
                        clPrice,
                        clMove,
                        clMoveBps,
                        clDirection,
                        upMid: upBook.mid,
                        upSpread: upBook.bestAsk - upBook.bestBid,
                        downMid: downBook.mid,
                        downSpread: downBook.bestAsk - downBook.bestBid,
                        winnerAsk,
                        winnerBid,
                        loserBid,
                        loserAsk,
                        loserBidSize,
                        upBidDepth: upBook.totalBidDepth,
                        upAskDepth: upBook.totalAskDepth,
                        downBidDepth: downBook.totalBidDepth,
                        downAskDepth: downBook.totalAskDepth,
                    });

                    console.log(
                        `    ${String(cp).padStart(4)}s | CL: ${clDirection} (${clMoveBps.toFixed(1)}bps) | ` +
                        `Winner: ${(winnerBid * 100).toFixed(0)}/${(winnerAsk * 100).toFixed(0)}c | ` +
                        `Loser: ${(loserBid * 100).toFixed(0)}/${(loserAsk * 100).toFixed(0)}c (${loserBidSize.toFixed(0)} size)`
                    );
                }
            }
        }

        await new Promise(r => setTimeout(r, secondsLeft < 200 ? 500 : 2000));
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

    const accuracy = checkpoints.map(cp => {
        const clCorrect = cp.clDirection === actualOutcome;
        const snipePnl = clCorrect ? (1 - cp.winnerAsk) : -cp.winnerAsk;
        const splitPnl = clCorrect ? cp.loserBid : (cp.winnerBid - 1);

        return {
            secondsBefore: cp.secondsBefore,
            clCorrect,
            winnerAsk: cp.winnerAsk,
            winnerBid: cp.winnerBid,
            loserBid: cp.loserBid,
            loserAsk: cp.loserAsk,
            clMoveBps: cp.clMoveBps,
            snipePnl,
            splitPnl,
        };
    });

    // Summary
    const at60 = accuracy.find(a => a.secondsBefore === 60);
    const at20 = accuracy.find(a => a.secondsBefore === 20);
    console.log(
        `    >>> ${actualOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `60s: CL=${at60?.clCorrect ? 'OK' : 'X'} ask=${at60 ? (at60.winnerAsk * 100).toFixed(0) + 'c' : 'N/A'} | ` +
        `20s: CL=${at20?.clCorrect ? 'OK' : 'X'} ask=${at20 ? (at20.winnerAsk * 100).toFixed(0) + 'c' : 'N/A'}`
    );

    return {
        index, timestamp: Date.now(), question: market.question,
        openClPrice, closeClPrice, actualOutcome, volume,
        checkpoints, accuracy,
    };
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('5-MINUTE BTC MARKET STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Candles: ${results.length}\n`);

    // CL accuracy at each checkpoint
    console.log('--- CL Direction Accuracy ---');
    for (const cp of CHECKPOINTS) {
        const accs = results.flatMap(r => r.accuracy.filter(a => a.secondsBefore === cp));
        if (accs.length === 0) continue;
        const correct = accs.filter(a => a.clCorrect).length;
        console.log(`  ${String(cp).padStart(4)}s: ${correct}/${accs.length} (${(correct / accs.length * 100).toFixed(0)}%)`);
    }

    // Snipe P&L (buy winner at ask)
    console.log('\n--- Snipe Strategy: Buy CL Winner at Ask ---');
    for (const cp of CHECKPOINTS) {
        const accs = results.flatMap(r => r.accuracy.filter(a => a.secondsBefore === cp));
        if (accs.length === 0) continue;
        const wins = accs.filter(a => a.snipePnl > 0).length;
        const totalPnl = accs.reduce((s, a) => s + a.snipePnl, 0);
        const avgCost = accs.reduce((s, a) => s + a.winnerAsk, 0) / accs.length;
        console.log(
            `  ${String(cp).padStart(4)}s: ${wins}/${accs.length} wins | ` +
            `Avg cost: ${(avgCost * 100).toFixed(0)}c | ` +
            `Total P&L: $${totalPnl.toFixed(2)} | Avg: ${(totalPnl / accs.length * 100).toFixed(1)}c/candle`
        );
    }

    // Split P&L (sell loser at bid)
    console.log('\n--- Split Strategy: Sell CL-Predicted Loser at Bid ---');
    for (const cp of CHECKPOINTS) {
        const accs = results.flatMap(r => r.accuracy.filter(a => a.secondsBefore === cp));
        if (accs.length === 0) continue;
        const correct = accs.filter(a => a.clCorrect).length;
        const sellable = accs.filter(a => a.loserBid > 0);
        const totalPnl = sellable.reduce((s, a) => s + a.splitPnl, 0);
        const avgLoserBid = sellable.filter(a => a.clCorrect).reduce((s, a) => s + a.loserBid, 0) / (sellable.filter(a => a.clCorrect).length || 1);
        console.log(
            `  ${String(cp).padStart(4)}s: ${correct}/${accs.length} correct | ` +
            `Sellable: ${sellable.length}/${accs.length} | ` +
            `Avg loser bid: ${(avgLoserBid * 100).toFixed(0)}c | ` +
            `Total P&L: $${totalPnl.toFixed(2)} | Avg: ${(totalPnl / (sellable.length || 1) * 100).toFixed(1)}c/candle`
        );
    }

    // Move size vs accuracy breakdown
    console.log('\n--- Accuracy by Move Size at T-60s ---');
    const at60 = results.flatMap(r => r.accuracy.filter(a => a.secondsBefore === 60));
    const moveBands = [
        { label: '0-3bps', min: 0, max: 3 },
        { label: '3-5bps', min: 3, max: 5 },
        { label: '5-10bps', min: 5, max: 10 },
        { label: '10-15bps', min: 10, max: 15 },
        { label: '15-20bps', min: 15, max: 20 },
        { label: '20+bps', min: 20, max: 9999 },
    ];
    for (const band of moveBands) {
        const inBand = at60.filter(a => a.clMoveBps >= band.min && a.clMoveBps < band.max);
        if (inBand.length < 3) continue;
        const correct = inBand.filter(a => a.clCorrect).length;
        const avgWinnerAsk = inBand.reduce((s, a) => s + a.winnerAsk, 0) / inBand.length;
        const avgLoserBid = inBand.reduce((s, a) => s + a.loserBid, 0) / inBand.length;
        console.log(
            `  ${band.label.padEnd(8)}: ${correct}/${inBand.length} (${(correct / inBand.length * 100).toFixed(0)}%) | ` +
            `Avg winner ask: ${(avgWinnerAsk * 100).toFixed(0)}c | Avg loser bid: ${(avgLoserBid * 100).toFixed(0)}c`
        );
    }

    // Reversal analysis
    console.log('\n--- Reversals ---');
    const reversals = results.filter(r => {
        const at60cp = r.accuracy.find(a => a.secondsBefore === 60);
        return at60cp && !at60cp.clCorrect;
    });
    console.log(`  Reversal rate: ${reversals.length}/${results.length} (${(reversals.length / results.length * 100).toFixed(1)}%)`);
    if (reversals.length > 0) {
        console.log(`  Reversal details:`);
        for (const r of reversals.slice(-10)) {
            const at60cp = r.accuracy.find(a => a.secondsBefore === 60);
            console.log(
                `    ${r.question} | CL: ${at60cp?.clMoveBps.toFixed(1)}bps | ` +
                `Winner ask: ${at60cp ? (at60cp.winnerAsk * 100).toFixed(0) + 'c' : 'N/A'} | ` +
                `Outcome: ${r.actualOutcome}`
            );
        }
    }

    // Volume stats
    const avgVol = results.reduce((s, r) => s + r.volume, 0) / results.length;
    console.log(`\nAvg volume: $${avgVol.toFixed(0)}`);
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '50');
    console.log(`=== 5-Minute BTC Market Study: ${NUM_CANDLES} candles ===`);
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

        // Wait for next candle if we're past the first checkpoint window
        if (intoCandle > 100) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next 5-min candle...`);
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
