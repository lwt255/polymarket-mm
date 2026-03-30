/**
 * Late-Candle Snipe Study v2
 *
 * Tests: If you wait until the last 10-30 seconds, can you predict the winner
 * from the Chainlink feed and place a maker order at 90-95c that fills?
 *
 * Records at multiple time-before-end checkpoints:
 *   - Chainlink price direction (vs candle open)
 *   - Book state (best bid/ask on winning side)
 *   - Whether a maker order at various prices would fill
 *   - Final resolution correctness
 *
 * NO ORDERS PLACED. Read-only observation.
 *
 * Run: npx tsx src/scripts/crypto-5min/late-snipe-v2-study.ts [numCandles]
 * Or with pm2: pm2 start --no-autorestart --name snipe-study "npx tsx src/scripts/crypto-5min/late-snipe-v2-study.ts 100"
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'late-snipe-v2-results.json';

// Checkpoints: seconds before candle end
const CHECKPOINTS = [60, 45, 30, 20, 15, 10, 5];
// Maker prices to test
const MAKER_PRICES = [0.90, 0.92, 0.93, 0.95, 0.97];

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

async function getBook(tokenId: string): Promise<{ bestBid: number; bestAsk: number; bidSize: number; askSize: number } | null> {
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

interface CheckpointData {
    secondsBefore: number;
    clPrice: number;
    clDirection: 'UP' | 'DOWN'; // predicted winner based on CL
    clMoveDollars: number;
    // Book state for the predicted winning token
    winnerBestBid: number;
    winnerBestAsk: number;
    winnerAskSize: number;
    // Book state for the predicted losing token
    loserBestBid: number;
    loserBestAsk: number;
    // Could a maker order at these prices be in the book?
    // (maker BUY at price X means you'd be a bid — would you get filled if price keeps moving your way?)
    makerFillChances: { price: number; wouldBeMaker: boolean; currentAsk: number }[];
}

interface CandleResult {
    index: number;
    timestamp: number;
    question: string;
    openClPrice: number;
    closeClPrice: number;
    actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    checkpoints: CheckpointData[];
    // For each checkpoint, was the CL direction prediction correct?
    predictions: { secondsBefore: number; predicted: string; actual: string; correct: boolean }[];
}

async function monitorCandle(index: number, chainlink: ChainlinkFeed): Promise<CandleResult | null> {
    const market = await findCurrentMarket();
    if (!market) { console.log(`  Candle ${index}: No market found`); return null; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    if (!upToken || !downToken) return null;

    const endTime = new Date(market.endDate).getTime();
    console.log(`  Candle ${index}: ${market.question}`);

    // Wait for candle to get going, capture open price
    const openClPrice = chainlink.getPrice();
    if (openClPrice <= 0) { console.log('    No CL price'); return null; }

    // Collect checkpoints
    const checkpoints: CheckpointData[] = [];
    const capturedCheckpoints = new Set<number>();

    // Poll frequently in the last 70 seconds
    while (true) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;

        if (secondsLeft < -2) break;

        // Check if we should capture a checkpoint
        for (const cp of CHECKPOINTS) {
            if (!capturedCheckpoints.has(cp) && secondsLeft <= cp + 0.5 && secondsLeft >= cp - 1.5) {
                capturedCheckpoints.add(cp);

                const clPrice = chainlink.getPrice();
                const clMove = clPrice - openClPrice;
                const clDirection: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';

                // Get books for both tokens
                const upBook = await getBook(upToken);
                const downBook = await getBook(downToken);

                if (upBook && downBook) {
                    const winnerBook = clDirection === 'UP' ? upBook : downBook;
                    const loserBook = clDirection === 'UP' ? downBook : upBook;

                    const makerFillChances = MAKER_PRICES.map(price => ({
                        price,
                        wouldBeMaker: price < winnerBook.bestAsk, // below ask = maker
                        currentAsk: winnerBook.bestAsk,
                    }));

                    checkpoints.push({
                        secondsBefore: cp,
                        clPrice,
                        clDirection,
                        clMoveDollars: clMove,
                        winnerBestBid: winnerBook.bestBid,
                        winnerBestAsk: winnerBook.bestAsk,
                        winnerAskSize: winnerBook.askSize,
                        loserBestBid: loserBook.bestBid,
                        loserBestAsk: loserBook.bestAsk,
                        makerFillChances,
                    });

                    const bookPrice = winnerBook.bestAsk;
                    console.log(
                        `    ${cp}s left | CL: ${clDirection} ($${Math.abs(clMove).toFixed(0)}) | ` +
                        `Winner ask: ${(bookPrice * 100).toFixed(0)}c | ` +
                        `Loser bid: ${(loserBook.bestBid * 100).toFixed(0)}c`
                    );
                }
            }
        }

        // Poll every 500ms in the last 70s, otherwise every 2s
        await new Promise(r => setTimeout(r, secondsLeft < 70 ? 500 : 2000));
    }

    // Wait for resolution
    await new Promise(r => setTimeout(r, 8000));
    const closeClPrice = chainlink.getPrice();

    // Get resolution
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let actualOutcome: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
    if (prices[0] >= 0.95) actualOutcome = 'UP';
    else if (prices[1] >= 0.95) actualOutcome = 'DOWN';
    else if (closeClPrice >= openClPrice) actualOutcome = 'UP';
    else actualOutcome = 'DOWN';

    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Calculate prediction accuracy at each checkpoint
    const predictions = checkpoints.map(cp => ({
        secondsBefore: cp.secondsBefore,
        predicted: cp.clDirection,
        actual: actualOutcome,
        correct: cp.clDirection === actualOutcome,
    }));

    const result: CandleResult = {
        index, timestamp: Date.now(), question: market.question,
        openClPrice, closeClPrice, actualOutcome, volume,
        checkpoints, predictions,
    };

    // Summary
    const correctAt10 = predictions.find(p => p.secondsBefore === 10);
    const correctAt30 = predictions.find(p => p.secondsBefore === 30);
    const winnerAskAt10 = checkpoints.find(c => c.secondsBefore === 10);
    console.log(
        `    >>> ${actualOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `30s: ${correctAt30?.correct ? 'CORRECT' : 'WRONG'} | ` +
        `10s: ${correctAt10?.correct ? 'CORRECT' : 'WRONG'} | ` +
        `Winner ask@10s: ${winnerAskAt10 ? (winnerAskAt10.winnerBestAsk * 100).toFixed(0) + 'c' : 'N/A'}`
    );

    return result;
}

function printAnalysis(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('LATE-CANDLE SNIPE STUDY — ANALYSIS');
    console.log('='.repeat(80));
    console.log(`Candles: ${results.length}\n`);

    // Prediction accuracy by checkpoint
    console.log('--- Direction Prediction Accuracy by Time Before End ---');
    for (const cp of CHECKPOINTS) {
        const preds = results.flatMap(r => r.predictions.filter(p => p.secondsBefore === cp));
        const correct = preds.filter(p => p.correct).length;
        if (preds.length > 0) {
            console.log(`  ${String(cp).padStart(3)}s before end: ${correct}/${preds.length} correct (${((correct / preds.length) * 100).toFixed(1)}%)`);
        }
    }

    // Book pricing at each checkpoint (winner's ask)
    console.log('\n--- Winner Token Ask Price at Each Checkpoint ---');
    for (const cp of CHECKPOINTS) {
        const asks = results.flatMap(r => r.checkpoints.filter(c => c.secondsBefore === cp)).map(c => c.winnerBestAsk);
        if (asks.length > 0) {
            const avg = asks.reduce((a, b) => a + b, 0) / asks.length;
            const min = Math.min(...asks);
            const max = Math.max(...asks);
            console.log(`  ${String(cp).padStart(3)}s: avg ${(avg * 100).toFixed(1)}c | min ${(min * 100).toFixed(0)}c | max ${(max * 100).toFixed(0)}c`);
        }
    }

    // Profit simulation: if you bought winner at its ask at each checkpoint
    console.log('\n--- Simulated P&L: Buy Winner at Ask (Resolves to $1) ---');
    for (const cp of CHECKPOINTS) {
        const trades = results.map(r => {
            const checkpoint = r.checkpoints.find(c => c.secondsBefore === cp);
            const pred = r.predictions.find(p => p.secondsBefore === cp);
            if (!checkpoint || !pred) return null;
            const cost = checkpoint.winnerBestAsk;
            const profit = pred.correct ? (1 - cost) : -cost;
            return { cost, profit, correct: pred.correct };
        }).filter(Boolean) as { cost: number; profit: number; correct: boolean }[];

        if (trades.length > 0) {
            const totalPnl = trades.reduce((s, t) => s + t.profit, 0);
            const wins = trades.filter(t => t.correct).length;
            const avgCost = trades.reduce((s, t) => s + t.cost, 0) / trades.length;
            console.log(
                `  ${String(cp).padStart(3)}s: ${wins}/${trades.length} wins (${((wins / trades.length) * 100).toFixed(0)}%) | ` +
                `Avg cost: ${(avgCost * 100).toFixed(1)}c | ` +
                `Total P&L: $${totalPnl.toFixed(2)} per share | ` +
                `Per candle: $${(totalPnl / trades.length).toFixed(4)}`
            );
        }
    }

    // Maker order simulation: buy at fixed price on winning side
    console.log('\n--- Simulated P&L: Maker Buy at Fixed Price on Predicted Winner ---');
    console.log('  (Only fills if ask <= your price at the checkpoint)');
    for (const makerPrice of MAKER_PRICES) {
        for (const cp of [30, 20, 10]) {
            const trades = results.map(r => {
                const checkpoint = r.checkpoints.find(c => c.secondsBefore === cp);
                const pred = r.predictions.find(p => p.secondsBefore === cp);
                if (!checkpoint || !pred) return null;
                // Would your maker order fill? Only if the ask is at or below your price
                const wouldFill = checkpoint.winnerBestAsk <= makerPrice;
                if (!wouldFill) return { filled: false, profit: 0 };
                const profit = pred.correct ? (1 - makerPrice) : -makerPrice;
                return { filled: true, profit, correct: pred.correct };
            }).filter(Boolean) as { filled: boolean; profit: number; correct?: boolean }[];

            const filled = trades.filter(t => t.filled);
            if (filled.length > 0) {
                const totalPnl = filled.reduce((s, t) => s + t.profit, 0);
                const wins = filled.filter(t => t.correct).length;
                console.log(
                    `  ${(makerPrice * 100).toFixed(0)}c @ ${cp}s: ` +
                    `${filled.length}/${trades.length} filled | ` +
                    `${wins}/${filled.length} wins | ` +
                    `P&L: $${totalPnl.toFixed(2)}/share ($${(totalPnl / trades.length).toFixed(4)}/candle)`
                );
            }
        }
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '50');
    console.log(`=== Late-Candle Snipe Study v2: ${NUM_CANDLES} candles ===`);
    console.log(`Started: ${new Date().toLocaleString()}`);
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
    if (remaining <= 0) {
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

        // Wait for candle start if we're late
        if (intoCandle > 200) {
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
