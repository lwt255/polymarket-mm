/**
 * Verify: zoom into today's candles from the 180-day dataset
 * to make sure the backtest is seeing the same losses we saw in the overnight script.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-verify.ts
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
    const exchange = new ccxt.binance();

    // Fetch just 2 days of data to keep it fast
    const endTime = Date.now();
    const startTime = endTime - 2 * 24 * 60 * 60 * 1000;
    let since = startTime;
    const allCandles: any[] = [];

    console.log('Fetching last 2 days of 1-min candles...');
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

    // Filter to today: March 8 2026, 00:30 AM ET to 1:30 PM ET
    // That's roughly the same window as our overnight script
    const TRADE_SIZE = 100;
    const MIN_MOVE_PCT = 0.05;

    console.log('=== TODAY\'S TRADES (March 8, ~12:30AM - 1:30PM ET) ===\n');
    console.log(
        'Time (ET)'.padEnd(12) + ' | ' +
        'BTC Open'.padEnd(10) + ' | ' +
        'BTC@T60'.padEnd(10) + ' | ' +
        'BTC Close'.padEnd(10) + ' | ' +
        'Move'.padEnd(7) + ' | ' +
        'Pred'.padEnd(5) + ' | ' +
        'Actual'.padEnd(6) + ' | ' +
        'Result'
    );
    console.log('-'.repeat(85));

    let wins = 0, losses = 0, totalPnl = 0, totalTrades = 0;

    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);
    for (const [bucket, mins] of sortedBuckets) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const date = new Date(bucket);
        const etDate = new Date(date.toLocaleString('en-US', { timeZone: 'America/New_York' }));

        // Only show today's candles from ~12:30 AM to 1:30 PM ET (March 8)
        const etStr = date.toLocaleString('en-US', { timeZone: 'America/New_York' });
        if (!etStr.includes('3/8/2026')) continue;

        const hourET = etDate.getHours();
        if (hourET > 13) continue; // stop at 1:30 PM

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtMin4 = mins[3][4];

        const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
        const movePct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        const direction = priceAtMin4 >= openPrice ? 'UP' : 'DOWN';

        if (movePct < MIN_MOVE_PCT) continue;

        const winnerPrice = estimateWinnerPrice(movePct);
        if (winnerPrice > 0.80) continue;

        const fee = takerFee(winnerPrice);
        const cost = winnerPrice + fee;
        const tokens = TRADE_SIZE / cost;
        const correct = direction === outcome;
        const pnl = correct ? tokens * (1 - cost) : -TRADE_SIZE;

        totalTrades++;
        totalPnl += pnl;
        if (correct) wins++; else losses++;

        const time = date.toLocaleString('en-US', {
            timeZone: 'America/New_York',
            hour: '2-digit', minute: '2-digit', hour12: true
        });

        console.log(
            time.padEnd(12) + ' | ' +
            ('$' + openPrice.toFixed(0)).padEnd(10) + ' | ' +
            ('$' + priceAtMin4.toFixed(0)).padEnd(10) + ' | ' +
            ('$' + closePrice.toFixed(0)).padEnd(10) + ' | ' +
            ((movePct * 100).toFixed(0) + 'bp').padEnd(7) + ' | ' +
            direction.padEnd(5) + ' | ' +
            outcome.padEnd(6) + ' | ' +
            (correct ? 'WIN  +$' + pnl.toFixed(0) : 'LOSS -$100')
        );
    }

    console.log('\n--- Today\'s Summary ---');
    console.log(`Trades: ${totalTrades} | W: ${wins} | L: ${losses} | Acc: ${(wins/totalTrades*100).toFixed(1)}% | P&L: ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(0)}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
