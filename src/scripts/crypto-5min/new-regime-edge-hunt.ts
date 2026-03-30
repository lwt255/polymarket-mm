/**
 * New Regime Edge Hunt
 * The old momentum-at-T60 edge is dying (20% reversal rate).
 * What NEW edges might exist in the changed market?
 *
 * Tests on last 60 days (new regime only):
 * 1. Auto-correlation: does previous candle predict next?
 * 2. Move trajectory: steady grind vs spike — which reverses more?
 * 3. Consecutive candle streaks: does momentum across candles predict?
 * 4. Reversal prediction: can we identify WHICH candles will reverse?
 * 5. Fade strategy: buy the LOSER on weak moves?
 *
 * Run: npx tsx src/scripts/crypto-5min/new-regime-edge-hunt.ts [days]
 */

import ccxt from 'ccxt';

async function main() {
    const DAYS = parseInt(process.argv[2] || '60');

    const exchange = new ccxt.binance();
    const allCandles: any[] = [];
    const endTime = Date.now();
    const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
    let since = startTime;

    console.log(`Fetching ${DAYS} days of 1-min BTCUSDT candles (new regime period)...`);
    while (since < endTime) {
        const candles = await exchange.fetchOHLCV('BTC/USDT', '1m', since, 1000);
        if (candles.length === 0) break;
        allCandles.push(...candles);
        since = candles[candles.length - 1][0] + 60000;
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`Got ${allCandles.length} candles\n`);

    // Build 5-min windows with full minute-by-minute data
    const groups: Map<number, any[]> = new Map();
    for (const c of allCandles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    interface Window {
        bucket: number;
        openPrice: number;
        closePrice: number;
        outcome: 'UP' | 'DOWN';
        // Prices at each minute
        prices: number[]; // close of min 0,1,2,3,4
        // Move metrics
        moveAtT60: number; // % move at T-60s (min 3 close)
        dirAtT60: 'UP' | 'DOWN';
        reversed: boolean; // did T-60s direction differ from outcome?
        // Trajectory metrics
        maxMoveInDirection: number; // max % move in the T-60s direction during mins 0-3
        moveAtT120: number; // % move at T-120s
        moveAtT180: number;
        moveMonotonic: boolean; // did price move consistently in one direction?
        spikeAtEnd: boolean; // did most of the move happen in min 3?
        // High/low of the 5 minutes
        high: number;
        low: number;
        range: number; // high-low as % of open
    }

    const windows: Window[] = [];
    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';

        const prices = mins.map((m: any) => m[4]); // close of each minute
        const high = Math.max(...mins.map((m: any) => m[2]));
        const low = Math.min(...mins.map((m: any) => m[3]));

        const moveAtT60 = Math.abs(prices[3] - openPrice) / openPrice * 100;
        const moveAtT120 = Math.abs(prices[2] - openPrice) / openPrice * 100;
        const moveAtT180 = Math.abs(prices[1] - openPrice) / openPrice * 100;
        const dirAtT60: 'UP' | 'DOWN' = prices[3] >= openPrice ? 'UP' : 'DOWN';
        const reversed = dirAtT60 !== outcome;

        // Trajectory: was the move monotonic (each minute further in same direction)?
        const diffs = [
            prices[0] - openPrice,
            prices[1] - prices[0],
            prices[2] - prices[1],
            prices[3] - prices[2],
        ];
        const allSameSign = diffs.every(d => d >= 0) || diffs.every(d => d <= 0);
        const moveMonotonic = allSameSign;

        // Spike: did min 3 account for >50% of the total move?
        const totalMoveToT60 = prices[3] - openPrice;
        const min3Move = prices[3] - prices[2];
        const spikeAtEnd = Math.abs(totalMoveToT60) > 0 && Math.abs(min3Move) / Math.abs(totalMoveToT60) > 0.5;

        // Max move in direction during mins 0-3
        const movesInDir = [0, 1, 2, 3].map(i => Math.abs(prices[i] - openPrice) / openPrice * 100);
        const maxMoveInDirection = Math.max(...movesInDir);

        windows.push({
            bucket, openPrice, closePrice, outcome,
            prices, moveAtT60, moveAtT120, moveAtT180, dirAtT60, reversed,
            maxMoveInDirection, moveMonotonic, spikeAtEnd,
            high, low,
            range: (high - low) / openPrice * 100,
        });
    }

    console.log(`5-min windows: ${windows.length}\n`);

    // === 1. AUTO-CORRELATION: Does previous candle predict next? ===
    console.log('=== 1. AUTO-CORRELATION (does previous candle outcome predict next?) ===\n');

    const autoCorr: { prevOutcome: string; nextOutcome: string; count: number }[] = [];
    let sameCount = 0, diffCount = 0;
    for (let i = 1; i < windows.length; i++) {
        if (windows[i].bucket - windows[i - 1].bucket !== 300000) continue; // skip gaps
        if (windows[i].outcome === windows[i - 1].outcome) sameCount++;
        else diffCount++;
    }
    const total = sameCount + diffCount;
    console.log(`Same direction as previous: ${sameCount}/${total} (${(sameCount / total * 100).toFixed(1)}%)`);
    console.log(`Opposite direction: ${diffCount}/${total} (${(diffCount / total * 100).toFixed(1)}%)`);
    console.log(`→ ${sameCount > diffCount ? 'Slight momentum' : 'Slight mean-reversion'} (${Math.abs(sameCount - diffCount)} candle difference)\n`);

    // Does previous candle REVERSAL predict next candle?
    let prevRevNextRev = 0, prevRevNextHold = 0;
    let prevHoldNextRev = 0, prevHoldNextHold = 0;
    for (let i = 1; i < windows.length; i++) {
        if (windows[i].bucket - windows[i - 1].bucket !== 300000) continue;
        if (windows[i].moveAtT60 < 0.05 || windows[i - 1].moveAtT60 < 0.05) continue;
        const prevRev = windows[i - 1].reversed;
        const currRev = windows[i].reversed;
        if (prevRev && currRev) prevRevNextRev++;
        if (prevRev && !currRev) prevRevNextHold++;
        if (!prevRev && currRev) prevHoldNextRev++;
        if (!prevRev && !currRev) prevHoldNextHold++;
    }
    console.log('Previous candle reversed → next candle:');
    console.log(`  Reverses again: ${prevRevNextRev}  |  Holds: ${prevRevNextHold}  |  P(next rev | prev rev): ${(prevRevNextRev / (prevRevNextRev + prevRevNextHold) * 100).toFixed(1)}%`);
    console.log('Previous candle held → next candle:');
    console.log(`  Reverses: ${prevHoldNextRev}  |  Holds: ${prevHoldNextHold}  |  P(next rev | prev held): ${(prevHoldNextRev / (prevHoldNextRev + prevHoldNextHold) * 100).toFixed(1)}%`);

    // === 2. CONSECUTIVE STREAK ANALYSIS ===
    console.log('\n=== 2. CONSECUTIVE STREAKS (after N same-direction candles, what happens?) ===\n');

    for (const streakLen of [2, 3, 4, 5]) {
        let continues = 0, reverses = 0;
        for (let i = streakLen; i < windows.length; i++) {
            // Check if previous N candles were all same direction
            let allSame = true;
            const dir = windows[i - 1].outcome;
            for (let j = i - streakLen; j < i; j++) {
                if (windows[j].outcome !== dir) { allSame = false; break; }
                if (j > i - streakLen && windows[j].bucket - windows[j - 1].bucket !== 300000) { allSame = false; break; }
            }
            if (!allSame) continue;

            if (windows[i].outcome === dir) continues++;
            else reverses++;
        }
        const streakTotal = continues + reverses;
        if (streakTotal < 10) continue;
        console.log(`After ${streakLen} same-direction candles: continues ${continues}/${streakTotal} (${(continues / streakTotal * 100).toFixed(1)}%) | reverses ${reverses}/${streakTotal} (${(reverses / streakTotal * 100).toFixed(1)}%)`);
    }

    // === 3. MOVE TRAJECTORY: STEADY vs SPIKE ===
    console.log('\n=== 3. MOVE TRAJECTORY (steady grind vs late spike, >5bps at T-60s) ===\n');

    const steadyTrades = windows.filter(w => w.moveAtT60 >= 0.05 && !w.spikeAtEnd && w.moveMonotonic);
    const spikeTrades = windows.filter(w => w.moveAtT60 >= 0.05 && w.spikeAtEnd);
    const choppyTrades = windows.filter(w => w.moveAtT60 >= 0.05 && !w.spikeAtEnd && !w.moveMonotonic);

    const steadyCorrect = steadyTrades.filter(w => !w.reversed).length;
    const spikeCorrect = spikeTrades.filter(w => !w.reversed).length;
    const choppyCorrect = choppyTrades.filter(w => !w.reversed).length;

    console.log(`Steady grind (monotonic, no spike): ${steadyCorrect}/${steadyTrades.length} (${(steadyCorrect / steadyTrades.length * 100).toFixed(1)}%) — ${steadyTrades.length} trades`);
    console.log(`Late spike (>50% of move in min 3):  ${spikeCorrect}/${spikeTrades.length} (${(spikeCorrect / spikeTrades.length * 100).toFixed(1)}%) — ${spikeTrades.length} trades`);
    console.log(`Choppy (not monotonic, no spike):    ${choppyCorrect}/${choppyTrades.length} (${(choppyCorrect / choppyTrades.length * 100).toFixed(1)}%) — ${choppyTrades.length} trades`);

    // === 4. MOVE BUILD-UP: Was direction consistent from T-180 through T-60? ===
    console.log('\n=== 4. MOVE CONFIRMATION (was direction same at T-180, T-120, and T-60?) ===\n');

    const confirmed = windows.filter(w => {
        if (w.moveAtT60 < 0.05) return false;
        const dir60 = w.prices[3] >= w.openPrice ? 'UP' : 'DOWN';
        const dir120 = w.prices[2] >= w.openPrice ? 'UP' : 'DOWN';
        const dir180 = w.prices[1] >= w.openPrice ? 'UP' : 'DOWN';
        return dir60 === dir120 && dir120 === dir180;
    });
    const unconfirmed = windows.filter(w => {
        if (w.moveAtT60 < 0.05) return false;
        const dir60 = w.prices[3] >= w.openPrice ? 'UP' : 'DOWN';
        const dir120 = w.prices[2] >= w.openPrice ? 'UP' : 'DOWN';
        const dir180 = w.prices[1] >= w.openPrice ? 'UP' : 'DOWN';
        return !(dir60 === dir120 && dir120 === dir180);
    });

    const confCorrect = confirmed.filter(w => !w.reversed).length;
    const unconfCorrect = unconfirmed.filter(w => !w.reversed).length;

    console.log(`Confirmed (same dir at T-180/120/60): ${confCorrect}/${confirmed.length} (${(confCorrect / confirmed.length * 100).toFixed(1)}%) — ${confirmed.length} trades`);
    console.log(`Unconfirmed (direction changed):      ${unconfCorrect}/${unconfirmed.length} (${(unconfCorrect / unconfirmed.length * 100).toFixed(1)}%) — ${unconfirmed.length} trades`);

    // Confirmed + move size
    console.log('\nConfirmed signals by move size:');
    const confBands = [
        { label: '5-8bps', min: 0.05, max: 0.08 },
        { label: '8-10bps', min: 0.08, max: 0.10 },
        { label: '10-15bps', min: 0.10, max: 0.15 },
        { label: '15+bps', min: 0.15, max: 999 },
    ];
    for (const band of confBands) {
        const bandTrades = confirmed.filter(w => w.moveAtT60 >= band.min && w.moveAtT60 < band.max);
        if (bandTrades.length < 10) continue;
        const correct = bandTrades.filter(w => !w.reversed).length;
        console.log(`  ${band.label}: ${correct}/${bandTrades.length} (${(correct / bandTrades.length * 100).toFixed(1)}%)`);
    }

    // === 5. RANGE-BASED FILTER: Does intra-candle range predict reversals? ===
    console.log('\n=== 5. INTRA-CANDLE RANGE (does high volatility within candle predict reversals?) ===\n');

    const qualifying = windows.filter(w => w.moveAtT60 >= 0.05);
    const ranges = qualifying.map(w => w.range).sort((a, b) => a - b);
    const medianRange = ranges[Math.floor(ranges.length / 2)];

    const lowRange = qualifying.filter(w => w.range <= medianRange);
    const highRange = qualifying.filter(w => w.range > medianRange);

    const lowRangeCorrect = lowRange.filter(w => !w.reversed).length;
    const highRangeCorrect = highRange.filter(w => !w.reversed).length;

    console.log(`Median intra-candle range: ${(medianRange * 100).toFixed(1)}bps`);
    console.log(`Low range (≤ median): ${lowRangeCorrect}/${lowRange.length} (${(lowRangeCorrect / lowRange.length * 100).toFixed(1)}%) accuracy`);
    console.log(`High range (> median): ${highRangeCorrect}/${highRange.length} (${(highRangeCorrect / highRange.length * 100).toFixed(1)}%) accuracy`);

    // Quartile breakdown
    console.log('\nRange quartiles:');
    for (let q = 0; q < 4; q++) {
        const qStart = ranges[Math.floor(ranges.length * q / 4)];
        const qEnd = ranges[Math.floor(ranges.length * (q + 1) / 4) - 1];
        const qTrades = qualifying.filter(w => w.range >= qStart && (q === 3 || w.range < ranges[Math.floor(ranges.length * (q + 1) / 4)]));
        const qCorrect = qTrades.filter(w => !w.reversed).length;
        console.log(`  Q${q + 1} (${(qStart * 100).toFixed(0)}-${(qEnd * 100).toFixed(0)}bps range): ${qCorrect}/${qTrades.length} (${(qCorrect / qTrades.length * 100).toFixed(1)}%)`);
    }

    // === 6. FADE STRATEGY: Buy the LOSER on weak moves ===
    console.log('\n=== 6. FADE STRATEGY (buy the LOSER token when move is small) ===\n');

    function estimateWinnerPrice(movePct: number): number {
        if (movePct < 0.01) return 0.50;
        if (movePct < 0.03) return 0.55;
        if (movePct < 0.05) return 0.60;
        if (movePct < 0.08) return 0.65;
        if (movePct < 0.10) return 0.70;
        if (movePct < 0.15) return 0.78;
        if (movePct < 0.20) return 0.83;
        return 0.88;
    }

    function takerFee(price: number): number {
        return Math.min(price, 1 - price) * 0.0222;
    }

    console.log('If we BUY THE LOSER (fade) on small moves:');
    for (const band of [
        { label: '3-5bps', min: 0.03, max: 0.05 },
        { label: '5-8bps', min: 0.05, max: 0.08 },
        { label: '3-8bps', min: 0.03, max: 0.08 },
    ]) {
        const fadeTrades = windows.filter(w => w.moveAtT60 >= band.min && w.moveAtT60 < band.max);
        if (fadeTrades.length < 20) continue;
        // Fade = bet on reversal. We buy the loser token.
        // Loser price ≈ 1 - winner price
        let wins = 0, losses = 0, totalPnl = 0;
        for (const w of fadeTrades) {
            const winnerPrice = estimateWinnerPrice(w.moveAtT60);
            const loserPrice = 1 - winnerPrice; // approximate
            const fee = takerFee(loserPrice);
            const cost = loserPrice + fee;
            const tokens = 100 / cost;

            if (w.reversed) {
                // Reversal = our fade wins! Loser becomes winner.
                totalPnl += tokens * (1 - cost);
                wins++;
            } else {
                // Momentum held = our fade loses. Loser goes to $0.
                totalPnl -= 100;
                losses++;
            }
        }
        const acc = wins / fadeTrades.length * 100;
        console.log(`  ${band.label}: ${wins}/${fadeTrades.length} reversals (${acc.toFixed(1)}%) | P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)} | Per trade: ${(totalPnl / fadeTrades.length).toFixed(2)}`);
    }

    // === 7. COMBINED SIGNAL: confirmed + steady + big move ===
    console.log('\n=== 7. COMBINED BEST SIGNAL (confirmed + steady + >10bps) ===\n');

    const bestSignal = windows.filter(w => {
        if (w.moveAtT60 < 0.10) return false;
        // Confirmed direction
        const dir60 = w.prices[3] >= w.openPrice ? 'UP' : 'DOWN';
        const dir120 = w.prices[2] >= w.openPrice ? 'UP' : 'DOWN';
        const dir180 = w.prices[1] >= w.openPrice ? 'UP' : 'DOWN';
        if (!(dir60 === dir120 && dir120 === dir180)) return false;
        // Not a late spike
        if (w.spikeAtEnd) return false;
        return true;
    });

    const bestCorrect = bestSignal.filter(w => !w.reversed).length;
    console.log(`Confirmed + steady + >10bps: ${bestCorrect}/${bestSignal.length} (${(bestCorrect / bestSignal.length * 100).toFixed(1)}%)`);
    console.log(`Trades per day: ~${(bestSignal.length / DAYS).toFixed(1)}`);

    // Compare with just >10bps
    const just10 = windows.filter(w => w.moveAtT60 >= 0.10);
    const just10Correct = just10.filter(w => !w.reversed).length;
    console.log(`\nComparison — just >10bps: ${just10Correct}/${just10.length} (${(just10Correct / just10.length * 100).toFixed(1)}%)`);

    // Spike-only at >10bps
    const spikeOnly10 = windows.filter(w => w.moveAtT60 >= 0.10 && w.spikeAtEnd);
    const spikeCorrect10 = spikeOnly10.filter(w => !w.reversed).length;
    console.log(`Spike-only >10bps: ${spikeCorrect10}/${spikeOnly10.length} (${spikeOnly10.length > 0 ? (spikeCorrect10 / spikeOnly10.length * 100).toFixed(1) : 'N/A'}%)`);

    // === 8. TIME-FILTERED NEW REGIME ===
    console.log('\n=== 8. TIME FILTER (overnight only 00-06 ET, >5bps, new regime) ===\n');

    const overnightTrades = windows.filter(w => {
        if (w.moveAtT60 < 0.05) return false;
        const date = new Date(w.bucket);
        const hourET = parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
        return hourET >= 0 && hourET < 6;
    });
    const dayTrades = windows.filter(w => {
        if (w.moveAtT60 < 0.05) return false;
        const date = new Date(w.bucket);
        const hourET = parseInt(date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false }));
        return hourET >= 9 && hourET < 16;
    });

    const onCorrect = overnightTrades.filter(w => !w.reversed).length;
    const dayCorrect = dayTrades.filter(w => !w.reversed).length;

    console.log(`Overnight (00-06 ET): ${onCorrect}/${overnightTrades.length} (${(onCorrect / overnightTrades.length * 100).toFixed(1)}%)`);
    console.log(`US hours (09-16 ET):  ${dayCorrect}/${dayTrades.length} (${(dayCorrect / dayTrades.length * 100).toFixed(1)}%)`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
