/**
 * Multi-Candle Study: Monitor multiple consecutive candles
 *
 * Collects data across many candles to find statistical patterns:
 * - When does mispricing peak? (time within candle)
 * - How often does our fair value predict the outcome correctly?
 * - What's the typical edge if we trade at fair value?
 * - Where should we post maker orders for best fill rates?
 */

import { calculateFairValue, calculateRealizedVol } from './fair-value.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

async function getBTCPrice(): Promise<number> {
    const data = await fetchJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    if (data?.price) return parseFloat(data.price);
    return 0;
}

async function getRecentVol(): Promise<number> {
    try {
        const data = await fetchJSON(`https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${new Date(Date.now() - 3600000 * 3).toISOString()}&end=${new Date().toISOString()}`);
        const closes = data.reverse().map((c: any[]) => c[4]);
        return calculateRealizedVol(closes, 5);
    } catch {
        return 0.50;
    }
}

async function findMarketByOffset(offset: number) {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    const ts = rounded + (offset * 300);
    const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
    return data?.[0] || null;
}

async function getBookMidpoint(tokenId: string): Promise<{ mid: number; spread: number; bestBid: number; bestAsk: number }> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { mid: 0.5, spread: 0.01, bestBid: 0.49, bestAsk: 0.51 };

    const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
    const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);

    const bestBid = bids[0] ?? 0;
    const bestAsk = asks[0] ?? 1;
    return { mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid, bestBid, bestAsk };
}

interface CandleSnapshot {
    candleIndex: number;
    secondsIntoCandle: number;
    btcPrice: number;
    btcMove: number;
    fairValue: number;
    marketMid: number;
    spread: number;
    edge: number;        // fair - market (positive = market underpricing Up)
    absEdge: number;
}

interface CandleResult {
    index: number;
    question: string;
    openPrice: number;
    closePrice: number;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    snapshots: CandleSnapshot[];
    avgEdge: number;
    maxEdge: number;
    fairValueCorrect: boolean;  // Did our average fair value predict the right outcome?
}

