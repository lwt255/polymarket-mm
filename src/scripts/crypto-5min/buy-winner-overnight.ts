/**
 * Quick overnight check: Buy-Winner at T-60s, >5bps filter
 * Just to see what would have happened in the last 12 hours.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-overnight.ts
 */

import ccxt from 'ccxt';

async function main() {
    const exchange = new ccxt.binance();

    // 1:30 AM ET to 1:30 PM ET today (March 8, 2026)
    // ET = UTC-5 (EST)
    const now = Date.now();
    const endTime = now;
    // 12 hours ago
    const hoursBack = 12;
    const startTime = endTime - hoursBack * 60 * 60 * 1000;

    const startDate = new Date(startTime);
    const endDate = new Date(endTime);
    console.log(`Period: ${startDate.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
    console.log(`     to ${endDate.toLocaleString('en-US', { timeZone: 'America/New_York' })} ET`);
    console.log(`(${hoursBack} hours)\n`);

    // Fetch 1-min candles
    console.log('Fetching 1-min BTCUSDT candles...');
    const allCandles: any[] = [];
    let since = startTime;
    while (since < endTime) {
        const candles = await exchange.fetchOHLCV('BTC/USDT', '1m', since, 1000);
        if (candles.length === 0) break;
        allCandles.push(...candles);
        since = candles[candles.length - 1][0] + 60000;
        await new Promise(r => setTimeout(r, 100));
    }
    // Filter to our window
    const filtered = allCandles.filter(c => c[0] >= startTime && c[0] < endTime);
    console.log(`Got ${filtered.length} 1-min candles\n`);

    // Build 5-min windows
    const groups: Map<number, any[]> = new Map();
    for (const c of filtered) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    interface Trade {
        time: string;
        btcOpen: number;
        btcAtT60: number;
        btcClose: number;
        moveBps: number;
        direction: string;
        outcome: string;
        winnerPrice: number;
        fee: number;
        pnl: number;
        correct: boolean;
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

    const MAX_WINNER_ASK = 0.80;
    const TRADE_SIZE = 100;

    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    // Pre-compute all candle data
    interface CandleData {
        bucket: number;
        time: string;
        openPrice: number;
        closePrice: number;
        priceAtMin4: number;
        outcome: 'UP' | 'DOWN';
        movePct: number;
        direction: 'UP' | 'DOWN';
    }

    const candleData: CandleData[] = [];
    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtMin4 = mins[3][4];
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';
        const movePct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        const direction: 'UP' | 'DOWN' = priceAtMin4 >= openPrice ? 'UP' : 'DOWN';

        const time = new Date(bucket).toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit', minute: '2-digit', hour12: true
        });

        candleData.push({ bucket, time, openPrice, closePrice, priceAtMin4, outcome, movePct, direction });
    }

    // Test multiple thresholds
    const thresholds = [0.05, 0.08, 0.10, 0.12, 0.15, 0.20];

    console.log('=== THRESHOLD COMPARISON (Buy Winner @ T-60s, last 12h) ===\n');
    console.log(
        'Threshold'.padEnd(12) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(4) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Acc%'.padEnd(7) + ' | ' +
        'Avg Win'.padEnd(8) + ' | ' +
        'BE Acc'.padEnd(7) + ' | ' +
        'Total P&L'.padEnd(12) + ' | ' +
        'Per Trade'
    );
    console.log('-'.repeat(95));

    for (const threshold of thresholds) {
        let wins = 0, losses = 0, totalPnl = 0;
        const winAmounts: number[] = [];

        for (const c of candleData) {
            if (c.movePct < threshold) continue;
            const winnerPrice = estimateWinnerPrice(c.movePct);
            if (winnerPrice > MAX_WINNER_ASK) continue;

            const fee = takerFee(winnerPrice);
            const cost = winnerPrice + fee;
            const tokens = TRADE_SIZE / cost;
            const correct = c.direction === c.outcome;

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
        if (total === 0) continue;

        const acc = wins / total * 100;
        const avgWin = winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0;
        const beAcc = TRADE_SIZE / (TRADE_SIZE + avgWin) * 100;

        console.log(
            (`>${(threshold * 100).toFixed(0)}bps`).padEnd(12) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            String(wins).padEnd(4) + ' | ' +
            String(losses).padEnd(4) + ' | ' +
            (acc.toFixed(1) + '%').padEnd(7) + ' | ' +
            ('+$' + avgWin.toFixed(0)).padEnd(8) + ' | ' +
            (beAcc.toFixed(0) + '%').padEnd(7) + ' | ' +
            ((totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)).padEnd(12) + ' | ' +
            ((totalPnl / total >= 0 ? '+' : '') + '$' + (totalPnl / total).toFixed(2))
        );
    }

    // Now show the losses at each threshold — which trades got filtered out?
    console.log('\n=== LOSS BREAKDOWN BY MOVE SIZE ===\n');

    const moveBands = [
        { label: '5-8bps', min: 0.05, max: 0.08 },
        { label: '8-10bps', min: 0.08, max: 0.10 },
        { label: '10-12bps', min: 0.10, max: 0.12 },
        { label: '12-15bps', min: 0.12, max: 0.15 },
        { label: '15-20bps', min: 0.15, max: 0.20 },
        { label: '20+bps', min: 0.20, max: 999 },
    ];

    console.log(
        'Band'.padEnd(10) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'W'.padEnd(4) + ' | ' +
        'L'.padEnd(4) + ' | ' +
        'Accuracy'.padEnd(9) + ' | ' +
        'P&L'
    );
    console.log('-'.repeat(55));

    for (const band of moveBands) {
        let wins = 0, losses = 0, totalPnl = 0;
        for (const c of candleData) {
            if (c.movePct < band.min || c.movePct >= band.max) continue;
            const winnerPrice = estimateWinnerPrice(c.movePct);
            if (winnerPrice > MAX_WINNER_ASK) continue;

            const fee = takerFee(winnerPrice);
            const cost = winnerPrice + fee;
            const tokens = TRADE_SIZE / cost;

            if (c.direction === c.outcome) {
                totalPnl += tokens * (1 - cost);
                wins++;
            } else {
                totalPnl -= TRADE_SIZE;
                losses++;
            }
        }
        const total = wins + losses;
        if (total === 0) continue;

        console.log(
            band.label.padEnd(10) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            String(wins).padEnd(4) + ' | ' +
            String(losses).padEnd(4) + ' | ' +
            ((wins / total * 100).toFixed(1) + '%').padEnd(9) + ' | ' +
            (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)
        );
    }

    // BTC context
    if (filtered.length > 0) {
        const btcStart = filtered[0][1];
        const btcEnd = filtered[filtered.length - 1][4];
        const btcChange = ((btcEnd - btcStart) / btcStart * 100).toFixed(2);
        console.log(`\nBTC context: $${btcStart.toFixed(0)} → $${btcEnd.toFixed(0)} (${btcChange}%)`);
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
