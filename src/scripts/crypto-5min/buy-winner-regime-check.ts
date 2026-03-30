/**
 * Regime Check: Is the buy-winner edge degrading over time?
 * Weekly accuracy trend, monthly breakdown, rolling 7-day accuracy.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-regime-check.ts [days]
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
    const DAYS = parseInt(process.argv[2] || '180');
    const MIN_MOVE_PCT = 0.05;
    const MAX_WINNER_ASK = 0.80;
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
        weekET: string;
        monthET: string;
        correct: boolean;
        pnl: number;
        movePct: number;
        moveBand: string;
    }

    const trades: Trade[] = [];
    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtMin4 = mins[3][4];
        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
        const movePct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        const direction = priceAtMin4 >= openPrice ? 'UP' : 'DOWN';

        if (movePct < MIN_MOVE_PCT) continue;
        const winnerPrice = estimateWinnerPrice(movePct);
        if (winnerPrice > MAX_WINNER_ASK) continue;

        const fee = takerFee(winnerPrice);
        const cost = winnerPrice + fee;
        const tokens = TRADE_SIZE / cost;
        const correct = direction === outcome;
        const pnl = correct ? tokens * (1 - cost) : -TRADE_SIZE;

        const date = new Date(bucket);
        const dateET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' });
        const monthET = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });

        // ISO week
        const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const dayOfYear = Math.floor((etDate.getTime() - new Date(etDate.getFullYear(), 0, 0).getTime()) / 86400000);
        const weekNum = Math.ceil(dayOfYear / 7);
        const weekET = `${etDate.getFullYear()}-W${String(weekNum).padStart(2, '0')}`;

        let moveBand: string;
        if (movePct < 0.08) moveBand = '5-8bps';
        else if (movePct < 0.10) moveBand = '8-10bps';
        else if (movePct < 0.15) moveBand = '10-15bps';
        else moveBand = '15+bps';

        trades.push({ timestamp: bucket, dateET, weekET, monthET, correct, pnl, movePct, moveBand });
    }

    // === 1. MONTHLY BREAKDOWN ===
    console.log('=== MONTHLY ACCURACY TREND ===\n');

    const months = new Map<string, { w: number; l: number; pnl: number; trades: number }>();
    for (const t of trades) {
        if (!months.has(t.monthET)) months.set(t.monthET, { w: 0, l: 0, pnl: 0, trades: 0 });
        const m = months.get(t.monthET)!;
        m.trades++;
        m.pnl += t.pnl;
        if (t.correct) m.w++; else m.l++;
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
    console.log('-'.repeat(85));

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

    // === 2. WEEKLY ROLLING ACCURACY ===
    console.log('\n=== WEEKLY ACCURACY TREND ===\n');

    const weeks = new Map<string, { w: number; l: number; pnl: number; trades: number; firstDate: string; lastDate: string }>();
    for (const t of trades) {
        if (!weeks.has(t.weekET)) weeks.set(t.weekET, { w: 0, l: 0, pnl: 0, trades: 0, firstDate: t.dateET, lastDate: t.dateET });
        const w = weeks.get(t.weekET)!;
        w.trades++;
        w.pnl += t.pnl;
        w.lastDate = t.dateET;
        if (t.correct) w.w++; else w.l++;
    }

    console.log(
        'Week'.padEnd(10) + ' | ' +
        'Dates'.padEnd(24) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'P&L'.padEnd(10) + ' | ' +
        'Bar'
    );
    console.log('-'.repeat(100));

    for (const [week, data] of weeks) {
        const acc = data.w / data.trades * 100;
        const barLen = Math.round(acc - 85); // scale: 85% = 0, 100% = 15
        const bar = acc >= 95 ? '█'.repeat(Math.max(0, barLen)) :
                    acc >= 90 ? '▓'.repeat(Math.max(0, barLen)) :
                    acc >= 85 ? '▒'.repeat(Math.max(0, barLen)) :
                    '░'.repeat(Math.max(0, Math.round(100 - acc)));

        console.log(
            week.padEnd(10) + ' | ' +
            (data.firstDate + ' - ' + data.lastDate).padEnd(24) + ' | ' +
            String(data.trades).padEnd(7) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            String(data.l).padEnd(4) + ' | ' +
            ((data.pnl >= 0 ? '+' : '') + '$' + data.pnl.toFixed(0)).padEnd(10) + ' | ' +
            bar
        );
    }

    // === 3. MOVE BAND ACCURACY BY MONTH — is the 5-8bps band getting worse? ===
    console.log('\n=== 5-8bps BAND ACCURACY BY MONTH (the weakest band) ===\n');

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

    // === 4. 8+bps BAND ACCURACY BY MONTH — is the STRONG signal also degrading? ===
    console.log('\n=== 8+bps BAND ACCURACY BY MONTH (stronger signals) ===\n');

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

    // === 5. DAILY ACCURACY — last 14 days zoomed in ===
    console.log('\n=== LAST 14 DAYS — DAILY DETAIL ===\n');

    const dailyData = new Map<string, { w: number; l: number; pnl: number; trades: number; avgMove: number; totalMove: number }>();
    for (const t of trades) {
        if (!dailyData.has(t.dateET)) dailyData.set(t.dateET, { w: 0, l: 0, pnl: 0, trades: 0, avgMove: 0, totalMove: 0 });
        const d = dailyData.get(t.dateET)!;
        d.trades++;
        d.pnl += t.pnl;
        d.totalMove += t.movePct;
        if (t.correct) d.w++; else d.l++;
    }

    const sortedDays = [...dailyData.entries()].sort((a, b) => {
        return new Date(a[0]).getTime() - new Date(b[0]).getTime();
    });
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

    // === 6. BTC VOLATILITY TREND — is BTC getting choppier? ===
    console.log('\n=== BTC DAILY RANGE BY MONTH (is volatility changing?) ===\n');

    // Use all 1-min candles to compute daily high-low range
    const dailyHL = new Map<string, { high: number; low: number; open: number }>();
    for (const c of allCandles) {
        const date = new Date(c[0]);
        const dateStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });
        if (!dailyHL.has(dateStr)) dailyHL.set(dateStr, { high: -Infinity, low: Infinity, open: c[1] });
        const d = dailyHL.get(dateStr)!;
        d.high = Math.max(d.high, c[2]);
        d.low = Math.min(d.low, c[3]);
    }

    // Actually let's do monthly avg range
    const monthlyRange = new Map<string, number[]>();
    const dailyHLByDate = new Map<string, { high: number; low: number; open: number; month: string }>();
    for (const c of allCandles) {
        const date = new Date(c[0]);
        const dateKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', year: 'numeric' });
        const monthKey = date.toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', year: 'numeric' });
        if (!dailyHLByDate.has(dateKey)) dailyHLByDate.set(dateKey, { high: -Infinity, low: Infinity, open: c[1], month: monthKey });
        const d = dailyHLByDate.get(dateKey)!;
        d.high = Math.max(d.high, c[2]);
        d.low = Math.min(d.low, c[3]);
    }

    for (const [, data] of dailyHLByDate) {
        const rangePct = (data.high - data.low) / data.open * 100;
        if (!monthlyRange.has(data.month)) monthlyRange.set(data.month, []);
        monthlyRange.get(data.month)!.push(rangePct);
    }

    console.log('Month'.padEnd(12) + ' | ' + 'Avg Daily Range'.padEnd(16) + ' | ' + 'Days');
    console.log('-'.repeat(40));
    for (const [month, ranges] of monthlyRange) {
        const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
        console.log(
            month.padEnd(12) + ' | ' +
            (avg.toFixed(2) + '%').padEnd(16) + ' | ' +
            ranges.length
        );
    }

    // === 7. REVERSAL RATE BY MONTH — are more candles reversing in the last minute? ===
    console.log('\n=== REVERSAL RATE BY MONTH (direction at T-60s vs final outcome) ===\n');
    console.log('This measures ALL 5-min candles, not just >5bps trades.\n');

    const revByMonth = new Map<string, { total: number; reversed: number }>();
    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtMin4 = mins[3][4];

        // Skip tiny moves
        const movePct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        if (movePct < 0.01) continue;

        const dirAtT60 = priceAtMin4 >= openPrice ? 'UP' : 'DOWN';
        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';

        const date = new Date(bucket);
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
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