async function monitorCandle(candleIndex: number, vol: number): Promise<CandleResult | null> {
    // Find the current candle
    const market = await findMarketByOffset(0);
    if (!market) {
        console.log(`  Candle ${candleIndex}: No market found`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const eventStart = market.eventStartTime ? new Date(market.eventStartTime) : new Date(market.endDate);
    const endDate = new Date(market.endDate);

    console.log(`  Candle ${candleIndex}: ${market.question}`);

    const snapshots: CandleSnapshot[] = [];
    let openPrice: number | null = null;

    // Poll every 3 seconds
    const POLL_INTERVAL = 3000;
    const maxPolls = 120; // 360 seconds max

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;

        if (secondsLeft < -5) break; // Market expired

        try {
            const [btcPrice, book] = await Promise.all([
                getBTCPrice(),
                getBookMidpoint(upToken),
            ]);

            if (!openPrice) openPrice = btcPrice;

            const minLeft = Math.max(0.01, secondsLeft / 60);
            const btcMove = btcPrice - openPrice;

            const fv = calculateFairValue({
                spotPrice: btcPrice,
                strikePrice: openPrice,
                timeToExpiryMin: minLeft,
                annualizedVol: vol,
            });

            const edge = fv.fairPrice - book.mid;
            const secondsIntoCandle = 300 - secondsLeft;

            snapshots.push({
                candleIndex,
                secondsIntoCandle,
                btcPrice,
                btcMove,
                fairValue: fv.fairPrice,
                marketMid: book.mid,
                spread: book.spread,
                edge,
                absEdge: Math.abs(edge),
            });

            // Compact log every 15 seconds
            if (p % 5 === 0) {
                const marker = fv.fairPrice > 0.6 ? '^^' : fv.fairPrice < 0.4 ? 'vv' : '--';
                process.stdout.write(
                    `    ${Math.round(secondsIntoCandle).toString().padStart(3)}s | ` +
                    `BTC:${btcMove >= 0 ? '+' : ''}${btcMove.toFixed(0).padStart(4)} | ` +
                    `Fair:${(fv.fairPrice * 100).toFixed(0).padStart(3)}% | ` +
                    `Mkt:${(book.mid * 100).toFixed(0).padStart(3)}% | ` +
                    `Edge:${(edge * 100).toFixed(1).padStart(5)}% ${marker}\n`
                );
            }
        } catch {
            // Silently continue on errors
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Check resolution
    await new Promise(r => setTimeout(r, 5000)); // Wait for resolution
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const finalPrices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    const outcome: 'UP' | 'DOWN' | 'UNKNOWN' = finalPrices[0] >= 0.95 ? 'UP' : finalPrices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    const finalVol = parseFloat(resolved?.[0]?.volume || '0');

    const avgEdge = snapshots.length > 0 ? snapshots.reduce((sum, s) => sum + s.absEdge, 0) / snapshots.length : 0;
    const maxEdge = snapshots.length > 0 ? Math.max(...snapshots.map(s => s.absEdge)) : 0;

    // Was our average fair value correct?
    const avgFV = snapshots.length > 0 ? snapshots.reduce((sum, s) => sum + s.fairValue, 0) / snapshots.length : 0.5;
    const ourCall = avgFV > 0.5 ? 'UP' : 'DOWN';
    const fairValueCorrect = ourCall === outcome;

    console.log(`    Result: ${outcome} | Volume: $${finalVol.toFixed(0)} | Avg Edge: ${(avgEdge * 100).toFixed(1)}% | FV Correct: ${fairValueCorrect}`);
    console.log('');

    return {
        index: candleIndex,
        question: market.question,
        openPrice: openPrice || 0,
        closePrice: snapshots[snapshots.length - 1]?.btcPrice || 0,
        outcome,
        volume: finalVol,
        snapshots,
        avgEdge,
        maxEdge,
        fairValueCorrect,
    };
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '5');
    console.log(`=== Multi-Candle Study: Monitoring ${NUM_CANDLES} consecutive 5-min BTC candles ===\n`);

    const vol = await getRecentVol();
    console.log(`Realized vol: ${(vol * 100).toFixed(1)}% annualized\n`);

    const results: CandleResult[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        // Wait for the next candle to start
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const waitMs = nextCandle - now + 2000; // +2s buffer after candle starts

        if (waitMs > 0 && waitMs < 300000) {
            console.log(`Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...\n`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        // Update vol periodically
        const currentVol = i % 3 === 0 ? await getRecentVol() : vol;

        const result = await monitorCandle(i + 1, currentVol);
        if (result) results.push(result);
    }

    // === AGGREGATE ANALYSIS ===
    console.log('\n' + '='.repeat(70));
    console.log('AGGREGATE ANALYSIS');
    console.log('='.repeat(70));

    console.log(`\nCandles monitored: ${results.length}`);
    const upWins = results.filter(r => r.outcome === 'UP').length;
    const downWins = results.filter(r => r.outcome === 'DOWN').length;
    console.log(`Outcomes: ${upWins} UP / ${downWins} DOWN`);

    const totalVol = results.reduce((sum, r) => sum + r.volume, 0);
    console.log(`Total volume: $${totalVol.toLocaleString()}`);

    const fvCorrect = results.filter(r => r.fairValueCorrect).length;
    console.log(`Fair value prediction accuracy: ${fvCorrect}/${results.length} (${((fvCorrect / results.length) * 100).toFixed(0)}%)`);

    const allEdges = results.map(r => r.avgEdge);
    console.log(`\nAvg absolute edge: ${(allEdges.reduce((a, b) => a + b, 0) / allEdges.length * 100).toFixed(2)}%`);
    console.log(`Max edge seen: ${(Math.max(...results.map(r => r.maxEdge)) * 100).toFixed(2)}%`);

    // Edge by time bucket (seconds into candle)
    console.log('\n=== Edge by Time (seconds into candle) ===');
    const allSnapshots = results.flatMap(r => r.snapshots);
    const buckets = [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300];
    for (let b = 0; b < buckets.length - 1; b++) {
        const low = buckets[b];
        const high = buckets[b + 1];
        const inBucket = allSnapshots.filter(s => s.secondsIntoCandle >= low && s.secondsIntoCandle < high);
        if (inBucket.length === 0) continue;
        const avgAbsEdge = inBucket.reduce((sum, s) => sum + s.absEdge, 0) / inBucket.length;
        const avgSpread = inBucket.reduce((sum, s) => sum + s.spread, 0) / inBucket.length;
        const bar = '#'.repeat(Math.round(avgAbsEdge * 200));
        console.log(
            `  ${low.toString().padStart(3)}s-${high.toString().padStart(3)}s | ` +
            `Avg edge: ${(avgAbsEdge * 100).toFixed(2).padStart(6)}% | ` +
            `Avg spread: ${(avgSpread * 100).toFixed(2).padStart(5)}c | ` +
            `Edge/Spread: ${(avgAbsEdge / avgSpread).toFixed(1).padStart(5)}x | ${bar}`
        );
    }

    // Simulated P&L: What if we bought/sold at fair value every snapshot?
    console.log('\n=== Simulated Strategy P&L ===');
    console.log('Strategy: Post maker bid/ask at fair value, assume fills when edge > 2%');

    let trades = 0;
    let wins = 0;
    let totalPnL = 0;

    for (const result of results) {
        for (const snap of result.snapshots) {
            // Only trade when edge > 2% (minimum viable edge)
            if (snap.absEdge < 0.02) continue;

            trades++;
            // If our fair value was > market, we'd buy Up at market
            // If fair value < market, we'd sell Up at market
            const buyUp = snap.edge > 0;
            const resolved = result.outcome === 'UP';

            if ((buyUp && resolved) || (!buyUp && !resolved)) {
                // Correct: we earn (1 - entryPrice) for buying, or (entryPrice) for selling
                const pnl = buyUp ? (1 - snap.marketMid) : snap.marketMid;
                totalPnL += pnl;
                wins++;
            } else {
                // Wrong: we lose our cost
                const pnl = buyUp ? -snap.marketMid : -(1 - snap.marketMid);
                totalPnL += pnl;
            }
        }
    }

    console.log(`Trades: ${trades}`);
    console.log(`Win rate: ${wins}/${trades} (${((wins / trades) * 100).toFixed(1)}%)`);
    console.log(`Total P&L: $${totalPnL.toFixed(2)} (per $1 per trade)`);
    console.log(`Avg P&L per trade: $${(totalPnL / trades).toFixed(4)}`);

    // More realistic: maker only, with $100 per trade
    console.log('\nRealistic P&L ($100 per trade, maker fills at fair value, 0% maker fee):');
    let realisticPnL = 0;
    let realisticTrades = 0;
    for (const result of results) {
        // Only use snapshots from minutes 1-4 (not first 30s or last 30s)
        const midSnapshots = result.snapshots.filter(s => s.secondsIntoCandle >= 30 && s.secondsIntoCandle <= 270);

        for (const snap of midSnapshots) {
            if (snap.absEdge < 0.03) continue; // Require 3% edge for makers

            realisticTrades++;
            const buyUp = snap.edge > 0;
            const resolved = result.outcome === 'UP';
            const entryPrice = snap.fairValue; // Maker fills at our posted price

            if ((buyUp && resolved) || (!buyUp && !resolved)) {
                realisticPnL += (buyUp ? (1 - entryPrice) : entryPrice) * 100;
            } else {
                realisticPnL += (buyUp ? -entryPrice : -(1 - entryPrice)) * 100;
            }
        }
    }

    console.log(`Trades: ${realisticTrades}`);
    console.log(`Total P&L: $${realisticPnL.toFixed(2)}`);
    if (realisticTrades > 0) {
        console.log(`Avg P&L per trade: $${(realisticPnL / realisticTrades).toFixed(2)}`);
    }
}

main().catch(console.error);
