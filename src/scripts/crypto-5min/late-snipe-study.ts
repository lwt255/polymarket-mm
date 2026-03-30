/**
 * Late Snipe Study: Buy near-certain outcomes late in the candle.
 *
 * At 240-280 seconds into a candle, the outcome is often ~80-95% certain.
 * Using the Chainlink feed, we can VERIFY the likely outcome.
 * Post a maker bid at 85-95c on the winning side → earn 5-15c if correct.
 *
 * Risk: BTC reverses in the last 20-60 seconds.
 * Mitigation: Only enter when Chainlink price confirms large enough margin.
 *
 * Also tests: buying the LOSING side cheaply for rare reversals.
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

interface BookLevel {
    bestBid: number;
    bestAsk: number;
    midpoint: number;
    spread: number;
}

async function getBook(tokenId: string): Promise<BookLevel> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, midpoint: 0.5, spread: 1 };
    const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
    const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
    const bestBid = bids[0] ?? 0;
    const bestAsk = asks[0] ?? 1;
    return { bestBid, bestAsk, midpoint: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid };
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

interface SnipeOpportunity {
    candleIndex: number;
    secondsLeft: number;
    chainlinkPrice: number;
    openPrice: number;         // Candle open (chainlink at start)
    chainlinkMove: number;     // Current - Open
    upMid: number;
    downMid: number;
    predictedOutcome: 'UP' | 'DOWN';
    confidence: number;        // Based on how far Chainlink is from open
    winnerBid: number;         // Best bid on predicted winner
    winnerAsk: number;         // Best ask on predicted winner
    loserBid: number;          // Best bid on predicted loser
    loserAsk: number;          // Best ask on predicted loser
}

interface CandleResult {
    index: number;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openChainlink: number;
    closeChainlink: number;
    opportunities: SnipeOpportunity[];
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<CandleResult | null> {
    const market = await findCurrentMarket();
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    if (!upToken || !downToken) return null;

    const endDate = new Date(market.endDate);
    console.log(`\n  Candle ${candleIndex}: ${market.question}`);

    let openChainlink: number | null = null;
    const opportunities: SnipeOpportunity[] = [];

    const POLL_INTERVAL = 2000;
    const maxPolls = 160;

    // Phase 1: Wait and collect open price in first 10 seconds
    // Phase 2: Monitor throughout candle
    // Phase 3: Focus on late-candle opportunities (last 60 seconds)

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;
        if (secondsLeft < -5) break;

        const clPrice = chainlink.getPrice();
        if (!openChainlink && clPrice > 0) {
            openChainlink = clPrice;
        }
        if (!openChainlink) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            continue;
        }

        const secondsInto = 300 - secondsLeft;
        const chainlinkMove = clPrice - openChainlink;

        // Only analyze late-candle opportunities (after 180 seconds = 3 minutes)
        if (secondsInto >= 180 && secondsLeft > 2) {
            try {
                const [upBook, downBook] = await Promise.all([
                    getBook(upToken),
                    getBook(downToken),
                ]);

                const predictedOutcome = chainlinkMove >= 0 ? 'UP' : 'DOWN';
                const absMoveUSD = Math.abs(chainlinkMove);

                // Confidence: how many $ BTC has moved relative to what's needed to reverse
                // BTC needs to move back |chainlinkMove| + epsilon to change outcome
                // With X seconds left, and vol ~0.50 annualized, expected move = vol * price * sqrt(T)
                const expectedMove5min = clPrice * 0.50 * Math.sqrt(secondsLeft / (365.25 * 24 * 3600));
                const confidence = absMoveUSD > 0 ? Math.min(0.99, 0.5 + absMoveUSD / (2 * expectedMove5min)) : 0.50;

                const opp: SnipeOpportunity = {
                    candleIndex,
                    secondsLeft,
                    chainlinkPrice: clPrice,
                    openPrice: openChainlink,
                    chainlinkMove,
                    upMid: upBook.midpoint,
                    downMid: downBook.midpoint,
                    predictedOutcome,
                    confidence,
                    winnerBid: predictedOutcome === 'UP' ? upBook.bestBid : downBook.bestBid,
                    winnerAsk: predictedOutcome === 'UP' ? upBook.bestAsk : downBook.bestAsk,
                    loserBid: predictedOutcome === 'UP' ? downBook.bestBid : upBook.bestBid,
                    loserAsk: predictedOutcome === 'UP' ? downBook.bestAsk : upBook.bestAsk,
                };

                opportunities.push(opp);

                // Log key snapshots
                if (p % 5 === 0) {
                    console.log(
                        `    ${Math.round(secondsLeft).toString().padStart(3)}s left | ` +
                        `CL: ${chainlinkMove >= 0 ? '+' : ''}$${chainlinkMove.toFixed(2)} | ` +
                        `Conf: ${(confidence * 100).toFixed(0)}% ${predictedOutcome} | ` +
                        `Winner: ${opp.winnerBid.toFixed(2)}/${opp.winnerAsk.toFixed(2)} | ` +
                        `Loser: ${opp.loserBid.toFixed(2)}/${opp.loserAsk.toFixed(2)}`
                    );
                }
            } catch {}
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 8000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';

    // Infer from chainlink if unknown
    if (outcome === 'UNKNOWN' && openChainlink && chainlink.getPrice() > 0) {
        outcome = chainlink.getPrice() >= openChainlink ? 'UP' : 'DOWN';
    }

    const volume = parseFloat(resolved?.[0]?.volume || '0');
    console.log(`    → Resolved: ${outcome} | Vol: $${volume.toFixed(0)}`);

    return {
        index: candleIndex,
        outcome,
        volume,
        openChainlink: openChainlink || 0,
        closeChainlink: chainlink.getPrice(),
        opportunities,
    };
}

function analyzeResults(results: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('LATE SNIPE ANALYSIS');
    console.log('='.repeat(80));

    const allOpps = results.flatMap(r => r.opportunities.map(o => ({ ...o, actualOutcome: r.outcome })));
    console.log(`\nCandles: ${results.length} | Late-candle snapshots: ${allOpps.length}`);

    // 1. How accurate is our Chainlink-based prediction?
    console.log('\n--- Prediction Accuracy by Time Remaining ---');
    const timeBuckets = [
        { min: 90, max: 120, label: '90-120s left' },
        { min: 60, max: 90, label: '60-90s left' },
        { min: 30, max: 60, label: '30-60s left' },
        { min: 10, max: 30, label: '10-30s left' },
        { min: 0, max: 10, label: '0-10s left' },
    ];

    for (const bucket of timeBuckets) {
        const inBucket = allOpps.filter(o => o.secondsLeft >= bucket.min && o.secondsLeft < bucket.max);
        if (inBucket.length === 0) continue;
        const correct = inBucket.filter(o => o.predictedOutcome === o.actualOutcome).length;
        const avgConf = inBucket.reduce((s, o) => s + o.confidence, 0) / inBucket.length;
        const avgWinnerBid = inBucket.reduce((s, o) => s + o.winnerBid, 0) / inBucket.length;
        const avgLoserAsk = inBucket.reduce((s, o) => s + o.loserAsk, 0) / inBucket.length;

        console.log(
            `  ${bucket.label.padEnd(14)} | ` +
            `Accuracy: ${correct}/${inBucket.length} (${((correct / inBucket.length) * 100).toFixed(0)}%) | ` +
            `Avg confidence: ${(avgConf * 100).toFixed(0)}% | ` +
            `Winner bid: ${(avgWinnerBid * 100).toFixed(0)}c | ` +
            `Loser ask: ${(avgLoserAsk * 100).toFixed(0)}c`
        );
    }

    // 2. Strategy: Buy winner at best bid (maker) when confidence > threshold
    console.log('\n--- Strategy: Buy Winner at Bid (Maker, 0% fee) ---');

    const thresholds = [0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90];

    for (const threshold of thresholds) {
        const trades = allOpps.filter(o =>
            o.confidence >= threshold &&
            o.secondsLeft >= 10 && o.secondsLeft <= 90  // sweet spot
        );

        if (trades.length === 0) continue;

        let pnl = 0;
        let wins = 0;
        for (const t of trades) {
            const buyPrice = t.winnerBid;  // We buy at the maker bid price
            const correct = t.predictedOutcome === t.actualOutcome;
            if (correct) {
                pnl += (1 - buyPrice) * 100;
                wins++;
            } else {
                pnl += -buyPrice * 100;
            }
        }

        console.log(
            `  Conf≥${(threshold * 100).toFixed(0)}%: ` +
            `${trades.length} trades | ` +
            `${wins}/${trades.length} correct (${((wins / trades.length) * 100).toFixed(0)}%) | ` +
            `P&L: $${pnl.toFixed(2)} | ` +
            `Per trade: $${(pnl / trades.length).toFixed(2)}`
        );
    }

    // 3. Strategy: Buy loser cheaply for rare reversals
    console.log('\n--- Strategy: Buy Loser Cheaply (Reversal Bet) ---');

    const loserBuckets = [
        { maxAsk: 0.10, label: 'Loser ≤10c' },
        { maxAsk: 0.15, label: 'Loser ≤15c' },
        { maxAsk: 0.20, label: 'Loser ≤20c' },
        { maxAsk: 0.25, label: 'Loser ≤25c' },
        { maxAsk: 0.30, label: 'Loser ≤30c' },
    ];

    for (const bucket of loserBuckets) {
        const trades = allOpps.filter(o =>
            o.loserAsk <= bucket.maxAsk &&
            o.secondsLeft >= 10 && o.secondsLeft <= 60
        );

        if (trades.length === 0) continue;

        let pnl = 0;
        let reversals = 0;
        for (const t of trades) {
            const buyPrice = t.loserAsk;
            const reversed = t.predictedOutcome !== t.actualOutcome;
            if (reversed) {
                pnl += (1 - buyPrice) * 100;
                reversals++;
            } else {
                pnl += -buyPrice * 100;
            }
        }

        console.log(
            `  ${bucket.label}: ` +
            `${trades.length} trades | ` +
            `${reversals} reversals (${((reversals / trades.length) * 100).toFixed(0)}%) | ` +
            `P&L: $${pnl.toFixed(2)} | ` +
            `Per trade: $${(pnl / trades.length).toFixed(2)}`
        );
    }

    // 4. Market efficiency check: is the market price = actual probability?
    console.log('\n--- Market Efficiency: Price vs Actual Probability ---');
    const priceBuckets = [
        { min: 0.60, max: 0.70, label: '60-70c' },
        { min: 0.70, max: 0.80, label: '70-80c' },
        { min: 0.80, max: 0.90, label: '80-90c' },
        { min: 0.90, max: 1.00, label: '90-100c' },
    ];

    for (const bucket of priceBuckets) {
        // All snapshots where the winner midpoint is in this range
        const inBucket = allOpps.filter(o =>
            o.winnerBid >= bucket.min && o.winnerBid < bucket.max
        );
        if (inBucket.length === 0) continue;
        const correctRate = inBucket.filter(o => o.predictedOutcome === o.actualOutcome).length / inBucket.length;
        const avgPrice = inBucket.reduce((s, o) => s + o.winnerBid, 0) / inBucket.length;

        const pricingError = correctRate - avgPrice;
        console.log(
            `  Winner at ${bucket.label}: ` +
            `Actual win rate: ${(correctRate * 100).toFixed(0)}% | ` +
            `Avg price: ${(avgPrice * 100).toFixed(0)}c | ` +
            `${pricingError > 0.02 ? 'UNDERPRICED ✓' : pricingError < -0.02 ? 'OVERPRICED ✗' : 'FAIR ~'} ` +
            `(${(pricingError * 100).toFixed(1)}c gap)`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '8');
    console.log(`=== Late Snipe Study: ${NUM_CANDLES} candles ===\n`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const results: CandleResult[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(i + 1, chainlink);
        if (result) results.push(result);
    }

    chainlink.disconnect();

    if (results.length > 0) {
        analyzeResults(results);
    }
}

main().catch(console.error);
