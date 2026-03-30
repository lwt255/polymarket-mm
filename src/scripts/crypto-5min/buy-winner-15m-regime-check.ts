/**
 * 15-Minute Market Regime Check
 * Same analysis as the 5-min regime check but for 15-minute candles.
 *
 * 15-min candle = 15 one-minute bars
 * T-60s = minute 14 close (index 13)
 * T-120s = minute 13 close (index 12)
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-15m-regime-check.ts [days]
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
    console.log(`Got ${allCandles.length} 1-min candles\n`);

    // Build 15-min windows (900s = 900000ms)
    const WINDOW_MS = 900000;
    const WINDOW_MINS = 15;
    const groups: Map<number, any[]> = new Map();
    for (const c of allCandles) {
        const bucket = Math.floor(c[0] / WINDOW_MS) * WINDOW_MS;
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
        moveBand: string;
    }

    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    // Test multiple thresholds and entry times
    const thresholds = [0.03, 0.05, 0.08, 0.10, 0.15, 0.20];

    // === 1. THRESHOLD COMPARISON (T-60s) ===
    console.log('=== 15-MIN MARKET: THRESHOLD COMPARISON (T-60s entry) ===\n');
    console.log(
        'Threshold'.padEnd(12) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(6) + ' | ' +
        'L'.padEnd(5) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'Avg Win'.padEnd(8) + ' | ' +
        'BE Acc'.padEnd(7) + ' | ' +
        'Total P&L'.padEnd(12) + ' | ' +
        'Per Trade'.padEnd(10) + ' | ' +
        'Daily Est'
    );
    console.log('-'.repeat(105));

    for (const threshold of thresholds) {
        let wins = 0, losses = 0, totalPnl = 0;
        const winAmounts: number[] = [];

        for (const [, mins] of sortedBuckets) {
            if (mins.length < WINDOW_MINS) continue;
            mins.sort((a: any, b: any) => a[0] - b[0]);

            const openPrice = mins[0][1];
            const closePrice = mins[WINDOW_MINS - 1][4];
            const priceAtT60 = mins[WINDOW_MINS - 2][4]; // minute 14 close = T-60s

            const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
            const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;
            const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';

            if (movePct < threshold) continue;
            const winnerPrice = estimateWinnerPrice(movePct);
            if (winnerPrice > 0.80) continue;

            const fee = takerFee(winnerPrice);
            const cost = winnerPrice + fee;
            const tokens = TRADE_SIZE / cost;
            const correct = direction === outcome;

            if (correct) {
                const pnl = tokens * (1 - cost);
                totalPnl += pnl;
                winAmounts.push(pnl);
                wins++;
            } else {
                totalPnl -= TRADE_SIZE;
                losses++;
            }
        }

        const total = wins + losses;
        if (total < 50) continue;
        const acc = wins / total * 100;
        const avgWin = winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0;
        const beAcc = TRADE_SIZE / (TRADE_SIZE + avgWin) * 100;
        const perTrade = totalPnl / total;
        const dailyEst = perTrade * (total / DAYS);

        console.log(
            (`>${(threshold * 100).toFixed(0)}bps`).padEnd(12) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            String(wins).padEnd(6) + ' | ' +
            String(losses).padEnd(5) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ('+$' + avgWin.toFixed(0)).padEnd(8) + ' | ' +
            (beAcc.toFixed(0) + '%').padEnd(7) + ' | ' +
            ((totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)).padEnd(12) + ' | ' +
            ((perTrade >= 0 ? '+' : '') + '$' + perTrade.toFixed(2)).padEnd(10) + ' | ' +
            ((dailyEst >= 0 ? '+' : '') + '$' + dailyEst.toFixed(0))
        );
    }

    // === 2. ENTRY TIME COMPARISON ===
    console.log('\n=== 15-MIN MARKET: ENTRY TIME COMPARISON (>5bps threshold) ===\n');

    const entryTimes = [
        { label: 'T-60s (min 14)', idx: 13 },
        { label: 'T-120s (min 13)', idx: 12 },
        { label: 'T-180s (min 12)', idx: 11 },
        { label: 'T-240s (min 11)', idx: 10 },
        { label: 'T-300s (min 10)', idx: 9 },
        { label: 'T-420s (min 8)', idx: 7 },
        { label: 'T-600s (min 5)', idx: 4 },
    ];

    console.log(
        'Entry'.padEnd(22) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(12) + ' | ' +
        'Per Trade'
    );
    console.log('-'.repeat(65));

    for (const entry of entryTimes) {
        let wins = 0, losses = 0, totalPnl = 0;

        for (const [, mins] of sortedBuckets) {
            if (mins.length < WINDOW_MINS) continue;
            mins.sort((a: any, b: any) => a[0] - b[0]);

            const openPrice = mins[0][1];
            const closePrice = mins[WINDOW_MINS - 1][4];
            const priceAtEntry = mins[entry.idx][4];

            const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
            const movePct = Math.abs(priceAtEntry - openPrice) / openPrice * 100;
            const direction = priceAtEntry >= openPrice ? 'UP' : 'DOWN';

            if (movePct < 0.05) continue;
            const winnerPrice = estimateWinnerPrice(movePct);
            if (winnerPrice > 0.80) continue;

            const fee = takerFee(winnerPrice);
            const cost = winnerPrice + fee;
            const tokens = TRADE_SIZE / cost;
            const correct = direction === outcome;

            if (correct) {
                totalPnl += tokens * (1 - cost);
                wins++;
            } else {
                totalPnl -= TRADE_SIZE;
                losses++;
            }
        }

        const total = wins + losses;
        if (total < 50) continue;
        const acc = wins / total * 100;

        console.log(
            entry.label.padEnd(22) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)).padEnd(12) + ' | ' +
            ((totalPnl / total >= 0 ? '+' : '') + '$' + (totalPnl / total).toFixed(2))
        );
    }

    // === 3. MONTHLY ACCURACY TREND (T-60s, >5bps) — the key regime check ===
    console.log('\n=== 15-MIN MARKET: MONTHLY ACCURACY TREND (T-60s, >5bps) ===\n');

    const MIN_MOVE = 0.05;
    const trades: Trade[] = [];

    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < WINDOW_MINS) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[WINDOW_MINS - 1][4];
        const priceAtT60 = mins[WINDOW_MINS - 2][4];

        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
        const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;
        const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';

        if (movePct < MIN_MOVE) continue;
        const winnerPrice = estimateWinnerPrice(movePct);
        if (winnerPrice > 0.80) continue;

        const fee = takerFee(winnerPrice);
        const cost = winnerPrice + fee;
        const tokens = TRADE_SIZE / cost;
        const correct = direction === outcome;
        const pnl = correct ? tokens * (1 - cost) : -TRADE_SIZE;

        const date = new Date(bucket);
        const dateET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' });
        const monthET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });

        let moveBand: string;
        if (movePct < 0.08) moveBand = '5-8bps';
        else if (movePct < 0.10) moveBand = '8-10bps';
        else if (movePct < 0.15) moveBand = '10-15bps';
        else moveBand = '15+bps';

        trades.push({ timestamp: bucket, dateET, monthET, correct, pnl, movePct, moveBand });
    }

    console.log(
        'Month'.padEnd(12) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(5) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(12) + ' | ' +
        'Per Trade'.padEnd(10) + ' | ' +
        'Trend'
    );
    console.log('-'.repeat(80));

    const months = new Map<string, { w: number; l: number; pnl: number; trades: number }>();
    for (const t of trades) {
        if (!months.has(t.monthET)) months.set(t.monthET, { w: 0, l: 0, pnl: 0, trades: 0 });
        const m = months.get(t.monthET)!;
        m.trades++;
        m.pnl += t.pnl;
        if (t.correct) m.w++; else m.l++;
    }

    let prevAcc = 0;
    for (const [month, data] of months) {
        const acc = data.w / data.trades * 100;
        const perTrade = data.pnl / data.trades;
        const trend = prevAcc === 0 ? '' : acc > prevAcc ? '↑' : acc < prevAcc ? '↓' : '→';
        prevAcc = acc;
        console.log(
            month.padEnd(12) + ' | ' +
            String(data.trades).padEnd(7) + ' | ' +
            String(data.w).padEnd(5) + ' | ' +
            String(data.l).padEnd(4) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(0)).padEnd(12) + ' | ' +
            ((perTrade >= 0 ? '+' : '') + '$' + perTrade.toFixed(2)).padEnd(10) + ' | ' +
            trend
        );
    }

    // === 4. REVERSAL RATE BY MONTH ===
    console.log('\n=== 15-MIN MARKET: REVERSAL RATE BY MONTH (all candles, >1bps move) ===\n');

    const revByMonth = new Map<string, { total: number; reversed: number }>();
    for (const [, mins] of sortedBuckets) {
        if (mins.length < WINDOW_MINS) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[WINDOW_MINS - 1][4];
        const priceAtT60 = mins[WINDOW_MINS - 2][4];

        const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;
        if (movePct < 0.01) continue;

        const dirAtT60 = priceAtT60 >= openPrice ? 'UP' : 'DOWN';
        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';

        const date = new Date(mins[0][0]);
        const monthKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });
        if (!revByMonth.has(monthKey)) revByMonth.set(monthKey, { total: 0, reversed: 0 });
        const m = revByMonth.get(monthKey)!;
        m.total++;
        if (dirAtT60 !== outcome) m.reversed++;
    }

    console.log('Month'.padEnd(12) + ' | ' + 'Candles'.padEnd(8) + ' | ' + 'Reversed'.padEnd(9) + ' | ' + 'Reversal Rate');
    console.log('-'.repeat(50));
    for (const [month, data] of revByMonth) {
        const rate = data.reversed / data.total * 100;
        console.log(
            month.padEnd(12) + ' | ' +
            String(data.total).padEnd(8) + ' | ' +
            String(data.reversed).padEnd(9) + ' | ' +
            rate.toFixed(1) + '%'
        );
    }

    // === 5. BAND ACCURACY BY MONTH ===
    console.log('\n=== 15-MIN: 5-8bps BAND ACCURACY BY MONTH ===\n');
    const bandByMonth = new Map<string, { w: number; l: number; trades: number }>();
    for (const t of trades) {
        if (t.moveBand !== '5-8bps') continue;
        if (!bandByMonth.has(t.monthET)) bandByMonth.set(t.monthET, { w: 0, l: 0, trades: 0 });
        const m = bandByMonth.get(t.monthET)!;
        m.trades++;
        if (t.correct) m.w++; else m.l++;
    }
    console.log('Month'.padEnd(12) + ' | ' + 'Trades'.padEnd(7) + ' | ' + 'Acc%'.padEnd(7) + ' | ' + 'Losses');
    console.log('-'.repeat(45));
    for (const [month, data] of bandByMonth) {
        console.log(
            month.padEnd(12) + ' | ' +
            String(data.trades).padEnd(7) + ' | ' +
            ((data.w / data.trades * 100).toFixed(1) + '%').padEnd(7) + ' | ' +
            data.l
        );
    }

    console.log('\n=== 15-MIN: 8+bps BAND ACCURACY BY MONTH ===\n');
    const strongByMonth = new Map<string, { w: number; l: number; trades: number }>();
    for (const t of trades) {
        if (t.movePct < 0.08) continue;
        if (!strongByMonth.has(t.monthET)) strongByMonth.set(t.monthET, { w: 0, l: 0, trades: 0 });
        const m = strongByMonth.get(t.monthET)!;
        m.trades++;
        if (t.correct) m.w++; else m.l++;
    }
    console.log('Month'.padEnd(12) + ' | ' + 'Trades'.padEnd(7) + ' | ' + 'Acc%'.padEnd(7) + ' | ' + 'Losses');
    console.log('-'.repeat(45));
    for (const [month, data] of strongByMonth) {
        console.log(
            month.padEnd(12) + ' | ' +
            String(data.trades).padEnd(7) + ' | ' +
            ((data.w / data.trades * 100).toFixed(1) + '%').padEnd(7) + ' | ' +
            data.l
        );
    }

    // === 6. LAST 14 DAYS DAILY DETAIL ===
    console.log('\n=== 15-MIN: LAST 14 DAYS DAILY DETAIL ===\n');
    const dailyData = new Map<string, { w: number; l: number; pnl: number; trades: number; totalMove: number }>();
    for (const t of trades) {
        if (!dailyData.has(t.dateET)) dailyData.set(t.dateET, { w: 0, l: 0, pnl: 0, trades: 0, totalMove: 0 });
        const d = dailyData.get(t.dateET)!;
        d.trades++;
        d.pnl += t.pnl;
        d.totalMove += t.movePct;
        if (t.correct) d.w++; else d.l++;
    }

    const sortedDays = [...dailyData.entries()].sort((a, b) => new Date(a[0]).getTime() - new Date(b[0]).getTime());
    const last14 = sortedDays.slice(-14);

    console.log(
        'Date'.padEnd(14) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(4) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(10) + ' | ' +
        'Avg Move'
    );
    console.log('-'.repeat(65));
    for (const [date, data] of last14) {
        const acc = data.w / data.trades * 100;
        const avgMove = data.totalMove / data.trades;
        console.log(
            date.padEnd(14) + ' | ' +
            String(data.trades).padEnd(7) + ' | ' +
            String(data.w).padEnd(4) + ' | ' +
            String(data.l).padEnd(4) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(0)).padEnd(10) + ' | ' +
            avgMove.toFixed(3) + '%'
        );
    }

    // === 7. 5-MIN vs 15-MIN SIDE BY SIDE (last 3 months) ===
    console.log('\n=== 5-MIN vs 15-MIN COMPARISON (same data, >5bps, T-60s) ===\n');

    // Build 5-min windows for comparison
    const groups5m: Map<number, any[]> = new Map();
    for (const c of allCandles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups5m.has(bucket)) groups5m.set(bucket, []);
        groups5m.get(bucket)!.push(c);
    }

    const compare = new Map<string, { acc5m: number; acc15m: number; trades5m: number; trades15m: number }>();

    // 5-min stats by month
    for (const [bucket, mins] of groups5m) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);
        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtT60 = mins[3][4];
        const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;
        if (movePct < 0.05) continue;
        const winnerPrice = estimateWinnerPrice(movePct);
        if (winnerPrice > 0.80) continue;
        const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';
        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
        const correct = direction === outcome;

        const date = new Date(bucket);
        const monthKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });
        if (!compare.has(monthKey)) compare.set(monthKey, { acc5m: 0, acc15m: 0, trades5m: 0, trades15m: 0 });
        const c = compare.get(monthKey)!;
        c.trades5m++;
        if (correct) c.acc5m++;
    }

    // 15-min stats by month (already computed in trades array)
    for (const t of trades) {
        if (!compare.has(t.monthET)) compare.set(t.monthET, { acc5m: 0, acc15m: 0, trades5m: 0, trades15m: 0 });
        const c = compare.get(t.monthET)!;
        c.trades15m++;
        if (t.correct) c.acc15m++;
    }

    console.log(
        'Month'.padEnd(12) + ' | ' +
        '5-Min Acc'.padEnd(10) + ' | ' +
        '5-Min Trades'.padEnd(13) + ' | ' +
        '15-Min Acc'.padEnd(11) + ' | ' +
        '15-Min Trades'.padEnd(14) + ' | ' +
        'Diff'
    );
    console.log('-'.repeat(75));
    for (const [month, data] of compare) {
        const acc5 = data.trades5m > 0 ? (data.acc5m / data.trades5m * 100) : 0;
        const acc15 = data.trades15m > 0 ? (data.acc15m / data.trades15m * 100) : 0;
        const diff = acc15 - acc5;
        console.log(
            month.padEnd(12) + ' | ' +
            (acc5.toFixed(1) + '%').padEnd(10) + ' | ' +
            String(data.trades5m).padEnd(13) + ' | ' +
            (acc15.toFixed(1) + '%').padEnd(11) + ' | ' +
            String(data.trades15m).padEnd(14) + ' | ' +
            (diff >= 0 ? '+' : '') + diff.toFixed(1) + 'pp'
        );
    }

    // === 8. WORST STREAKS (15-min) ===
    console.log('\n=== 15-MIN: WORST CONSECUTIVE LOSING STREAKS ===\n');

    interface Streak { length: number; loss: number; startTime: string; endTime: string }
    const streaks: Streak[] = [];
    let currentStreak = 0, streakLoss = 0, streakStartDate = '';

    for (let i = 0; i < trades.length; i++) {
        if (!trades[i].correct) {
            if (currentStreak === 0) streakStartDate = trades[i].dateET;
            currentStreak++;
            streakLoss += trades[i].pnl;
        } else {
            if (currentStreak > 0) {
                streaks.push({ length: currentStreak, loss: streakLoss, startTime: streakStartDate, endTime: trades[i - 1].dateET });
            }
            currentStreak = 0;
            streakLoss = 0;
        }
    }
    if (currentStreak > 0) {
        streaks.push({ length: currentStreak, loss: streakLoss, startTime: streakStartDate, endTime: trades[trades.length - 1].dateET });
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
    console.log('\n=== 15-MIN: STREAK LENGTH DISTRIBUTION ===\n');
    const streakCounts: Map<number, number> = new Map();
    for (const s of streaks) {
        streakCounts.set(s.length, (streakCounts.get(s.length) || 0) + 1);
    }
    console.log('Length | Count | Frequency');
    console.log('-'.repeat(35));
    const maxLen = Math.max(...streaks.map(s => s.length));
    for (let len = 1; len <= maxLen; len++) {
        const count = streakCounts.get(len) || 0;
        if (count === 0) continue;
        console.log(
            String(len).padEnd(7) + '| ' +
            String(count).padEnd(6) + '| ' +
            (count / streaks.length * 100).toFixed(1) + '%'
        );
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
