/**
 * Rewards-Based Strategy Simulator
 *
 * THE INSIGHT: There are TWO revenue streams for makers:
 * 1. Maker Rebates: 20% of taker fees redistributed to makers proportionally
 * 2. Liquidity Rewards: Paid for RESTING orders within maxSpread of mid
 *
 * For 5-min crypto markets:
 * - rewardsMinSize: 50 shares
 * - rewardsMaxSpread: 4.5c
 * - Fee formula: fee = C * p * 0.25 * (p*(1-p))^2
 * - Maker fee: 0% (100% rebated)
 * - Taker fee: peaks at 1.56% at 50c
 *
 * Strategy: Post limit orders within 4.5c of mid on both sides.
 * Earn rewards for resting orders + rebates when filled.
 * Accept directional risk on single-side fills.
 *
 * This simulates the FULL economics including:
 * - Spread capture when both sides fill
 * - Adverse selection loss on single-side fills
 * - Estimated liquidity rewards income
 * - Estimated maker rebate income
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
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

interface BookLevel {
    bestBid: number;
    bestAsk: number;
    mid: number;
    spread: number;
    bidDepth: number;
    askDepth: number;
}

async function getBook(tokenId: string): Promise<BookLevel> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, mid: 0.5, spread: 1, bidDepth: 0, askDepth: 0 };
    const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
    const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
    const bestBid = bids[0] ?? 0;
    const bestAsk = asks[0] ?? 1;
    const bidDepth = (raw.bids || []).reduce((s: number, b: any) => s + parseFloat(b.size), 0);
    const askDepth = (raw.asks || []).reduce((s: number, a: any) => s + parseFloat(a.size), 0);
    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid, bidDepth, askDepth };
}

// Taker fee formula for crypto markets
function takerFee(shares: number, price: number): number {
    return shares * price * 0.25 * Math.pow(price * (1 - price), 2);
}

interface CandleSnapshot {
    timestamp: number;
    secondsLeft: number;
    upMid: number;
    upBestBid: number;
    upBestAsk: number;
    upSpread: number;
    upBidDepth: number;
    upAskDepth: number;
    chainlinkPrice: number;
    chainlinkMove: number;
}

interface CandleResult {
    index: number;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    snapshots: CandleSnapshot[];
    highMid: number;
    lowMid: number;
    range: number;
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<CandleResult | null> {
    const market = await findCurrentMarket();
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    console.log(`\n  Candle ${candleIndex}: ${market.question}`);

    let openChainlink: number | null = null;
    const snapshots: CandleSnapshot[] = [];

    const POLL_INTERVAL = 2000;
    const maxPolls = 160;

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;
        if (secondsLeft < -5) break;

        const clPrice = chainlink.getPrice();
        if (!openChainlink && clPrice > 0) openChainlink = clPrice;

        try {
            const upBook = await getBook(upToken);

            if (upBook.mid > 0.02 && upBook.mid < 0.98) {
                snapshots.push({
                    timestamp: now,
                    secondsLeft,
                    upMid: upBook.mid,
                    upBestBid: upBook.bestBid,
                    upBestAsk: upBook.bestAsk,
                    upSpread: upBook.spread,
                    upBidDepth: upBook.bidDepth,
                    upAskDepth: upBook.askDepth,
                    chainlinkPrice: clPrice,
                    chainlinkMove: openChainlink ? clPrice - openChainlink : 0,
                });
            }

            if (p % 15 === 0) {
                console.log(
                    `    ${Math.round(secondsLeft).toString().padStart(4)}s | ` +
                    `Mid: ${(upBook.mid * 100).toFixed(1)}c | ` +
                    `Spread: ${(upBook.spread * 100).toFixed(1)}c | ` +
                    `CL: ${openChainlink ? ((clPrice - openChainlink) >= 0 ? '+' : '') + '$' + (clPrice - openChainlink).toFixed(1) : 'N/A'}`
                );
            }
        } catch {}

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 6000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';

    if (outcome === 'UNKNOWN' && openChainlink && chainlink.getPrice() > 0) {
        outcome = chainlink.getPrice() >= openChainlink ? 'UP' : 'DOWN';
    }

    const volume = parseFloat(resolved?.[0]?.volume || '0');
    const mids = snapshots.map(s => s.upMid);
    const highMid = mids.length > 0 ? Math.max(...mids) : 0.5;
    const lowMid = mids.length > 0 ? Math.min(...mids) : 0.5;

    console.log(
        `    >>> ${outcome} | Vol: $${volume.toFixed(0)} | ` +
        `Range: ${(lowMid * 100).toFixed(0)}-${(highMid * 100).toFixed(0)}c (${((highMid - lowMid) * 100).toFixed(0)}c)`
    );

    return {
        index: candleIndex,
        outcome,
        volume,
        snapshots,
        highMid,
        lowMid,
        range: highMid - lowMid,
    };
}

interface StrategyConfig {
    label: string;
    bidOffset: number;  // How far below mid to place bid (in cents, 0.01 = 1c)
    askOffset: number;  // How far above mid to place ask
    size: number;       // Shares per side
    pullTime: number;   // Pull orders X seconds before end (0 = never pull)
}

function simulateStrategy(candles: CandleResult[], config: StrategyConfig) {
    let totalPnL = 0;
    let bothFilled = 0;
    let bidOnly = 0;
    let askOnly = 0;
    let noFill = 0;
    let totalTimeOnBook = 0; // seconds with qualifying orders
    let totalFilledVolume = 0;

    for (const candle of candles) {
        if (candle.snapshots.length < 5) continue;

        // Place orders at the START of the candle
        const firstSnap = candle.snapshots[0];
        const bidPrice = Math.round((firstSnap.upMid - config.bidOffset) * 100) / 100;
        const askPrice = Math.round((firstSnap.upMid + config.askOffset) * 100) / 100;

        if (bidPrice <= 0.01 || askPrice >= 0.99) continue;

        // Check if orders are within rewardsMaxSpread (4.5c)
        const withinRewards = config.bidOffset <= 0.045 && config.askOffset <= 0.045;

        // Track time on book (for liquidity rewards)
        const activeSnaps = config.pullTime > 0
            ? candle.snapshots.filter(s => s.secondsLeft > config.pullTime)
            : candle.snapshots;
        totalTimeOnBook += activeSnaps.length * 2; // 2 seconds per poll

        // Check fills through oscillation
        let bidFilled = false;
        let askFilled = false;
        let bidFillTime = -1;
        let askFillTime = -1;

        for (const snap of activeSnaps) {
            // Bid fills when market drops to our level
            if (!bidFilled && snap.upMid <= bidPrice + 0.005) {
                bidFilled = true;
                bidFillTime = snap.secondsLeft;
            }
            // Ask fills when market rises to our level
            if (!askFilled && snap.upMid >= askPrice - 0.005) {
                askFilled = true;
                askFillTime = snap.secondsLeft;
            }
        }

        if (bidFilled && askFilled) {
            // Both filled → spread profit regardless of outcome
            const profit = (askPrice - bidPrice) * config.size;
            totalPnL += profit;
            bothFilled++;
            totalFilledVolume += config.size * 2;
        } else if (bidFilled) {
            // Bought Up at bidPrice → depends on resolution
            bidOnly++;
            totalFilledVolume += config.size;
            if (candle.outcome === 'UP') {
                totalPnL += (1 - bidPrice) * config.size;
            } else if (candle.outcome === 'DOWN') {
                totalPnL -= bidPrice * config.size;
            }
        } else if (askFilled) {
            // Sold Up at askPrice → depends on resolution
            askOnly++;
            totalFilledVolume += config.size;
            if (candle.outcome === 'DOWN') {
                totalPnL += askPrice * config.size;
            } else if (candle.outcome === 'UP') {
                totalPnL -= (1 - askPrice) * config.size;
            }
        } else {
            noFill++;
        }
    }

    return {
        totalPnL,
        bothFilled,
        bidOnly,
        askOnly,
        noFill,
        totalTimeOnBook,
        totalFilledVolume,
    };
}

function analyzeResults(candles: CandleResult[]) {
    console.log('\n' + '='.repeat(80));
    console.log('REWARDS-BASED STRATEGY ANALYSIS');
    console.log('='.repeat(80));

    const validCandles = candles.filter(c => c.snapshots.length >= 5);
    console.log(`\nCandles: ${validCandles.length}`);

    const avgRange = candles.reduce((s, c) => s + c.range, 0) / candles.length;
    const avgVol = candles.reduce((s, c) => s + c.volume, 0) / candles.length;
    const totalVol = candles.reduce((s, c) => s + c.volume, 0);
    console.log(`Avg range: ${(avgRange * 100).toFixed(1)}c | Avg vol: $${avgVol.toFixed(0)} | Total vol: $${totalVol.toFixed(0)}`);

    // Test multiple configurations
    const configs: StrategyConfig[] = [
        // Within 4.5c reward zone, various widths
        { label: '1c each (48/52)', bidOffset: 0.02, askOffset: 0.02, size: 100, pullTime: 0 },
        { label: '2c each (47/53)', bidOffset: 0.03, askOffset: 0.03, size: 100, pullTime: 0 },
        { label: '3c each (46/54)', bidOffset: 0.04, askOffset: 0.04, size: 100, pullTime: 0 },
        { label: '4c each (45.5/54.5)', bidOffset: 0.045, askOffset: 0.045, size: 100, pullTime: 0 },
        // Pull before end to avoid resolution risk
        { label: '2c, pull@60s', bidOffset: 0.03, askOffset: 0.03, size: 100, pullTime: 60 },
        { label: '2c, pull@30s', bidOffset: 0.03, askOffset: 0.03, size: 100, pullTime: 30 },
        { label: '3c, pull@60s', bidOffset: 0.04, askOffset: 0.04, size: 100, pullTime: 60 },
        // Larger size (higher rewards)
        { label: '2c, 200 shares', bidOffset: 0.03, askOffset: 0.03, size: 200, pullTime: 0 },
        { label: '3c, 500 shares', bidOffset: 0.04, askOffset: 0.04, size: 500, pullTime: 0 },
    ];

    console.log('\n--- Strategy Simulations ---');
    console.log(`${'Config'.padEnd(22)} | Both | Bid  | Ask  | None | Fill P&L    | Rebate Est  | Total Est`);
    console.log('-'.repeat(100));

    for (const config of configs) {
        const result = simulateStrategy(validCandles, config);

        // Estimate maker rebate: 20% of taker fees on our filled volume
        // Fee at mid price (~50c): ~1.56% * 20% = ~0.31% of filled volume
        const avgPrice = 0.50;
        const feePerShare = avgPrice * 0.25 * Math.pow(avgPrice * (1 - avgPrice), 2);
        const totalFees = result.totalFilledVolume * feePerShare;
        const ourRebate = totalFees * 0.20; // Simplified: assumes we're the only maker

        // Estimate liquidity rewards (very rough - we don't know the exact pool)
        // Assume ~$50-200/day across all 5-min markets, proportional to our share
        // With $100K+ total depth and our tiny size, our share is negligible
        // But the RELATIVE share matters in each individual market
        const rewardEstimate = 0; // Can't estimate without knowing pool size

        const totalEst = result.totalPnL + ourRebate;

        console.log(
            `${config.label.padEnd(22)} | ` +
            `${result.bothFilled.toString().padStart(4)} | ` +
            `${result.bidOnly.toString().padStart(4)} | ` +
            `${result.askOnly.toString().padStart(4)} | ` +
            `${result.noFill.toString().padStart(4)} | ` +
            `$${result.totalPnL.toFixed(2).padStart(9)} | ` +
            `$${ourRebate.toFixed(2).padStart(9)} | ` +
            `$${totalEst.toFixed(2).padStart(9)}`
        );
    }

    // Detailed analysis: What matters is whether rewards + rebates > adverse selection loss
    console.log('\n--- Economic Breakdown ---');

    const bestConfig: StrategyConfig = { label: '3c, pull@60s', bidOffset: 0.04, askOffset: 0.04, size: 100, pullTime: 60 };
    const result = simulateStrategy(validCandles, bestConfig);

    console.log(`\nConfig: ${bestConfig.label}`);
    console.log(`  Both-fill P&L: +$${(result.bothFilled * (bestConfig.bidOffset + bestConfig.askOffset) * bestConfig.size).toFixed(2)}`);

    // Adverse selection on single fills
    let bidOnlyPnL = 0;
    let askOnlyPnL = 0;
    // Recalculate from candles
    for (const candle of validCandles) {
        if (candle.snapshots.length < 5) continue;
        const firstSnap = candle.snapshots[0];
        const bidPrice = Math.round((firstSnap.upMid - bestConfig.bidOffset) * 100) / 100;
        const askPrice = Math.round((firstSnap.upMid + bestConfig.askOffset) * 100) / 100;

        const activeSnaps = bestConfig.pullTime > 0
            ? candle.snapshots.filter(s => s.secondsLeft > bestConfig.pullTime)
            : candle.snapshots;

        let bidFilled = false, askFilled = false;
        for (const snap of activeSnaps) {
            if (!bidFilled && snap.upMid <= bidPrice + 0.005) bidFilled = true;
            if (!askFilled && snap.upMid >= askPrice - 0.005) askFilled = true;
        }

        if (bidFilled && !askFilled) {
            if (candle.outcome === 'UP') bidOnlyPnL += (1 - bidPrice) * bestConfig.size;
            else bidOnlyPnL -= bidPrice * bestConfig.size;
        }
        if (askFilled && !bidFilled) {
            if (candle.outcome === 'DOWN') askOnlyPnL += askPrice * bestConfig.size;
            else askOnlyPnL -= (1 - askPrice) * bestConfig.size;
        }
    }

    console.log(`  Bid-only P&L: $${bidOnlyPnL.toFixed(2)} (${result.bidOnly} candles)`);
    console.log(`  Ask-only P&L: $${askOnlyPnL.toFixed(2)} (${result.askOnly} candles)`);
    console.log(`  No-fill candles: ${result.noFill}`);
    console.log(`  Total fill P&L: $${result.totalPnL.toFixed(2)}`);
    console.log(`  Per candle: $${(result.totalPnL / validCandles.length).toFixed(2)}`);

    // Break-even analysis
    console.log('\n--- Break-Even Analysis ---');
    const perCandleLoss = result.totalPnL / validCandles.length;
    if (perCandleLoss < 0) {
        const candlesPerDay = 288;
        const dailyLoss = Math.abs(perCandleLoss) * candlesPerDay;
        console.log(`  Daily adverse selection loss: -$${dailyLoss.toFixed(0)}`);
        console.log(`  Need rewards + rebates > $${dailyLoss.toFixed(0)}/day to break even`);
        console.log(`  That's $${(dailyLoss / candlesPerDay).toFixed(2)}/candle from rewards+rebates`);
    } else {
        console.log(`  Strategy is profitable even WITHOUT rewards!`);
        const candlesPerDay = 288;
        const dailyProfit = perCandleLoss * candlesPerDay;
        console.log(`  Daily spread profit: $${dailyProfit.toFixed(0)}`);
        console.log(`  Rewards and rebates are pure upside.`);
    }

    // What if we JUST earn rewards (cancel before any fills)?
    console.log('\n--- Pure Rewards Strategy (cancel on any price movement) ---');
    console.log(`  Post 50 shares at mid ± 4c on both sides`);
    console.log(`  Cancel immediately if price moves toward either order`);
    console.log(`  Earn liquidity rewards for time on book, zero fill risk`);
    console.log(`  Capital at risk: $0 (orders never fill)`);
    console.log(`  Revenue: Unknown (depends on reward pool size and competition)`);
    console.log(`  This is likely what "not about predicting price" means!`);

    // Extrapolation
    console.log('\n--- Extrapolated Daily Returns ---');
    const capital = bestConfig.size * 2; // Capital tied up in orders
    for (const rewardPerCandle of [0.10, 0.50, 1.00, 2.00, 5.00]) {
        const dailyReward = rewardPerCandle * 288;
        const dailyTotal = (perCandleLoss * 288) + dailyReward;
        const roi = dailyTotal / capital * 100;
        console.log(
            `  Reward: $${rewardPerCandle.toFixed(2)}/candle → ` +
            `$${dailyReward.toFixed(0)}/day rewards + $${(perCandleLoss * 288).toFixed(0)} fills = ` +
            `$${dailyTotal.toFixed(0)}/day (${roi.toFixed(1)}% daily ROI on $${capital})`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '6');
    console.log(`=== Rewards Strategy Simulator: ${NUM_CANDLES} candles ===\n`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const candles: CandleResult[] = [];

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
        if (result) candles.push(result);
    }

    chainlink.disconnect();

    if (candles.length > 0) {
        analyzeResults(candles);
    }
}

main().catch(console.error);
