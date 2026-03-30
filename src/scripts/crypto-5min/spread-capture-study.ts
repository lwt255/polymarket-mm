/**
 * Spread Capture Study: Can we profit from market making without predicting direction?
 *
 * Key insight from live-monitor-v2: N(d2) model doesn't work. The market embeds
 * momentum that Black-Scholes ignores. But we don't NEED to predict direction.
 *
 * Friend's hints:
 *   1. "Not about predicting the price" → structural edge
 *   2. "Not about being the first one in" → not latency-sensitive
 *
 * Strategy: Quote both sides of the Up token. If both bid and ask fill before
 * resolution, we pocket the spread regardless of outcome.
 *
 * Also tests: Cross-token arb (buy Up + buy Down < $1.00)
 *
 * This script monitors multiple consecutive candles and tracks:
 *   - Spread width over time
 *   - Fill probability (simulated from volume/depth ratios)
 *   - Overround (Up_ask + Down_ask vs 1.00)
 *   - Simulated maker P&L from spread capture
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

interface BookSnapshot {
    bestBid: number;
    bestAsk: number;
    spread: number;
    midpoint: number;
    bidDepth: number;  // $ within 5c of touch
    askDepth: number;
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
}

async function getFullBook(tokenId: string): Promise<BookSnapshot> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, spread: 1, midpoint: 0.5, bidDepth: 0, askDepth: 0, bids: [], asks: [] };

    const bids = (raw.bids || [])
        .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || [])
        .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const bidDepth = bids.filter((b: any) => b.price >= bestBid - 0.05).reduce((sum: number, b: any) => sum + b.size, 0);
    const askDepth = asks.filter((a: any) => a.price <= bestAsk + 0.05).reduce((sum: number, a: any) => sum + a.size, 0);

    return {
        bestBid, bestAsk,
        spread: bestAsk - bestBid,
        midpoint: (bestBid + bestAsk) / 2,
        bidDepth, askDepth,
        bids, asks,
    };
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    for (const ts of [rounded, rounded + 300]) {
        const slug = `btc-updown-5m-${ts}`;
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data && data.length > 0) {
            const m = data[0];
            const endDate = new Date(m.endDate);
            if (endDate.getTime() > Date.now()) return m;
        }
    }
    return null;
}

interface CandleSpreadData {
    candleIndex: number;
    question: string;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    snapshots: {
        secondsInto: number;
        upBestBid: number;
        upBestAsk: number;
        upSpread: number;
        upBidDepth: number;
        upAskDepth: number;
        downBestBid: number;
        downBestAsk: number;
        downSpread: number;
        overround: number;        // upAsk + downAsk - 1.00 (positive = no arb)
        underround: number;       // 1.00 - upBid - downBid (positive = spread profit possible)
        chainlinkPrice: number;
    }[];
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<CandleSpreadData | null> {
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
    console.log(`\n  Candle ${candleIndex}: ${market.question}`);
    console.log(`  Ends: ${endDate.toLocaleTimeString()}`);

    const snapshots: CandleSpreadData['snapshots'] = [];

    // Header
    console.log('    Time  | Up Bid  Ask  Sprd | Dn Bid  Ask  Sprd | Overrnd | Underrnd | BidDep  AskDep');
    console.log('    ' + '-'.repeat(90));

    const POLL_INTERVAL = 3000;
    const maxPolls = 110;

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;
        if (secondsLeft < -5) break;

        try {
            const [upBook, downBook] = await Promise.all([
                getFullBook(upToken),
                getFullBook(downToken),
            ]);

            const secondsInto = 300 - secondsLeft;
            const overround = upBook.bestAsk + downBook.bestAsk - 1.0;
            const underround = 1.0 - upBook.bestBid - downBook.bestBid;
            const clPrice = chainlink.getPrice();

            snapshots.push({
                secondsInto,
                upBestBid: upBook.bestBid,
                upBestAsk: upBook.bestAsk,
                upSpread: upBook.spread,
                upBidDepth: upBook.bidDepth,
                upAskDepth: upBook.askDepth,
                downBestBid: downBook.bestBid,
                downBestAsk: downBook.bestAsk,
                downSpread: downBook.spread,
                overround,
                underround,
                chainlinkPrice: clPrice,
            });

            // Log every 15 seconds
            if (p % 5 === 0) {
                const sec = Math.round(secondsInto).toString().padStart(4);
                console.log(
                    `    ${sec}s | ` +
                    `${upBook.bestBid.toFixed(2)}  ${upBook.bestAsk.toFixed(2)}  ${(upBook.spread * 100).toFixed(1).padStart(4)}c | ` +
                    `${downBook.bestBid.toFixed(2)}  ${downBook.bestAsk.toFixed(2)}  ${(downBook.spread * 100).toFixed(1).padStart(4)}c | ` +
                    `${(overround * 100).toFixed(1).padStart(5)}c  | ` +
                    `${(underround * 100).toFixed(1).padStart(6)}c  | ` +
                    `$${upBook.bidDepth.toFixed(0).padStart(5)} $${upBook.askDepth.toFixed(0).padStart(5)}`
                );
            }
        } catch {
            // continue
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Check resolution
    await new Promise(r => setTimeout(r, 8000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const finalPrices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    const outcome: 'UP' | 'DOWN' | 'UNKNOWN' = finalPrices[0] >= 0.95 ? 'UP' : finalPrices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    console.log(`    Result: ${outcome} | Volume: $${volume.toFixed(0)}`);

    return {
        candleIndex,
        question: market.question,
        outcome,
        volume,
        snapshots,
    };
}

function analyzeResults(results: CandleSpreadData[]) {
    console.log('\n' + '='.repeat(80));
    console.log('SPREAD CAPTURE ANALYSIS');
    console.log('='.repeat(80));

    const allSnaps = results.flatMap(r => r.snapshots);
    console.log(`\nCandles: ${results.length} | Snapshots: ${allSnaps.length}`);

    // 1. Spread statistics
    const upSpreads = allSnaps.map(s => s.upSpread);
    const avgUpSpread = upSpreads.reduce((a, b) => a + b, 0) / upSpreads.length;
    const minSpread = Math.min(...upSpreads);
    const maxSpread = Math.max(...upSpreads);
    console.log(`\n--- Up Token Spread ---`);
    console.log(`  Avg: ${(avgUpSpread * 100).toFixed(2)}c | Min: ${(minSpread * 100).toFixed(2)}c | Max: ${(maxSpread * 100).toFixed(2)}c`);

    // 2. Overround / Underround
    const overrounds = allSnaps.map(s => s.overround);
    const underrounds = allSnaps.map(s => s.underround);
    const avgOverround = overrounds.reduce((a, b) => a + b, 0) / overrounds.length;
    const avgUnderround = underrounds.reduce((a, b) => a + b, 0) / underrounds.length;
    const arbSnapshots = allSnaps.filter(s => s.overround < 0);
    console.log(`\n--- Cross-Token Pricing ---`);
    console.log(`  Avg Overround (asks):  ${(avgOverround * 100).toFixed(2)}c (positive = takers overpay)`);
    console.log(`  Avg Underround (bids): ${(avgUnderround * 100).toFixed(2)}c (positive = makers underpay)`);
    console.log(`  Arb opportunities (overround < 0): ${arbSnapshots.length}/${allSnaps.length} (${((arbSnapshots.length / allSnaps.length) * 100).toFixed(1)}%)`);
    if (arbSnapshots.length > 0) {
        const avgArb = arbSnapshots.reduce((s, a) => s + Math.abs(a.overround), 0) / arbSnapshots.length;
        console.log(`  Avg arb size: ${(avgArb * 100).toFixed(2)}c`);
    }

    // 3. Spread by time bucket
    console.log(`\n--- Spread by Time in Candle ---`);
    const buckets = [0, 30, 60, 120, 180, 240, 270, 300];
    for (let b = 0; b < buckets.length - 1; b++) {
        const low = buckets[b];
        const high = buckets[b + 1];
        const inBucket = allSnaps.filter(s => s.secondsInto >= low && s.secondsInto < high);
        if (inBucket.length === 0) continue;
        const avgSprd = inBucket.reduce((sum, s) => sum + s.upSpread, 0) / inBucket.length;
        const avgOver = inBucket.reduce((sum, s) => sum + s.overround, 0) / inBucket.length;
        const avgDepth = inBucket.reduce((sum, s) => sum + s.upBidDepth + s.upAskDepth, 0) / inBucket.length;
        console.log(
            `  ${low.toString().padStart(3)}s-${high.toString().padStart(3)}s | ` +
            `Spread: ${(avgSprd * 100).toFixed(2).padStart(5)}c | ` +
            `Overround: ${(avgOver * 100).toFixed(2).padStart(5)}c | ` +
            `Avg Depth: $${avgDepth.toFixed(0).padStart(5)} | ` +
            `${'#'.repeat(Math.round(avgSprd * 200))}`
        );
    }

    // 4. STRATEGY SIMULATIONS
    console.log('\n' + '='.repeat(80));
    console.log('STRATEGY SIMULATIONS');
    console.log('='.repeat(80));

    // Strategy A: Same-token spread capture (buy at bid, sell at ask on Up token)
    // Assumes both sides fill within the candle. Conservative: only count if we
    // have >= 30 seconds for both sides to fill.
    console.log('\n--- Strategy A: Single-Token Spread Capture ---');
    console.log('    Quote bid and ask on Up token. Profit = spread if both fill.');
    console.log('    Risk: Only one side fills, then resolution exposes us directionally.');

    let stratA_pnl = 0;
    let stratA_trades = 0;
    let stratA_singleSideLoss = 0;
    const TRADE_SIZE = 100; // $100 per side

    for (const result of results) {
        // For each candle, simulate quoting at the observed spread
        // Use the average spread and assume we get filled on both sides
        // if there's enough time left (> 60s) and spread > 2c
        const tradableSnaps = result.snapshots.filter(s =>
            s.secondsInto >= 15 && s.secondsInto <= 240 && s.upSpread >= 0.02
        );

        if (tradableSnaps.length === 0) continue;

        // Take the median snapshot as our "entry"
        const midSnap = tradableSnaps[Math.floor(tradableSnaps.length / 2)];

        // Best case: both sides fill → profit = spread * size
        // We model a 60% chance of both sides filling (conservative)
        // and 40% chance only one side fills (we take directional risk)
        const bothFillProb = 0.60;
        const oneSideProb = 0.40;

        // Both fill: guaranteed spread profit
        const spreadProfit = midSnap.upSpread * TRADE_SIZE;

        // One side fill: 50/50 on direction, but our cost basis is mid ± half spread
        // If we bought at bid and market goes down: lose (bid_price) * size → paid for worthless
        // If we bought at bid and market goes up: gain (1 - bid_price) * size
        // Expected one-side PnL = 0.5 * (1 - bid) * size - 0.5 * bid * size = 0.5 * (1 - 2*bid) * size
        // When bid ≈ 0.50: this is ~0, so one-side risk is small near 50/50
        const oneSidePnL = 0.5 * (1 - 2 * midSnap.upBestBid) * TRADE_SIZE;

        const expectedPnL = bothFillProb * spreadProfit + oneSideProb * oneSidePnL;
        stratA_pnl += expectedPnL;
        stratA_trades++;

        if (oneSidePnL < 0) stratA_singleSideLoss += Math.abs(oneSidePnL) * oneSideProb;
    }

    console.log(`    Candles traded: ${stratA_trades}`);
    console.log(`    Expected P&L: $${stratA_pnl.toFixed(2)} ($${(stratA_pnl / Math.max(1, stratA_trades)).toFixed(2)}/candle)`);
    console.log(`    Single-side risk exposure: $${stratA_singleSideLoss.toFixed(2)}`);

    // Strategy B: Cross-token guaranteed profit
    // Buy Up at up_bid and Down at down_bid simultaneously
    // Total cost = up_bid + down_bid. Always get $1.00 back.
    // Profit = 1.00 - (up_ask + down_ask) if both asks < combined < 1.00 (taker)
    // OR we POST bids at prices where up_bid + down_bid < 1.00 (maker, 0% fee)
    console.log('\n--- Strategy B: Cross-Token Arb (Maker) ---');
    console.log('    Post bids on BOTH Up and Down so total < $1.00.');
    console.log('    If both fill: guaranteed profit = 1.00 - total_cost.');

    let stratB_pnl = 0;
    let stratB_opportunities = 0;
    let stratB_avgProfit = 0;

    for (const result of results) {
        for (const snap of result.snapshots) {
            const totalBidCost = snap.upBestBid + snap.downBestBid;
            if (totalBidCost < 1.0) {
                const profit = (1.0 - totalBidCost) * TRADE_SIZE;
                stratB_pnl += profit;
                stratB_opportunities++;
                stratB_avgProfit += 1.0 - totalBidCost;
            }
        }
    }

    console.log(`    Opportunities: ${stratB_opportunities}/${allSnaps.length}`);
    if (stratB_opportunities > 0) {
        console.log(`    Avg profit margin: ${((stratB_avgProfit / stratB_opportunities) * 100).toFixed(2)}c per $1`);
        console.log(`    Total profit (if all fill): $${stratB_pnl.toFixed(2)}`);
        console.log(`    Challenge: Need BOTH sides to fill before resolution`);
    } else {
        console.log(`    No arb found at current bid levels`);
    }

    // Strategy C: Taker arb (buy both asks when < $1.00)
    console.log('\n--- Strategy C: Cross-Token Arb (Taker) ---');
    console.log('    Buy Up ask + Down ask when total < $1.00.');
    console.log('    Instant guaranteed profit, but pay ~10% taker fee.');

    let stratC_opportunities = 0;
    let stratC_grossProfit = 0;

    for (const snap of allSnaps) {
        const totalAskCost = snap.upBestAsk + snap.downBestAsk;
        // Taker fee on each leg: price * (1-price) roughly
        const upFee = snap.upBestAsk * (1 - snap.upBestAsk);
        const downFee = snap.downBestAsk * (1 - snap.downBestAsk);
        const netCost = totalAskCost + upFee + downFee;

        if (netCost < 1.0) {
            stratC_opportunities++;
            stratC_grossProfit += (1.0 - netCost) * TRADE_SIZE;
        }
    }

    console.log(`    Opportunities (after fees): ${stratC_opportunities}/${allSnaps.length}`);
    if (stratC_opportunities > 0) {
        console.log(`    Total profit: $${stratC_grossProfit.toFixed(2)}`);
    }

    // Strategy D: "Be the house" — always quote at 50/50 early in candle
    // At candle open, BTC hasn't moved → fair value IS 50/50
    // Post bid at 0.48, ask at 0.52 on Up token → 4c spread
    // With 0% maker fee, if both fill we make 4% per round trip
    console.log('\n--- Strategy D: Early-Candle "House" Quotes ---');
    console.log('    Post 48c bid / 52c ask on Up token in first 60 seconds.');
    console.log('    At open, true prob IS ~50/50 regardless of model.');

    let stratD_candles = 0;
    let stratD_pnl = 0;
    const HOUSE_BID = 0.48;
    const HOUSE_ASK = 0.52;

    for (const result of results) {
        const earlySnaps = result.snapshots.filter(s => s.secondsInto <= 60);
        if (earlySnaps.length === 0) continue;

        // Check if our quotes would be competitive
        const avgBestBid = earlySnaps.reduce((s, e) => s + e.upBestBid, 0) / earlySnaps.length;
        const avgBestAsk = earlySnaps.reduce((s, e) => s + e.upBestAsk, 0) / earlySnaps.length;

        const bidCompetitive = HOUSE_BID >= avgBestBid; // Our bid needs to be >= market best bid
        const askCompetitive = HOUSE_ASK <= avgBestAsk; // Our ask needs to be <= market best ask

        stratD_candles++;

        if (bidCompetitive && askCompetitive) {
            // Both sides fill: spread profit
            stratD_pnl += (HOUSE_ASK - HOUSE_BID) * TRADE_SIZE;
            console.log(`    Candle ${result.candleIndex}: Both competitive (bid ${avgBestBid.toFixed(2)} ask ${avgBestAsk.toFixed(2)}) → +$${((HOUSE_ASK - HOUSE_BID) * TRADE_SIZE).toFixed(0)}`);
        } else if (bidCompetitive) {
            // Only bid fills → directional long Up
            const won = result.outcome === 'UP';
            const pnl = won ? (1 - HOUSE_BID) * TRADE_SIZE : -HOUSE_BID * TRADE_SIZE;
            stratD_pnl += pnl;
            console.log(`    Candle ${result.candleIndex}: Only bid fills → ${result.outcome} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
        } else if (askCompetitive) {
            // Only ask fills → directional short Up (we sold Up)
            const won = result.outcome === 'DOWN';
            const pnl = won ? HOUSE_ASK * TRADE_SIZE : -(1 - HOUSE_ASK) * TRADE_SIZE;
            stratD_pnl += pnl;
            console.log(`    Candle ${result.candleIndex}: Only ask fills → ${result.outcome} → ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`);
        } else {
            console.log(`    Candle ${result.candleIndex}: Not competitive (mkt ${avgBestBid.toFixed(2)}/${avgBestAsk.toFixed(2)})`);
        }
    }
    console.log(`    Total P&L: $${stratD_pnl.toFixed(2)} across ${stratD_candles} candles`);

    // Key question analysis
    console.log('\n' + '='.repeat(80));
    console.log('KEY QUESTIONS');
    console.log('='.repeat(80));
    console.log(`\n1. Is the spread wide enough to profit from?`);
    console.log(`   Avg spread: ${(avgUpSpread * 100).toFixed(2)}c → ${avgUpSpread >= 0.03 ? 'YES' : 'MARGINAL'} (need ~3c+ for viable MM)`);

    console.log(`\n2. Does the overround create taker arb?`);
    console.log(`   Arb rate: ${((arbSnapshots.length / allSnaps.length) * 100).toFixed(1)}% → ${arbSnapshots.length > 0 ? 'INVESTIGATE' : 'NO'}`);

    console.log(`\n3. Is cross-token maker arb viable?`);
    console.log(`   Underround avg: ${(avgUnderround * 100).toFixed(2)}c → ${avgUnderround > 0 ? 'YES, bids sum < $1' : 'NO, bids sum >= $1'}`);

    console.log(`\n4. Is early-candle quoting at 50/50 profitable?`);
    console.log(`   See Strategy D results above.`);
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '5');
    console.log(`=== Spread Capture Study: ${NUM_CANDLES} candles ===\n`);

    // Connect to Chainlink for reference prices
    const chainlink = new ChainlinkFeed();
    await chainlink.connect((price) => {
        // Silent — just tracking
    });
    console.log('Chainlink feed connected.\n');

    // Wait for first price
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const results: CandleSpreadData[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        // Wait for next candle boundary
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const waitMs = nextCandle - now + 3000; // +3s buffer

        // Only wait if we're not already in the first 15 seconds
        const intoCandle = (now - currentRound) / 1000;
        if (intoCandle > 15) {
            console.log(`Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
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
