/**
 * Buy-Winner Time-of-Day & Day-of-Week Analysis
 * Shows accuracy and P&L broken down by hour (ET) and day of week.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-time-analysis.ts [days]
 */

import ccxt from 'ccxt';

async function fetchOneMinCandles(days: number) {
    const exchange = new ccxt.binance();
    const allCandles: any[] = [];
    const endTime = Date.now();
    const startTime = endTime - days * 24 * 60 * 60 * 1000;
    let since = startTime;

    console.log(`Fetching ${days} days of 1-min BTCUSDT candles via CCXT...`);
    while (since < endTime) {
        const candles = await exchange.fetchOHLCV('BTC/USDT', '1m', since, 1000);
        if (candles.length === 0) break;
        allCandles.push(...candles);
        since = candles[candles.length - 1][0] + 60000;
        await new Promise(r => setTimeout(r, 100));
    }
    console.log(`Got ${allCandles.length} 1-min candles\n`);
    return allCandles;
}

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

interface TradeResult {
    hourET: number;
    dayOfWeek: number; // 0=Sun, 6=Sat
    movePct: number;
    correct: boolean;
    pnl: number;
}

async function main() {
    const DAYS = parseInt(process.argv[2] || '180');
    const MIN_MOVE_PCT = 0.05;
    const MAX_WINNER_ASK = 0.80;
    const TRADE_SIZE = 100;

    const candles = await fetchOneMinCandles(DAYS);

    // Build 5-min windows
    const groups: Map<number, any[]> = new Map();
    for (const c of candles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    const trades: TradeResult[] = [];

    for (const [bucket, mins] of groups) {
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

        // Get hour in ET
        const date = new Date(bucket);
        const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
        const hourET = parseInt(etStr);
        const dayStr = date.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
        const dayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
        const dayOfWeek = dayMap[dayStr] ?? 0;

        trades.push({ hourET, dayOfWeek, movePct, correct, pnl });
    }

    console.log(`Total qualifying trades (>5bps, ask<80c): ${trades.length}\n`);

    // === HOUR OF DAY BREAKDOWN ===
    console.log('=== HOUR-OF-DAY BREAKDOWN (ET, >5bps threshold) ===\n');
    console.log(
        'Hour (ET)'.padEnd(12) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(6) + ' | ' +
        'L'.padEnd(5) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'Total P&L'.padEnd(12) + ' | ' +
        'Per Trade'.padEnd(10) + ' | ' +
        'Avg Move'.padEnd(9) + ' | ' +
        'Bar'
    );
    console.log('-'.repeat(110));

    const hourStats: { hour: number; trades: number; wins: number; losses: number; pnl: number; moves: number[] }[] = [];
    for (let h = 0; h < 24; h++) {
        const hTrades = trades.filter(t => t.hourET === h);
        if (hTrades.length === 0) continue;
        const wins = hTrades.filter(t => t.correct).length;
        const losses = hTrades.length - wins;
        const pnl = hTrades.reduce((s, t) => s + t.pnl, 0);
        const moves = hTrades.map(t => t.movePct);
        hourStats.push({ hour: h, trades: hTrades.length, wins, losses, pnl, moves });
    }

    const maxPnl = Math.max(...hourStats.map(h => h.pnl));
    const minPnl = Math.min(...hourStats.map(h => h.pnl));

    for (const h of hourStats) {
        const acc = h.wins / h.trades * 100;
        const perTrade = h.pnl / h.trades;
        const avgMove = h.moves.reduce((a, b) => a + b, 0) / h.moves.length;
        const barLen = h.pnl >= 0
            ? Math.round((h.pnl / maxPnl) * 20)
            : -Math.round((h.pnl / minPnl) * 10);
        const bar = h.pnl >= 0 ? '█'.repeat(barLen) : '░'.repeat(Math.abs(barLen));

        const hourLabel = `${h.hour.toString().padStart(2, '0')}:00`;
        console.log(
            hourLabel.padEnd(12) + ' | ' +
            String(h.trades).padEnd(7) + ' | ' +
            String(h.wins).padEnd(6) + ' | ' +
            String(h.losses).padEnd(5) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((h.pnl >= 0 ? '+' : '') + '$' + h.pnl.toFixed(0)).padEnd(12) + ' | ' +
            ((perTrade >= 0 ? '+' : '') + '$' + perTrade.toFixed(2)).padEnd(10) + ' | ' +
            (avgMove.toFixed(2) + '%').padEnd(9) + ' | ' +
            (h.pnl >= 0 ? '+' : '-') + bar
        );
    }

    // === DAY OF WEEK BREAKDOWN ===
    console.log('\n=== DAY-OF-WEEK BREAKDOWN (>5bps threshold) ===\n');
    console.log(
        'Day'.padEnd(12) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(6) + ' | ' +
        'L'.padEnd(5) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'Total P&L'.padEnd(12) + ' | ' +
        'Per Trade'.padEnd(10) + ' | ' +
        'Avg Move'
    );
    console.log('-'.repeat(80));

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    for (let d = 0; d < 7; d++) {
        const dTrades = trades.filter(t => t.dayOfWeek === d);
        if (dTrades.length === 0) continue;
        const wins = dTrades.filter(t => t.correct).length;
        const losses = dTrades.length - wins;
        const pnl = dTrades.reduce((s, t) => s + t.pnl, 0);
        const avgMove = dTrades.reduce((s, t) => s + t.movePct, 0) / dTrades.length;
        const acc = wins / dTrades.length * 100;
        const perTrade = pnl / dTrades.length;

        console.log(
            dayNames[d].padEnd(12) + ' | ' +
            String(dTrades.length).padEnd(7) + ' | ' +
            String(wins).padEnd(6) + ' | ' +
            String(losses).padEnd(5) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ((pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0)).padEnd(12) + ' | ' +
            ((perTrade >= 0 ? '+' : '') + '$' + perTrade.toFixed(2)).padEnd(10) + ' | ' +
            avgMove.toFixed(2) + '%'
        );
    }

    // === DAY x HOUR HEATMAP (accuracy) ===
    console.log('\n=== DAY x HOUR ACCURACY HEATMAP (>5bps, cells with <20 trades marked *) ===\n');

    // Group into 4-hour blocks for readability
    const hourBlocks = [
        { label: '00-04', min: 0, max: 4 },
        { label: '04-08', min: 4, max: 8 },
        { label: '08-12', min: 8, max: 12 },
        { label: '12-16', min: 12, max: 16 },
        { label: '16-20', min: 16, max: 20 },
        { label: '20-24', min: 20, max: 24 },
    ];

    console.log('         ' + hourBlocks.map(b => b.label.padEnd(10)).join(' '));
    console.log('-'.repeat(75));

    for (let d = 0; d < 7; d++) {
        let row = dayNames[d].padEnd(8) + ' ';
        for (const block of hourBlocks) {
            const blockTrades = trades.filter(
                t => t.dayOfWeek === d && t.hourET >= block.min && t.hourET < block.max
            );
            if (blockTrades.length === 0) {
                row += '  ---     ';
                continue;
            }
            const wins = blockTrades.filter(t => t.correct).length;
            const acc = (wins / blockTrades.length * 100).toFixed(1);
            const marker = blockTrades.length < 20 ? '*' : ' ';
            row += `${acc}%${marker}`.padEnd(10) + ' ';
        }
        console.log(row);
    }

    // === WORST HOURS: which specific hours have accuracy below break-even? ===
    console.log('\n=== DANGER ZONES (Accuracy < 90%, >5bps) ===\n');
    console.log(
        'Day'.padEnd(6) + ' | ' +
        'Hour'.padEnd(8) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'
    );
    console.log('-'.repeat(50));

    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const cell = trades.filter(t => t.dayOfWeek === d && t.hourET === h);
            if (cell.length < 10) continue;
            const wins = cell.filter(t => t.correct).length;
            const acc = wins / cell.length * 100;
            if (acc >= 90) continue;
            const pnl = cell.reduce((s, t) => s + t.pnl, 0);
            console.log(
                dayNames[d].padEnd(6) + ' | ' +
                `${h.toString().padStart(2, '0')}:00`.padEnd(8) + ' | ' +
                String(cell.length).padEnd(7) + ' | ' +
                (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
                (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0)
            );
        }
    }

    // === BEST WINDOWS ===
    console.log('\n=== BEST WINDOWS (Accuracy > 97%, >50 trades, >5bps) ===\n');
    console.log(
        'Day'.padEnd(6) + ' | ' +
        'Hour'.padEnd(8) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'P&L'
    );
    console.log('-'.repeat(50));

    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const cell = trades.filter(t => t.dayOfWeek === d && t.hourET === h);
            if (cell.length < 50) continue;
            const wins = cell.filter(t => t.correct).length;
            const acc = wins / cell.length * 100;
            if (acc <= 97) continue;
            const pnl = cell.reduce((s, t) => s + t.pnl, 0);
            console.log(
                dayNames[d].padEnd(6) + ' | ' +
                `${h.toString().padStart(2, '0')}:00`.padEnd(8) + ' | ' +
                String(cell.length).padEnd(7) + ' | ' +
                (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
                (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(0)
            );
        }
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
