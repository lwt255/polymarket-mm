/**
 * Compare accuracy at different entry times (T-240s through T-60s)
 *
 * Run: npx tsx src/scripts/crypto-5min/entry-time-backtest.ts
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

async function main() {
    const DAYS = 180;
    const candles = await fetchOneMinCandles(DAYS);

    const groups: Map<number, any[]> = new Map();
    for (const c of candles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    const thresholds = [0.03, 0.05, 0.08, 0.10, 0.15, 0.20];

    // Entry points: check price at close of each minute
    const entries = [
        { name: 'T-240s (min1)', idx: 0 },
        { name: 'T-180s (min2)', idx: 1 },
        { name: 'T-120s (min3)', idx: 2 },
        { name: 'T-60s  (min4)', idx: 3 },
    ];

    console.log('=== ACCURACY BY ENTRY TIME AND MOVE FILTER (180 days) ===\n');
    console.log('Entry Point'.padEnd(18) + ' | Filter  | Trades | Correct | Accuracy | Trades/day');
    console.log('-'.repeat(78));

    for (const entry of entries) {
        for (const thresh of thresholds) {
            let total = 0, correct = 0;

            for (const [, mins] of groups) {
                if (mins.length < 5) continue;
                mins.sort((a: any, b: any) => a[0] - b[0]);

                const openPrice = mins[0][1];
                const closePrice = mins[4][4];
                const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';

                const checkPrice = mins[entry.idx][4]; // close of that minute
                const movePct = Math.abs(checkPrice - openPrice) / openPrice * 100;
                if (movePct < thresh) continue;

                const prediction = checkPrice >= openPrice ? 'UP' : 'DOWN';
                total++;
                if (prediction === outcome) correct++;
            }

            if (total < 50) continue;
            const acc = correct / total;
            console.log(
                entry.name.padEnd(18) + ' | ' +
                ('>' + (thresh * 100).toFixed(0) + 'bps').padStart(7) + ' | ' +
                String(total).padStart(6) + ' | ' +
                String(correct).padStart(7) + ' | ' +
                (acc * 100).toFixed(1).padStart(7) + '% | ' +
                (total / DAYS).toFixed(1).padStart(10)
            );
        }
        console.log('-'.repeat(78));
    }

    // Head-to-head at key thresholds
    console.log('\n=== HEAD-TO-HEAD COMPARISON ===\n');

    for (const thresh of [0.03, 0.05, 0.10]) {
        console.log(`Filter: >${(thresh * 100).toFixed(0)}bps`);
        for (const entry of entries) {
            let total = 0, correct = 0;
            for (const [, mins] of groups) {
                if (mins.length < 5) continue;
                mins.sort((a: any, b: any) => a[0] - b[0]);
                const openPrice = mins[0][1];
                const closePrice = mins[4][4];
                const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
                const checkPrice = mins[entry.idx][4];
                const movePct = Math.abs(checkPrice - openPrice) / openPrice * 100;
                if (movePct < thresh) continue;
                total++;
                if ((checkPrice >= openPrice ? 'UP' : 'DOWN') === outcome) correct++;
            }
            console.log(`  ${entry.name}: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}% (${(total / DAYS).toFixed(0)}/day)`);
        }
        console.log();
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
