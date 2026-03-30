/**
 * Confirmed + Steady + >10bps Signal — Full 365-Day Backtest
 *
 * Filters:
 *   1. Direction same at T-180s, T-120s, T-60s (confirmed)
 *   2. Price grinded steadily (not a late spike — min 3 < 50% of total move)
 *   3. Move > 10bps at T-60s
 *
 * Run: npx tsx src/scripts/crypto-5min/confirmed-steady-backtest.ts [days]
 */

import ccxt from 'ccxt';

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

async function main() {
    const DAYS = parseInt(process.argv[2] || '365');
    const TRADE_SIZE = 100;

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

    interface Trade {
        timestamp: number;
        dateET: string;
        monthET: string;
        correct: boolean;
        pnl: number;
        movePct: number;
        signal: string; // which filter combo
    }

    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    // Define signal variants to compare
    const signals = [
        { name: 'Naive >5bps', minMove: 0.05, needConfirmed: false, noSpike: false },
        { name: 'Naive >10bps', minMove: 0.10, needConfirmed: false, noSpike: false },
        { name: 'Confirmed >10bps', minMove: 0.10, needConfirmed: true, noSpike: false },
        { name: 'Steady >10bps', minMove: 0.10, needConfirmed: false, noSpike: true },
        { name: 'Confirmed+Steady >10bps', minMove: 0.10, needConfirmed: true, noSpike: true },
        { name: 'Confirmed+Steady >8bps', minMove: 0.08, needConfirmed: true, noSpike: true },
        { name: 'Confirmed+Steady >15bps', minMove: 0.15, needConfirmed: true, noSpike: true },
    ];

    // Collect trades for each signal by month
    const results: Map<string, Map<string, { w: number; l: number; pnl: number; trades: number }>> = new Map();
    for (const sig of signals) {
        results.set(sig.name, new Map());
    }

    // Also collect full trade list for the main signal
    const mainTrades: Trade[] = [];

    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const prices = mins.map((m: any) => m[4]);
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';

        const moveAtT60 = Math.abs(prices[3] - openPrice) / openPrice * 100;
        const dirAtT60: 'UP' | 'DOWN' = prices[3] >= openPrice ? 'UP' : 'DOWN';
        const correct = dirAtT60 === outcome;

        // Confirmed: same direction at T-180, T-120, T-60
        const dir180 = prices[1] >= openPrice ? 'UP' : 'DOWN';
        const dir120 = prices[2] >= openPrice ? 'UP' : 'DOWN';
        const isConfirmed = dirAtT60 === dir120 && dir120 === dir180;

        // Spike: did min 3 account for >50% of the total move?
        const totalMove = prices[3] - openPrice;
        const min3Move = prices[3] - prices[2];
        const isSpike = Math.abs(totalMove) > 0 && Math.abs(min3Move) / Math.abs(totalMove) > 0.5;

        const date = new Date(bucket);
        const monthET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });
        const dateET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' });

        const winnerPrice = estimateWinnerPrice(moveAtT60);
        const fee = takerFee(winnerPrice);
        const cost = winnerPrice + fee;
        const tokens = TRADE_SIZE / cost;
        const pnl = correct ? tokens * (1 - cost) : -TRADE_SIZE;

        for (const sig of signals) {
            if (moveAtT60 < sig.minMove) continue;
            if (winnerPrice > 0.80) continue;
            if (sig.needConfirmed && !isConfirmed) continue;
            if (sig.noSpike && isSpike) continue;

            const monthMap = results.get(sig.name)!;
            if (!monthMap.has(monthET)) monthMap.set(monthET, { w: 0, l: 0, pnl: 0, trades: 0 });
            const m = monthMap.get(monthET)!;
            m.trades++;
            m.pnl += pnl;
            if (correct) m.w++; else m.l++;
        }

        // Main signal trades
        if (moveAtT60 >= 0.10 && winnerPrice <= 0.80 && isConfirmed && !isSpike) {
            mainTrades.push({ timestamp: bucket, dateET, monthET, correct, pnl, movePct: moveAtT60, signal: 'main' });
        }
    }

    // === 1. OVERALL COMPARISON ===
    console.log('=== SIGNAL COMPARISON — FULL 365 DAYS ===\n');
    console.log(
        'Signal'.padEnd(30) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(12) + ' | ' +
        'Per Trade'.padEnd(10) + ' | ' +
        'Daily Est'
    );
    console.log('-'.repeat(85));

    for (const sig of signals) {
        const monthMap = results.get(sig.name)!;
        let totalW = 0, totalL = 0, totalPnl = 0;
        for (const [, data] of monthMap) {
            totalW += data.w;
            totalL += data.l;
            totalPnl += data.pnl;
        }
        const total = totalW + totalL;
        if (total === 0) continue;
        const acc = totalW / total * 100;
        const perTrade = totalPnl / total;
        const daily = perTrade * (total / DAYS);

        console.log(
            sig.name.padEnd(30) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)).padEnd(12) + ' | ' +
            ((perTrade >= 0 ? '+' : '') + '$' + perTrade.toFixed(2)).padEnd(10) + ' | ' +
            ((daily >= 0 ? '+' : '') + '$' + daily.toFixed(0))
        );
    }

    // === 2. MONTHLY TREND — Main signal vs Naive ===
    console.log('\n=== MONTHLY ACCURACY: Confirmed+Steady >10bps vs Naive >5bps ===\n');
    console.log(
        'Month'.padEnd(12) + ' | ' +
        'C+S >10 Acc'.padEnd(12) + ' | ' +
        'C+S >10 Trades'.padEnd(15) + ' | ' +
        'Naive >5 Acc'.padEnd(13) + ' | ' +
        'Naive >5 Trades'.padEnd(16) + ' | ' +
        'Advantage'
    );
    console.log('-'.repeat(85));

    const mainMonths = results.get('Confirmed+Steady >10bps')!;
    const naiveMonths = results.get('Naive >5bps')!;

    for (const [month] of mainMonths) {
        const main = mainMonths.get(month);
        const naive = naiveMonths.get(month);
        if (!main || !naive) continue;

        const mainAcc = main.w / main.trades * 100;
        const naiveAcc = naive.w / naive.trades * 100;
        const adv = mainAcc - naiveAcc;

        console.log(
            month.padEnd(12) + ' | ' +
            (mainAcc.toFixed(1) + '%').padEnd(12) + ' | ' +
            String(main.trades).padEnd(15) + ' | ' +
            (naiveAcc.toFixed(1) + '%').padEnd(13) + ' | ' +
            String(naive.trades).padEnd(16) + ' | ' +
            (adv >= 0 ? '+' : '') + adv.toFixed(1) + 'pp'
        );
    }

    // === 3. WORST STREAKS for main signal ===
    console.log('\n=== WORST CONSECUTIVE LOSSES (Confirmed+Steady >10bps) ===\n');

    interface Streak { length: number; loss: number; startTime: string; endTime: string }
    const streaks: Streak[] = [];
    let currentStreak = 0, streakLoss = 0, streakStart = '';

    for (let i = 0; i < mainTrades.length; i++) {
        if (!mainTrades[i].correct) {
            if (currentStreak === 0) streakStart = mainTrades[i].dateET;
            currentStreak++;
            streakLoss += mainTrades[i].pnl;
        } else {
            if (currentStreak > 0) {
                streaks.push({ length: currentStreak, loss: streakLoss, startTime: streakStart, endTime: mainTrades[i - 1].dateET });
            }
            currentStreak = 0;
            streakLoss = 0;
        }
    }
    if (currentStreak > 0) {
        streaks.push({ length: currentStreak, loss: streakLoss, startTime: streakStart, endTime: mainTrades[mainTrades.length - 1].dateET });
    }

    streaks.sort((a, b) => a.loss - b.loss);
    console.log('#'.padEnd(4) + ' | ' + 'Losses'.padEnd(7) + ' | ' + 'Total Loss'.padEnd(11) + ' | ' + 'When');
    console.log('-'.repeat(55));
    for (let i = 0; i < Math.min(10, streaks.length); i++) {
        const s = streaks[i];
        console.log(
            String(i + 1).padEnd(4) + ' | ' +
            String(s.length).padEnd(7) + ' | ' +
            ('-$' + Math.abs(s.loss).toFixed(0)).padEnd(11) + ' | ' +
            s.startTime + ' - ' + s.endTime
        );
    }

    // Streak distribution
    const streakCounts: Map<number, number> = new Map();
    for (const s of streaks) streakCounts.set(s.length, (streakCounts.get(s.length) || 0) + 1);
    console.log('\nStreak distribution:');
    for (let len = 1; len <= Math.max(...streaks.map(s => s.length)); len++) {
        const count = streakCounts.get(len) || 0;
        if (count === 0) continue;
        console.log(`  ${len} loss: ${count} times (${(count / streaks.length * 100).toFixed(1)}%)`);
    }

    // === 4. DRAWDOWN ===
    console.log('\n=== DRAWDOWN ANALYSIS (Confirmed+Steady >10bps) ===\n');

    let runPnl = 0, peakPnl = 0, maxDD = 0;
    let ddPeak = 0, ddTrough = 0, ddPeakTime = '', ddTroughTime = '';

    for (const t of mainTrades) {
        runPnl += t.pnl;
        if (runPnl > peakPnl) {
            peakPnl = runPnl;
        }
        const dd = peakPnl - runPnl;
        if (dd > maxDD) {
            maxDD = dd;
            ddTroughTime = t.dateET;
        }
    }

    console.log(`Total P&L: +$${runPnl.toFixed(0)}`);
    console.log(`Max drawdown: -$${maxDD.toFixed(0)}`);
    console.log(`Per day: +$${(runPnl / DAYS).toFixed(0)}`);
    console.log(`Trades/day: ${(mainTrades.length / DAYS).toFixed(1)}`);

    // === 5. DAILY P&L DISTRIBUTION ===
    console.log('\n=== DAILY P&L DISTRIBUTION (Confirmed+Steady >10bps) ===\n');

    const dailyPnl = new Map<string, number>();
    for (const t of mainTrades) {
        dailyPnl.set(t.dateET, (dailyPnl.get(t.dateET) || 0) + t.pnl);
    }
    const dailyVals = [...dailyPnl.values()].sort((a, b) => a - b);
    const negDays = dailyVals.filter(v => v < 0).length;

    console.log(`Trading days: ${dailyVals.length}`);
    console.log(`Negative days: ${negDays} (${(negDays / dailyVals.length * 100).toFixed(1)}%)`);
    console.log(`Worst day: $${dailyVals[0].toFixed(0)}`);
    console.log(`Best day: +$${dailyVals[dailyVals.length - 1].toFixed(0)}`);
    console.log(`Median day: +$${dailyVals[Math.floor(dailyVals.length / 2)].toFixed(0)}`);

    // Last 14 days
    console.log('\n=== LAST 14 DAYS (Confirmed+Steady >10bps) ===\n');
    const dailyDetail = new Map<string, { w: number; l: number; pnl: number }>();
    for (const t of mainTrades) {
        if (!dailyDetail.has(t.dateET)) dailyDetail.set(t.dateET, { w: 0, l: 0, pnl: 0 });
        const d = dailyDetail.get(t.dateET)!;
        d.pnl += t.pnl;
        if (t.correct) d.w++; else d.l++;
    }

    const sortedDays = [...dailyDetail.entries()].sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    const last14 = sortedDays.slice(-14);

    console.log('Date'.padEnd(14) + ' | ' + 'W'.padEnd(4) + ' | ' + 'L'.padEnd(4) + ' | ' + 'Acc%'.padEnd(7) + ' | ' + 'P&L');
    console.log('-'.repeat(45));
    for (const [date, data] of last14) {
        const total = data.w + data.l;
        console.log(
            date.padEnd(14) + ' | ' +
            String(data.w).padEnd(4) + ' | ' +
            String(data.l).padEnd(4) + ' | ' +
            ((data.w / total * 100).toFixed(1) + '%').padEnd(7) + ' | ' +
            (data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(0)
        );
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
