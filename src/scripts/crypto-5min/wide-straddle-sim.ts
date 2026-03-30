/**
 * Wide Straddle Simulator
 *
 * Core hypothesis: Post WIDE maker quotes on the Up token (e.g., bid 35 / ask 65).
 * BTC volatility causes the market to oscillate 20-40+ cents during each candle.
 * If both sides fill, we pocket the spread regardless of outcome.
 *
 * This matches the friend's hints:
 *   1. "Not about predicting the price" → non-directional spread capture
 *   2. "Not about being the first one in" → wide quotes, not competing on tightness
 *
 * Tests multiple bid/ask widths against observed market oscillation data.
 * Uses live order book snapshots to determine the actual high/low of each candle.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

interface CandleOscillation {
    index: number;
    question: string;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    highMid: number;   // Highest midpoint during candle
    lowMid: number;    // Lowest midpoint during candle
    range: number;     // highMid - lowMid
    midpoints: number[]; // All midpoints in order
    timestamps: number[]; // Seconds into candle for each midpoint
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

async function monitorCandle(candleIndex: number): Promise<CandleOscillation | null> {
    const market = await findCurrentMarket();
    if (!market) {
        console.log(`  Candle ${candleIndex}: No market`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    console.log(`  Candle ${candleIndex}: ${market.question}`);

    const midpoints: number[] = [];
    const timestamps: number[] = [];

    const POLL_INTERVAL = 2000; // 2 seconds for granularity
    const maxPolls = 160;

    for (let p = 0; p < maxPolls; p++) {
        const secondsLeft = (endDate.getTime() - Date.now()) / 1000;
        if (secondsLeft < -5) break;

        try {
            const raw = await fetchJSON(`${CLOB}/book?token_id=${upToken}`);
            if (raw) {
                const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
                const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
                const bestBid = bids[0] ?? 0;
                const bestAsk = asks[0] ?? 1;
                const mid = (bestBid + bestAsk) / 2;

                // Only track during active trading (not post-resolution)
                if (mid > 0.02 && mid < 0.98) {
                    midpoints.push(mid);
                    timestamps.push(300 - secondsLeft);
                }
            }
        } catch {}

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Get resolution
    await new Promise(r => setTimeout(r, 8000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    const outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // If UNKNOWN, infer from last midpoint
    const inferredOutcome = outcome !== 'UNKNOWN' ? outcome :
        (midpoints.length > 0 && midpoints[midpoints.length - 1] < 0.3 ? 'DOWN' :
         midpoints.length > 0 && midpoints[midpoints.length - 1] > 0.7 ? 'UP' : 'UNKNOWN');

    if (midpoints.length === 0) {
        console.log(`    No valid midpoints captured`);
        return null;
    }

    const highMid = Math.max(...midpoints);
    const lowMid = Math.min(...midpoints);

    console.log(
        `    Range: ${(lowMid * 100).toFixed(0)}c - ${(highMid * 100).toFixed(0)}c ` +
        `(${((highMid - lowMid) * 100).toFixed(0)}c) | ` +
        `Outcome: ${inferredOutcome} | Vol: $${volume.toFixed(0)} | ` +
        `Snapshots: ${midpoints.length}`
    );

    return {
        index: candleIndex,
        question: market.question,
        outcome: inferredOutcome,
        volume,
        highMid,
        lowMid,
        range: highMid - lowMid,
        midpoints,
        timestamps,
    };
}

interface StraddleConfig {
    bidPrice: number;
    askPrice: number;
    label: string;
}

function simulateStraddle(candles: CandleOscillation[], config: StraddleConfig, tradeSize: number) {
    let totalPnL = 0;
    let bothFilled = 0;
    let bidOnlyFilled = 0;
    let askOnlyFilled = 0;
    let neitherFilled = 0;

    for (const candle of candles) {
        // Check if bid would fill (market drops to our bid level)
        // Our bid fills when someone SELLS to us → market mid <= our bid
        const bidFills = candle.lowMid <= config.bidPrice;
        // Our ask fills when someone BUYS from us → market mid >= our ask
        const askFills = candle.highMid >= config.askPrice;

        if (bidFills && askFills) {
            // Both fill → locked in spread profit regardless of outcome
            // But TIMING matters: which fills first?
            // Find when each fills
            let bidFillTime = -1, askFillTime = -1;
            for (let i = 0; i < candle.midpoints.length; i++) {
                if (bidFillTime < 0 && candle.midpoints[i] <= config.bidPrice) {
                    bidFillTime = candle.timestamps[i];
                }
                if (askFillTime < 0 && candle.midpoints[i] >= config.askPrice) {
                    askFillTime = candle.timestamps[i];
                }
            }

            // Both filled → profit = spread
            const profit = (config.askPrice - config.bidPrice) * tradeSize;
            totalPnL += profit;
            bothFilled++;
        } else if (bidFills) {
            // Only bid filled → we bought Up at bidPrice
            // P&L depends on resolution
            bidOnlyFilled++;
            if (candle.outcome === 'UP') {
                totalPnL += (1 - config.bidPrice) * tradeSize;
            } else if (candle.outcome === 'DOWN') {
                totalPnL += -config.bidPrice * tradeSize;
            }
            // UNKNOWN: treat as 50/50
        } else if (askFills) {
            // Only ask filled → we sold Up at askPrice
            askOnlyFilled++;
            if (candle.outcome === 'DOWN') {
                totalPnL += config.askPrice * tradeSize;
            } else if (candle.outcome === 'UP') {
                totalPnL += -(1 - config.askPrice) * tradeSize;
            }
        } else {
            neitherFilled++;
        }
    }

    return { totalPnL, bothFilled, bidOnlyFilled, askOnlyFilled, neitherFilled };
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '8');
    console.log(`=== Wide Straddle Simulator: ${NUM_CANDLES} candles ===\n`);

    const candles: CandleOscillation[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        // Wait for next candle
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(i + 1);
        if (result) candles.push(result);
    }

    if (candles.length === 0) {
        console.log('No candle data collected.');
        return;
    }

    // Oscillation statistics
    console.log('\n' + '='.repeat(70));
    console.log('OSCILLATION STATISTICS');
    console.log('='.repeat(70));

    const ranges = candles.map(c => c.range);
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const minRange = Math.min(...ranges);
    const maxRange = Math.max(...ranges);
    console.log(`\nCandles: ${candles.length}`);
    console.log(`Avg range: ${(avgRange * 100).toFixed(1)}c | Min: ${(minRange * 100).toFixed(1)}c | Max: ${(maxRange * 100).toFixed(1)}c`);

    const ups = candles.filter(c => c.outcome === 'UP').length;
    const downs = candles.filter(c => c.outcome === 'DOWN').length;
    console.log(`Outcomes: ${ups} UP / ${downs} DOWN / ${candles.length - ups - downs} UNKNOWN`);

    // Test multiple straddle widths
    console.log('\n' + '='.repeat(70));
    console.log('STRADDLE SIMULATIONS ($100 per leg)');
    console.log('='.repeat(70));

    const configs: StraddleConfig[] = [
        { bidPrice: 0.48, askPrice: 0.52, label: '48/52 (4c)' },
        { bidPrice: 0.45, askPrice: 0.55, label: '45/55 (10c)' },
        { bidPrice: 0.42, askPrice: 0.58, label: '42/58 (16c)' },
        { bidPrice: 0.40, askPrice: 0.60, label: '40/60 (20c)' },
        { bidPrice: 0.38, askPrice: 0.62, label: '38/62 (24c)' },
        { bidPrice: 0.35, askPrice: 0.65, label: '35/65 (30c)' },
        { bidPrice: 0.30, askPrice: 0.70, label: '30/70 (40c)' },
        { bidPrice: 0.25, askPrice: 0.75, label: '25/75 (50c)' },
        { bidPrice: 0.20, askPrice: 0.80, label: '20/80 (60c)' },
    ];

    const TRADE_SIZE = 100;

    console.log(`\n${'Config'.padEnd(18)} | Both | Bid  | Ask  | None | P&L       | Per Candle`);
    console.log('-'.repeat(85));

    for (const config of configs) {
        const result = simulateStraddle(candles, config, TRADE_SIZE);
        const spread = config.askPrice - config.bidPrice;

        console.log(
            `${config.label.padEnd(18)} | ` +
            `${result.bothFilled.toString().padStart(4)} | ` +
            `${result.bidOnlyFilled.toString().padStart(4)} | ` +
            `${result.askOnlyFilled.toString().padStart(4)} | ` +
            `${result.neitherFilled.toString().padStart(4)} | ` +
            `$${result.totalPnL.toFixed(2).padStart(8)} | ` +
            `$${(result.totalPnL / candles.length).toFixed(2).padStart(8)}`
        );
    }

    // Also test asymmetric straddles (biased toward 50/50 zone)
    console.log('\n--- Asymmetric Straddles (wider on one side) ---');
    const asymConfigs: StraddleConfig[] = [
        { bidPrice: 0.40, askPrice: 0.55, label: '40/55 (15c asym)' },
        { bidPrice: 0.45, askPrice: 0.60, label: '45/60 (15c asym)' },
        { bidPrice: 0.35, askPrice: 0.55, label: '35/55 (20c asym)' },
        { bidPrice: 0.45, askPrice: 0.65, label: '45/65 (20c asym)' },
    ];

    console.log(`\n${'Config'.padEnd(18)} | Both | Bid  | Ask  | None | P&L       | Per Candle`);
    console.log('-'.repeat(85));

    for (const config of asymConfigs) {
        const result = simulateStraddle(candles, config, TRADE_SIZE);
        console.log(
            `${config.label.padEnd(18)} | ` +
            `${result.bothFilled.toString().padStart(4)} | ` +
            `${result.bidOnlyFilled.toString().padStart(4)} | ` +
            `${result.askOnlyFilled.toString().padStart(4)} | ` +
            `${result.neitherFilled.toString().padStart(4)} | ` +
            `$${result.totalPnL.toFixed(2).padStart(8)} | ` +
            `$${(result.totalPnL / candles.length).toFixed(2).padStart(8)}`
        );
    }

    // Detailed candle-by-candle for best config
    console.log('\n--- Candle Detail (40/60 straddle) ---');
    const bestConfig = { bidPrice: 0.40, askPrice: 0.60, label: '40/60' };
    for (const candle of candles) {
        const bidFills = candle.lowMid <= bestConfig.bidPrice;
        const askFills = candle.highMid >= bestConfig.askPrice;

        let pnl = 0;
        let status = '';
        if (bidFills && askFills) {
            pnl = (bestConfig.askPrice - bestConfig.bidPrice) * TRADE_SIZE;
            status = 'BOTH FILL → SPREAD PROFIT';
        } else if (bidFills) {
            pnl = candle.outcome === 'UP' ? (1 - bestConfig.bidPrice) * TRADE_SIZE : -bestConfig.bidPrice * TRADE_SIZE;
            status = `BID ONLY → ${candle.outcome}`;
        } else if (askFills) {
            pnl = candle.outcome === 'DOWN' ? bestConfig.askPrice * TRADE_SIZE : -(1 - bestConfig.askPrice) * TRADE_SIZE;
            status = `ASK ONLY → ${candle.outcome}`;
        } else {
            status = 'NO FILL';
        }

        console.log(
            `  Candle ${candle.index}: ` +
            `Range ${(candle.lowMid * 100).toFixed(0)}-${(candle.highMid * 100).toFixed(0)}c | ` +
            `${status.padEnd(28)} | ` +
            `P&L: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(0)}`
        );
    }

    // Annualized return calculation for best performing config
    console.log('\n--- Annualized Returns (Best Config) ---');
    for (const config of configs) {
        const result = simulateStraddle(candles, config, TRADE_SIZE);
        if (result.totalPnL <= 0) continue;

        const perCandle = result.totalPnL / candles.length;
        const candlesPerDay = 288; // 24h * 12 per hour
        const dailyPnL = perCandle * candlesPerDay;
        const capital = TRADE_SIZE * 2; // $100 per leg
        const dailyReturn = dailyPnL / capital;
        const annualReturn = dailyReturn * 365;

        console.log(
            `  ${config.label}: ` +
            `$${perCandle.toFixed(2)}/candle → ` +
            `$${dailyPnL.toFixed(0)}/day → ` +
            `${(dailyReturn * 100).toFixed(1)}%/day → ` +
            `${(annualReturn * 100).toFixed(0)}%/year`
        );
    }

    console.log('\n--- Key Insight ---');
    console.log('The market oscillates significantly within each 5-min candle.');
    console.log('Wide maker quotes capture this oscillation as profit.');
    console.log('0% maker fee means all spread goes to us.');
    console.log('The risk is single-side fills → directional exposure.');
    console.log(`Both-fill rate at 40/60: ${candles.filter(c => c.lowMid <= 0.40 && c.highMid >= 0.60).length}/${candles.length} candles`);
}

main().catch(console.error);
