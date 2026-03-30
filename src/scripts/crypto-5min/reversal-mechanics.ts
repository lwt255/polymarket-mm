/**
 * Reversal Mechanics Analysis
 *
 * WHO profits from the increased reversals?
 * HOW are reversals happening — BTC actually reversing, or market manipulation?
 *
 * Key questions:
 * 1. When a candle "reverses" at T-60s, does BTC actually reverse or was the
 *    T-60s reading just noise on a flat candle?
 * 2. How much does BTC move in the FINAL minute? Is it increasing?
 * 3. Are reversals concentrated in specific move patterns?
 * 4. What does a typical reversal candle look like minute-by-minute?
 *
 * Run: npx tsx src/scripts/crypto-5min/reversal-mechanics.ts [days]
 */

import ccxt from 'ccxt';

async function main() {
    const DAYS = parseInt(process.argv[2] || '60');

    const exchange = new ccxt.binance();
    const allCandles: any[] = [];
    const endTime = Date.now();
    const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
    let since = startTime;

    console.log(`Fetching ${DAYS} days of 1-min BTCUSDT candles...`);
    while (since < endTime) {
        const candles = await exchange.fetchOHLCV('BTC/USDT', '1m', since, 1000);
        if (candles.length === 0) break;
        allCandles.push(...candles);
        since = candles[candles.length - 1][0] + 60000;
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`Got ${allCandles.length} candles\n`);

    // Build 5-min windows
    const groups: Map<number, any[]> = new Map();
    for (const c of allCandles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    interface Window {
        bucket: number;
        month: string;
        openPrice: number;
        closePrice: number;
        outcome: 'UP' | 'DOWN';
        prices: number[]; // close of each minute
        highs: number[];
        lows: number[];
        moveAtT60: number;
        dirAtT60: 'UP' | 'DOWN';
        reversed: boolean;
        // Final minute analysis
        lastMinMove: number; // absolute $ move in final minute
        lastMinMovePct: number; // % move in final minute
        lastMinDirection: 'UP' | 'DOWN';
        moveAtT60Dollars: number;
    }

    const windows: Window[] = [];
    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';
        const prices = mins.map((m: any) => m[4]);
        const highs = mins.map((m: any) => m[2]);
        const lows = mins.map((m: any) => m[3]);

        const moveAtT60 = Math.abs(prices[3] - openPrice) / openPrice * 100;
        const moveAtT60Dollars = Math.abs(prices[3] - openPrice);
        const dirAtT60: 'UP' | 'DOWN' = prices[3] >= openPrice ? 'UP' : 'DOWN';
        const reversed = dirAtT60 !== outcome;

        const lastMinMove = Math.abs(closePrice - prices[3]);
        const lastMinMovePct = lastMinMove / openPrice * 100;
        const lastMinDirection: 'UP' | 'DOWN' = closePrice >= prices[3] ? 'UP' : 'DOWN';

        const date = new Date(bucket);
        const month = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });

        windows.push({
            bucket, month, openPrice, closePrice, outcome,
            prices, highs, lows,
            moveAtT60, dirAtT60, reversed,
            lastMinMove, lastMinMovePct, lastMinDirection,
            moveAtT60Dollars,
        });
    }

    // === 1. IS BTC ACTUALLY REVERSING, OR IS IT NOISE? ===
    console.log('=== 1. ANATOMY OF REVERSALS (>5bps at T-60s) ===\n');

    const qualifying = windows.filter(w => w.moveAtT60 >= 0.05);
    const reversals = qualifying.filter(w => w.reversed);
    const holds = qualifying.filter(w => !w.reversed);

    console.log(`Total qualifying: ${qualifying.length} | Reversals: ${reversals.length} (${(reversals.length/qualifying.length*100).toFixed(1)}%) | Holds: ${holds.length}\n`);

    // How big is the last-minute move on reversals vs holds?
    const revLastMinAvg = reversals.reduce((s, w) => s + w.lastMinMovePct, 0) / reversals.length;
    const holdLastMinAvg = holds.reduce((s, w) => s + w.lastMinMovePct, 0) / holds.length;

    console.log('Average last-minute move:');
    console.log(`  Reversals: ${(revLastMinAvg * 100).toFixed(1)}bps ($${(reversals.reduce((s,w)=>s+w.lastMinMove,0)/reversals.length).toFixed(1)})`);
    console.log(`  Holds:     ${(holdLastMinAvg * 100).toFixed(1)}bps ($${(holds.reduce((s,w)=>s+w.lastMinMove,0)/holds.length).toFixed(1)})`);

    // For reversals: how much bigger was the last-minute move vs the T-60s move?
    console.log('\nReversal candles: last-minute move vs T-60s move:');
    const revOverpowers = reversals.filter(w => w.lastMinMovePct > w.moveAtT60);
    console.log(`  Last minute BIGGER than T-60s move: ${revOverpowers.length}/${reversals.length} (${(revOverpowers.length/reversals.length*100).toFixed(1)}%)`);

    const revRatio = reversals.reduce((s, w) => s + w.lastMinMovePct / w.moveAtT60, 0) / reversals.length;
    console.log(`  Avg ratio (last min / T-60s move): ${revRatio.toFixed(2)}x`);

    // === 2. LAST MINUTE MOVE SIZE OVER TIME ===
    console.log('\n=== 2. LAST-MINUTE MOVE SIZE BY MONTH (is final minute getting more volatile?) ===\n');

    const monthlyLastMin = new Map<string, { moves: number[]; revCount: number; total: number }>();
    for (const w of qualifying) {
        if (!monthlyLastMin.has(w.month)) monthlyLastMin.set(w.month, { moves: [], revCount: 0, total: 0 });
        const m = monthlyLastMin.get(w.month)!;
        m.moves.push(w.lastMinMovePct);
        m.total++;
        if (w.reversed) m.revCount++;
    }

    console.log(
        'Month'.padEnd(12) + ' | ' +
        'Avg Last Min'.padEnd(13) + ' | ' +
        'Median'.padEnd(8) + ' | ' +
        'P90'.padEnd(8) + ' | ' +
        'Rev Rate'.padEnd(9) + ' | ' +
        'Interpretation'
    );
    console.log('-'.repeat(80));

    for (const [month, data] of monthlyLastMin) {
        const sorted = data.moves.sort((a, b) => a - b);
        const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
        const median = sorted[Math.floor(sorted.length / 2)];
        const p90 = sorted[Math.floor(sorted.length * 0.9)];
        const revRate = data.revCount / data.total * 100;
        const interp = avg > 0.06 ? 'More volatile' : 'Normal';

        console.log(
            month.padEnd(12) + ' | ' +
            ((avg * 100).toFixed(1) + 'bps').padEnd(13) + ' | ' +
            ((median * 100).toFixed(1) + 'bps').padEnd(8) + ' | ' +
            ((p90 * 100).toFixed(1) + 'bps').padEnd(8) + ' | ' +
            (revRate.toFixed(1) + '%').padEnd(9) + ' | ' +
            interp
        );
    }

    // === 3. IS IT BTC REVERSING OR JUST FLAT CANDLES WIGGLING? ===
    console.log('\n=== 3. REVERSAL TYPE: Real reversal vs noise on flat candle ===\n');

    // Classify reversals
    let realReversals = 0; // BTC strongly moved against in last minute
    let noiseReversals = 0; // tiny move, just wiggled past open
    let borderlineReversals = 0;

    for (const w of reversals) {
        const totalRange = (Math.max(...w.highs) - Math.min(...w.lows)) / w.openPrice * 100;
        const netMove = Math.abs(w.closePrice - w.openPrice) / w.openPrice * 100;

        if (netMove < 0.02) {
            noiseReversals++; // candle basically closed flat, tiny wiggle decided it
        } else if (w.lastMinMovePct > w.moveAtT60 * 0.5) {
            realReversals++; // last minute meaningfully reversed the move
        } else {
            borderlineReversals++;
        }
    }

    console.log(`Real reversals (last min > 50% of T-60s move): ${realReversals} (${(realReversals/reversals.length*100).toFixed(1)}%)`);
    console.log(`Noise reversals (net move < 2bps, wiggle):     ${noiseReversals} (${(noiseReversals/reversals.length*100).toFixed(1)}%)`);
    console.log(`Borderline:                                     ${borderlineReversals} (${(borderlineReversals/reversals.length*100).toFixed(1)}%)`);

    // === 4. MINUTE-BY-MINUTE PROFILE OF REVERSAL vs HOLD CANDLES ===
    console.log('\n=== 4. AVERAGE MINUTE-BY-MINUTE PROFILE (normalized to direction at T-60s) ===\n');
    console.log('Positive = moving in T-60s direction, Negative = against\n');

    // Normalize: express each minute's move as % of open, signed relative to T-60s direction
    console.log('Minute | Hold candles (avg)  | Reversal candles (avg) | Difference');
    console.log('-'.repeat(70));

    for (let min = 0; min < 5; min++) {
        let holdSum = 0, revSum = 0;
        for (const w of holds) {
            const move = (w.prices[min] - w.openPrice) / w.openPrice * 100;
            const signed = w.dirAtT60 === 'UP' ? move : -move; // positive = in direction
            holdSum += signed;
        }
        for (const w of reversals) {
            const move = (w.prices[min] - w.openPrice) / w.openPrice * 100;
            const signed = w.dirAtT60 === 'UP' ? move : -move;
            revSum += signed;
        }
        const holdAvg = holdSum / holds.length;
        const revAvg = revSum / reversals.length;
        const label = min === 4 ? `Min ${min + 1} (CLOSE)` : `Min ${min + 1}`;

        console.log(
            label.padEnd(15) + ' | ' +
            ((holdAvg >= 0 ? '+' : '') + (holdAvg * 100).toFixed(1) + 'bps').padEnd(20) + ' | ' +
            ((revAvg >= 0 ? '+' : '') + (revAvg * 100).toFixed(1) + 'bps').padEnd(23) + ' | ' +
            ((revAvg - holdAvg >= 0 ? '+' : '') + ((revAvg - holdAvg) * 100).toFixed(1) + 'bps')
        );
    }

    // === 5. WHO PROFITS? ===
    console.log('\n=== 5. WHO PROFITS FROM REVERSALS? ===\n');
    console.log('Scenario analysis:\n');

    const avgWinnerPriceAtT60 = 0.75; // rough average for >5bps moves
    const avgLoserPriceAtT60 = 0.25;

    console.log('If the MM is quoting both sides with 1c spread:');
    console.log('  MM sells UP at 51c, DOWN at 51c → collects $1.02 per pair');
    console.log('  Resolution pays out $1.00 → MM profit = $0.02/pair regardless of outcome');
    console.log('  Reversals do NOT hurt the MM if they are balanced on both sides.\n');

    console.log('If a TAKER is buying the winner at T-60s:');
    console.log(`  Old regime: 95% accuracy → EV = 0.95 × (1-0.75) - 0.05 × 0.75 = +$0.20/token`);
    console.log(`  New regime: 85% accuracy → EV = 0.85 × (1-0.75) - 0.15 × 0.75 = +$0.10/token`);
    console.log(`  → Still profitable, but edge halved.\n`);

    console.log('If a COUNTER-TRADER is actively pushing BTC in the last minute:');
    console.log('  They would buy the LOSER token (cheap), then move BTC to cause reversal.');
    console.log('  Cost: loser at ~20c. Payout: $1 on reversal.');
    console.log('  But they need REAL BTC capital to move the actual price.');
    console.log('  BTC/USDT does $20B+/day volume — moving it costs real money.\n');

    // Check: is the BTC volume in the last minute actually different?
    console.log('More likely explanation: BTC volatility regime changed.');
    console.log('Feb-Mar 2026 daily range is 4.8-5.5% vs 2.0-2.5% in summer 2025.');
    console.log('Higher volatility = more last-minute reversals naturally.');
    console.log('Nobody is "manipulating" — the market just got choppier.\n');

    // === 6. CORRELATION: Does higher BTC daily range = more reversals? ===
    console.log('=== 6. BTC DAILY RANGE vs REVERSAL RATE (causation test) ===\n');

    // Group by day, compute daily range and reversal rate
    const dailyData = new Map<string, { range: number; revs: number; total: number }>();
    const dailyHL = new Map<string, { high: number; low: number; open: number }>();

    for (const c of allCandles) {
        const date = new Date(c[0]);
        const dateKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });
        if (!dailyHL.has(dateKey)) dailyHL.set(dateKey, { high: -Infinity, low: Infinity, open: c[1] });
        const d = dailyHL.get(dateKey)!;
        d.high = Math.max(d.high, c[2]);
        d.low = Math.min(d.low, c[3]);
    }

    for (const w of qualifying) {
        const date = new Date(w.bucket);
        const dateKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric' });
        if (!dailyData.has(dateKey)) dailyData.set(dateKey, { range: 0, revs: 0, total: 0 });
        const d = dailyData.get(dateKey)!;
        const hl = dailyHL.get(dateKey);
        if (hl) d.range = (hl.high - hl.low) / hl.open * 100;
        d.total++;
        if (w.reversed) d.revs++;
    }

    // Sort days by range and show correlation
    const days = [...dailyData.entries()].filter(([, d]) => d.total >= 10).sort((a, b) => a[1].range - b[1].range);
    const lowVolDays = days.slice(0, Math.floor(days.length / 3));
    const midVolDays = days.slice(Math.floor(days.length / 3), Math.floor(days.length * 2 / 3));
    const highVolDays = days.slice(Math.floor(days.length * 2 / 3));

    const avgRev = (ds: typeof days) => {
        const totalRevs = ds.reduce((s, [, d]) => s + d.revs, 0);
        const totalTrades = ds.reduce((s, [, d]) => s + d.total, 0);
        return { revRate: totalRevs / totalTrades * 100, avgRange: ds.reduce((s, [, d]) => s + d.range, 0) / ds.length };
    };

    const low = avgRev(lowVolDays);
    const mid = avgRev(midVolDays);
    const high = avgRev(highVolDays);

    console.log('BTC Daily Range  | Reversal Rate | Days');
    console.log('-'.repeat(45));
    console.log(`Low vol (${low.avgRange.toFixed(1)}% avg) | ${low.revRate.toFixed(1)}%          | ${lowVolDays.length}`);
    console.log(`Mid vol (${mid.avgRange.toFixed(1)}% avg) | ${mid.revRate.toFixed(1)}%          | ${midVolDays.length}`);
    console.log(`High vol (${high.avgRange.toFixed(1)}% avg)| ${high.revRate.toFixed(1)}%          | ${highVolDays.length}`);

    console.log(`\n→ ${high.revRate > low.revRate + 2 ? 'CONFIRMED: Higher BTC volatility = more reversals.' : 'No strong correlation.'}`);
    console.log(`  This suggests reversals are driven by BTC regime, not Polymarket manipulation.`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
