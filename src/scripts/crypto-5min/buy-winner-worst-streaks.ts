/**
 * Worst Streaks Analysis: What does "normal bad" look like over 180 days?
 * Shows worst losing streaks, worst 12h/24h windows, drawdowns, and recovery times.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-worst-streaks.ts [days]
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
        timeET: string;
        dateET: string;
        correct: boolean;
        pnl: number;
        movePct: number;
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
        const timeET = date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'numeric', day: 'numeric',
            hour: '2-digit', minute: '2-digit', hour12: true
        });
        const dateET = date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            month: 'numeric', day: 'numeric', year: 'numeric'
        });

        trades.push({ timestamp: bucket, timeET, dateET, correct, pnl, movePct });
    }

    console.log(`Total trades: ${trades.length}\n`);

    // === 1. WORST CONSECUTIVE LOSING STREAKS ===
    console.log('=== TOP 10 WORST CONSECUTIVE LOSING STREAKS ===\n');

    interface Streak {
        start: number;
        end: number;
        length: number;
        totalLoss: number;
        startTime: string;
        endTime: string;
    }

    const streaks: Streak[] = [];
    let currentStreak = 0;
    let streakStart = 0;
    let streakLoss = 0;

    for (let i = 0; i < trades.length; i++) {
        if (!trades[i].correct) {
            if (currentStreak === 0) streakStart = i;
            currentStreak++;
            streakLoss += trades[i].pnl;
        } else {
            if (currentStreak > 0) {
                streaks.push({
                    start: streakStart,
                    end: i - 1,
                    length: currentStreak,
                    totalLoss: streakLoss,
                    startTime: trades[streakStart].timeET,
                    endTime: trades[i - 1].timeET,
                });
            }
            currentStreak = 0;
            streakLoss = 0;
        }
    }
    if (currentStreak > 0) {
        streaks.push({
            start: streakStart,
            end: trades.length - 1,
            length: currentStreak,
            totalLoss: streakLoss,
            startTime: trades[streakStart].timeET,
            endTime: trades[trades.length - 1].timeET,
        });
    }

    streaks.sort((a, b) => a.totalLoss - b.totalLoss);
    console.log(
        '#'.padEnd(4) + ' | ' +
        'Losses'.padEnd(7) + ' | ' +
        'Total Loss'.padEnd(11) + ' | ' +
        'Start'.padEnd(22) + ' | ' +
        'End'
    );
    console.log('-'.repeat(80));
    for (let i = 0; i < Math.min(10, streaks.length); i++) {
        const s = streaks[i];
        console.log(
            String(i + 1).padEnd(4) + ' | ' +
            String(s.length).padEnd(7) + ' | ' +
            ('-$' + Math.abs(s.totalLoss).toFixed(0)).padEnd(11) + ' | ' +
            s.startTime.padEnd(22) + ' | ' +
            s.endTime
        );
    }

    // Distribution of streak lengths
    console.log('\n=== LOSING STREAK LENGTH DISTRIBUTION ===\n');
    const streakCounts: Map<number, number> = new Map();
    for (const s of streaks) {
        streakCounts.set(s.length, (streakCounts.get(s.length) || 0) + 1);
    }
    const maxStreakLen = Math.max(...streaks.map(s => s.length));
    console.log('Length | Count | Frequency');
    console.log('-'.repeat(35));
    for (let len = 1; len <= maxStreakLen; len++) {
        const count = streakCounts.get(len) || 0;
        if (count === 0) continue;
        const pct = (count / streaks.length * 100).toFixed(1);
        console.log(
            String(len).padEnd(7) + '| ' +
            String(count).padEnd(6) + '| ' +
            pct + '%'
        );
    }

    // === 2. WORST ROLLING WINDOWS ===
    // Worst 12-hour windows (by P&L)
    console.log('\n=== TOP 10 WORST 12-HOUR WINDOWS ===\n');

    interface Window {
        startIdx: number;
        endIdx: number;
        trades: number;
        wins: number;
        losses: number;
        pnl: number;
        startTime: string;
        endTime: string;
        accuracy: number;
    }

    const worst12h: Window[] = [];
    for (let i = 0; i < trades.length; i++) {
        const windowEnd = trades[i].timestamp + 12 * 60 * 60 * 1000;
        let j = i;
        let pnl = 0, wins = 0, losses = 0;
        while (j < trades.length && trades[j].timestamp < windowEnd) {
            pnl += trades[j].pnl;
            if (trades[j].correct) wins++; else losses++;
            j++;
        }
        const totalTrades = wins + losses;
        if (totalTrades < 10) continue;
        worst12h.push({
            startIdx: i, endIdx: j - 1,
            trades: totalTrades, wins, losses, pnl,
            startTime: trades[i].timeET,
            endTime: trades[j - 1].timeET,
            accuracy: wins / totalTrades * 100,
        });
    }

    worst12h.sort((a, b) => a.pnl - b.pnl);
    // Deduplicate overlapping windows (keep worst per day)
    const seen12h = new Set<string>();
    const deduped12h: Window[] = [];
    for (const w of worst12h) {
        const dayKey = trades[w.startIdx].dateET;
        if (seen12h.has(dayKey)) continue;
        seen12h.add(dayKey);
        deduped12h.push(w);
        if (deduped12h.length >= 10) break;
    }

    console.log(
        '#'.padEnd(4) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(4) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(10) + ' | ' +
        'Window'
    );
    console.log('-'.repeat(90));
    for (let i = 0; i < deduped12h.length; i++) {
        const w = deduped12h[i];
        console.log(
            String(i + 1).padEnd(4) + ' | ' +
            String(w.trades).padEnd(7) + ' | ' +
            String(w.wins).padEnd(4) + ' | ' +
            String(w.losses).padEnd(4) + ' | ' +
            (w.accuracy.toFixed(1) + '%').padEnd(7) + ' | ' +
            ('-$' + Math.abs(w.pnl).toFixed(0)).padEnd(10) + ' | ' +
            w.startTime + ' → ' + w.endTime
        );
    }

    // === 3. WORST 24-HOUR WINDOWS ===
    console.log('\n=== TOP 10 WORST 24-HOUR WINDOWS ===\n');

    const worst24h: Window[] = [];
    for (let i = 0; i < trades.length; i++) {
        const windowEnd = trades[i].timestamp + 24 * 60 * 60 * 1000;
        let j = i;
        let pnl = 0, wins = 0, losses = 0;
        while (j < trades.length && trades[j].timestamp < windowEnd) {
            pnl += trades[j].pnl;
            if (trades[j].correct) wins++; else losses++;
            j++;
        }
        const totalTrades = wins + losses;
        if (totalTrades < 20) continue;
        worst24h.push({
            startIdx: i, endIdx: j - 1,
            trades: totalTrades, wins, losses, pnl,
            startTime: trades[i].timeET,
            endTime: trades[j - 1].timeET,
            accuracy: wins / totalTrades * 100,
        });
    }

    worst24h.sort((a, b) => a.pnl - b.pnl);
    const seen24h = new Set<string>();
    const deduped24h: Window[] = [];
    for (const w of worst24h) {
        const dayKey = trades[w.startIdx].dateET;
        if (seen24h.has(dayKey)) continue;
        seen24h.add(dayKey);
        deduped24h.push(w);
        if (deduped24h.length >= 10) break;
    }

    console.log(
        '#'.padEnd(4) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(4) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'.padEnd(10) + ' | ' +
        'Window'
    );
    console.log('-'.repeat(90));
    for (let i = 0; i < deduped24h.length; i++) {
        const w = deduped24h[i];
        console.log(
            String(i + 1).padEnd(4) + ' | ' +
            String(w.trades).padEnd(7) + ' | ' +
            String(w.wins).padEnd(4) + ' | ' +
            String(w.losses).padEnd(4) + ' | ' +
            (w.accuracy.toFixed(1) + '%').padEnd(7) + ' | ' +
            ('-$' + Math.abs(w.pnl).toFixed(0)).padEnd(10) + ' | ' +
            w.startTime + ' → ' + w.endTime
        );
    }

    // === 4. DRAWDOWN ANALYSIS ===
    console.log('\n=== DRAWDOWN ANALYSIS ===\n');

    interface Drawdown {
        peakIdx: number;
        troughIdx: number;
        recoveryIdx: number | null;
        peakPnl: number;
        troughPnl: number;
        drawdown: number;
        tradesToRecover: number | null;
        hoursToRecover: number | null;
        peakTime: string;
        troughTime: string;
    }

    let runningPnl = 0;
    let peakPnl = 0;
    let peakIdx = 0;
    const pnlCurve: { pnl: number; timestamp: number; timeET: string }[] = [];

    for (let i = 0; i < trades.length; i++) {
        runningPnl += trades[i].pnl;
        pnlCurve.push({ pnl: runningPnl, timestamp: trades[i].timestamp, timeET: trades[i].timeET });
    }

    // Find all drawdowns
    const drawdowns: Drawdown[] = [];
    let inDrawdown = false;
    let ddPeakIdx = 0;
    let ddPeakPnl = 0;
    let ddTroughIdx = 0;
    let ddTroughPnl = Infinity;

    peakPnl = -Infinity;
    for (let i = 0; i < pnlCurve.length; i++) {
        if (pnlCurve[i].pnl > peakPnl) {
            // New peak — close previous drawdown if any
            if (inDrawdown && ddTroughPnl < ddPeakPnl) {
                drawdowns.push({
                    peakIdx: ddPeakIdx,
                    troughIdx: ddTroughIdx,
                    recoveryIdx: i,
                    peakPnl: ddPeakPnl,
                    troughPnl: ddTroughPnl,
                    drawdown: ddPeakPnl - ddTroughPnl,
                    tradesToRecover: i - ddTroughIdx,
                    hoursToRecover: (pnlCurve[i].timestamp - pnlCurve[ddTroughIdx].timestamp) / 3600000,
                    peakTime: pnlCurve[ddPeakIdx].timeET,
                    troughTime: pnlCurve[ddTroughIdx].timeET,
                });
            }
            peakPnl = pnlCurve[i].pnl;
            ddPeakIdx = i;
            ddPeakPnl = peakPnl;
            ddTroughPnl = peakPnl;
            inDrawdown = false;
        } else {
            inDrawdown = true;
            if (pnlCurve[i].pnl < ddTroughPnl) {
                ddTroughPnl = pnlCurve[i].pnl;
                ddTroughIdx = i;
            }
        }
    }
    // Close final drawdown if still in one
    if (inDrawdown && ddTroughPnl < ddPeakPnl) {
        drawdowns.push({
            peakIdx: ddPeakIdx,
            troughIdx: ddTroughIdx,
            recoveryIdx: null,
            peakPnl: ddPeakPnl,
            troughPnl: ddTroughPnl,
            drawdown: ddPeakPnl - ddTroughPnl,
            tradesToRecover: null,
            hoursToRecover: null,
            peakTime: pnlCurve[ddPeakIdx].timeET,
            troughTime: pnlCurve[ddTroughIdx].timeET,
        });
    }

    drawdowns.sort((a, b) => b.drawdown - a.drawdown);

    console.log('Top 10 Deepest Drawdowns:\n');
    console.log(
        '#'.padEnd(4) + ' | ' +
        'Drawdown'.padEnd(10) + ' | ' +
        'Trades to Recover'.padEnd(18) + ' | ' +
        'Hours to Recover'.padEnd(17) + ' | ' +
        'Peak'.padEnd(22) + ' | ' +
        'Trough'
    );
    console.log('-'.repeat(105));
    for (let i = 0; i < Math.min(10, drawdowns.length); i++) {
        const d = drawdowns[i];
        console.log(
            String(i + 1).padEnd(4) + ' | ' +
            ('-$' + d.drawdown.toFixed(0)).padEnd(10) + ' | ' +
            (d.tradesToRecover !== null ? String(d.tradesToRecover) : 'ongoing').padEnd(18) + ' | ' +
            (d.hoursToRecover !== null ? d.hoursToRecover.toFixed(1) + 'h' : 'ongoing').padEnd(17) + ' | ' +
            d.peakTime.padEnd(22) + ' | ' +
            d.troughTime
        );
    }

    // === 5. DAILY P&L DISTRIBUTION ===
    console.log('\n=== DAILY P&L DISTRIBUTION ===\n');

    const dailyPnl: Map<string, number> = new Map();
    const dailyTrades: Map<string, { w: number; l: number }> = new Map();
    for (const t of trades) {
        if (!dailyPnl.has(t.dateET)) {
            dailyPnl.set(t.dateET, 0);
            dailyTrades.set(t.dateET, { w: 0, l: 0 });
        }
        dailyPnl.set(t.dateET, dailyPnl.get(t.dateET)! + t.pnl);
        const dt = dailyTrades.get(t.dateET)!;
        if (t.correct) dt.w++; else dt.l++;
    }

    const dailyPnls = [...dailyPnl.values()].sort((a, b) => a - b);
    const totalDays = dailyPnls.length;
    const negativeDays = dailyPnls.filter(p => p < 0).length;

    console.log(`Total trading days: ${totalDays}`);
    console.log(`Negative P&L days: ${negativeDays} (${(negativeDays/totalDays*100).toFixed(1)}%)`);
    console.log(`Worst day: $${dailyPnls[0].toFixed(0)}`);
    console.log(`Best day: +$${dailyPnls[totalDays - 1].toFixed(0)}`);
    console.log(`Median day: +$${dailyPnls[Math.floor(totalDays / 2)].toFixed(0)}`);
    console.log(`Avg day: +$${(dailyPnls.reduce((a, b) => a + b, 0) / totalDays).toFixed(0)}`);

    // Percentiles
    console.log(`\nPercentiles:`);
    for (const pct of [1, 5, 10, 25, 50, 75, 90, 95, 99]) {
        const idx = Math.floor(totalDays * pct / 100);
        const val = dailyPnls[idx];
        console.log(`  ${String(pct).padStart(2)}th: ${val >= 0 ? '+' : ''}$${val.toFixed(0)}`);
    }

    // Worst 10 days
    console.log('\nTop 10 Worst Days:\n');
    console.log('Date'.padEnd(14) + ' | ' + 'W'.padEnd(4) + ' | ' + 'L'.padEnd(4) + ' | ' + 'Acc%'.padEnd(7) + ' | ' + 'P&L');
    console.log('-'.repeat(50));

    const sortedDays = [...dailyPnl.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < Math.min(10, sortedDays.length); i++) {
        const [date, pnl] = sortedDays[i];
        const dt = dailyTrades.get(date)!;
        const total = dt.w + dt.l;
        const acc = (dt.w / total * 100).toFixed(1);
        console.log(
            date.padEnd(14) + ' | ' +
            String(dt.w).padEnd(4) + ' | ' +
            String(dt.l).padEnd(4) + ' | ' +
            (acc + '%').padEnd(7) + ' | ' +
            (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0)
        );
    }

    // === 6. HOW DOES TODAY RANK? ===
    console.log('\n=== HOW DOES TODAY COMPARE? ===\n');

    // Find today
    const todayStr = new Date().toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'numeric', day: 'numeric', year: 'numeric'
    });
    const todayPnl = dailyPnl.get(todayStr);
    if (todayPnl !== undefined) {
        const rank = dailyPnls.filter(p => p < todayPnl).length + 1;
        const percentile = (rank / totalDays * 100).toFixed(1);
        const todayDt = dailyTrades.get(todayStr)!;
        console.log(`Today (${todayStr}): ${todayPnl >= 0 ? '+' : ''}$${todayPnl.toFixed(0)}`);
        console.log(`Record: ${todayDt.w}W-${todayDt.l}L (${(todayDt.w/(todayDt.w+todayDt.l)*100).toFixed(1)}%)`);
        console.log(`Rank: ${rank} out of ${totalDays} days (${percentile}th percentile)`);
    } else {
        console.log(`Today (${todayStr}): Not enough data yet or not found in dataset`);
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
