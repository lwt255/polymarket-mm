/**
 * Buy-Winner Backtest: Big Win / Small Loss Structure
 *
 * Instead of splitting and selling the loser (small win, big loss),
 * what if we just BUY the predicted winner token at T-60s?
 *
 * If winner is trading at 60c:
 *   - Right: resolves to $1, profit = 40c per token
 *   - Wrong: resolves to $0, loss = 60c per token
 *   - Break-even: 60% accuracy (not 85%!)
 *
 * The catch: taker fees (~1-2c), and we need the token price data.
 * We simulate token prices from BTC move magnitude.
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-backtest.ts [days]
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

interface FiveMinWindow {
    openPrice: number;
    closePrice: number;
    outcome: 'UP' | 'DOWN';
    priceAtMin4: number; // T-60s
    priceAtMin3: number; // T-120s
    priceAtMin2: number; // T-180s
    moveAtMin4Pct: number; // % move from open at T-60s
    moveAtMin3Pct: number;
    moveAtMin2Pct: number;
}

function buildWindows(candles: any[]): FiveMinWindow[] {
    const groups: Map<number, any[]> = new Map();
    for (const c of candles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    const windows: FiveMinWindow[] = [];
    for (const [, mins] of groups) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';
        const priceAtMin4 = mins[3][4]; // close of minute 4 (T-60s)
        const priceAtMin3 = mins[2][4]; // close of minute 3 (T-120s)
        const priceAtMin2 = mins[1][4]; // close of minute 2 (T-180s)

        windows.push({
            openPrice, closePrice, outcome,
            priceAtMin4, priceAtMin3, priceAtMin2,
            moveAtMin4Pct: Math.abs(priceAtMin4 - openPrice) / openPrice * 100,
            moveAtMin3Pct: Math.abs(priceAtMin3 - openPrice) / openPrice * 100,
            moveAtMin2Pct: Math.abs(priceAtMin2 - openPrice) / openPrice * 100,
        });
    }
    return windows;
}

// Estimate winner token price based on how far BTC has moved
// The further from open, the higher the winner token price
// From our live study: at T-60s with move > 0.10%, loser bid avg ~15c → winner ~85c
// With smaller moves, winner is closer to 50c
function estimateWinnerPrice(movePct: number): number {
    // Based on observed Polymarket pricing:
    // 0.00% move → 50c (coin flip)
    // 0.05% move → ~60c
    // 0.10% move → ~70c (loser at 30c, but best bid is ~15c due to spread)
    // 0.15% move → ~80c
    // 0.20%+ move → ~85-90c
    if (movePct < 0.01) return 0.50;
    if (movePct < 0.03) return 0.55;
    if (movePct < 0.05) return 0.60;
    if (movePct < 0.08) return 0.65;
    if (movePct < 0.10) return 0.70;
    if (movePct < 0.15) return 0.78;
    if (movePct < 0.20) return 0.83;
    return 0.88;
}

// Taker fee: min(p, 1-p) * 0.0222
function takerFee(price: number): number {
    return Math.min(price, 1 - price) * 0.0222;
}

interface Strategy {
    name: string;
    minMovePct: number;
    entryTime: 'min4' | 'min3' | 'min2'; // which minute to check
}

async function main() {
    const DAYS = parseInt(process.argv[2] || '180');
    const candles = await fetchOneMinCandles(DAYS);
    const windows = buildWindows(candles);
    console.log(`5-min windows: ${windows.length}\n`);

    const strategies: Strategy[] = [
        // Buy winner at T-60s with different move filters
        { name: 'Buy winner T-60s, move > 0.03%', minMovePct: 0.03, entryTime: 'min4' },
        { name: 'Buy winner T-60s, move > 0.05%', minMovePct: 0.05, entryTime: 'min4' },
        { name: 'Buy winner T-60s, move > 0.08%', minMovePct: 0.08, entryTime: 'min4' },
        { name: 'Buy winner T-60s, move > 0.10%', minMovePct: 0.10, entryTime: 'min4' },
        { name: 'Buy winner T-60s, move > 0.15%', minMovePct: 0.15, entryTime: 'min4' },
        { name: 'Buy winner T-60s, move > 0.20%', minMovePct: 0.20, entryTime: 'min4' },
        // Buy winner at T-120s
        { name: 'Buy winner T-120s, move > 0.05%', minMovePct: 0.05, entryTime: 'min3' },
        { name: 'Buy winner T-120s, move > 0.10%', minMovePct: 0.10, entryTime: 'min3' },
        { name: 'Buy winner T-120s, move > 0.15%', minMovePct: 0.15, entryTime: 'min3' },
        // Buy winner at T-180s (earliest, cheapest token)
        { name: 'Buy winner T-180s, move > 0.05%', minMovePct: 0.05, entryTime: 'min2' },
        { name: 'Buy winner T-180s, move > 0.10%', minMovePct: 0.10, entryTime: 'min2' },
        { name: 'Buy winner T-180s, move > 0.15%', minMovePct: 0.15, entryTime: 'min2' },
    ];

    console.log('=== BUY-WINNER BACKTEST RESULTS ===\n');
    console.log(
        'Strategy'.padEnd(42) + ' | ' +
        'Acc   | Trades | Win    | Loss   | EV/$100 | Losses to Recover | Daily Est'
    );
    console.log('-'.repeat(130));

    for (const strat of strategies) {
        let correct = 0, total = 0, totalPnl = 0;
        const pnls: number[] = [];

        for (const w of windows) {
            let movePct: number, direction: 'UP' | 'DOWN';

            if (strat.entryTime === 'min4') {
                movePct = w.moveAtMin4Pct;
                direction = w.priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
            } else if (strat.entryTime === 'min3') {
                movePct = w.moveAtMin3Pct;
                direction = w.priceAtMin3 >= w.openPrice ? 'UP' : 'DOWN';
            } else {
                movePct = w.moveAtMin2Pct;
                direction = w.priceAtMin2 >= w.openPrice ? 'UP' : 'DOWN';
            }

            if (movePct < strat.minMovePct) continue;

            const winnerPrice = estimateWinnerPrice(movePct);
            const fee = takerFee(winnerPrice);
            const costPerToken = winnerPrice + fee;
            const tokensPerHundred = 100 / costPerToken; // tokens bought with $100

            total++;
            const isCorrect = direction === w.outcome;

            if (isCorrect) {
                correct++;
                const profit = tokensPerHundred * (1 - costPerToken); // each token pays $1
                totalPnl += profit;
                pnls.push(profit);
            } else {
                const loss = -100; // tokens worth $0
                totalPnl += loss;
                pnls.push(loss);
            }
        }

        if (total < 50) continue;

        const accuracy = correct / total;
        const avgWin = pnls.filter(p => p > 0).reduce((a, b) => a + b, 0) / (correct || 1);
        const avgLoss = total - correct > 0 ? Math.abs(pnls.filter(p => p < 0).reduce((a, b) => a + b, 0) / (total - correct)) : 100;
        const ev = totalPnl / total;
        const winsToRecover = avgLoss / avgWin;
        const tradesPerDay = total / DAYS;
        const dailyEst = ev * tradesPerDay;

        console.log(
            strat.name.padEnd(42) + ' | ' +
            (accuracy * 100).toFixed(1).padStart(4) + '% | ' +
            String(total).padStart(6) + ' | ' +
            ('+$' + avgWin.toFixed(0)).padStart(6) + ' | ' +
            ('-$' + avgLoss.toFixed(0)).padStart(6) + ' | ' +
            ('$' + (ev >= 0 ? '+' : '') + ev.toFixed(2)).padStart(7) + ' | ' +
            winsToRecover.toFixed(1).padStart(17) + ' | ' +
            ('$' + (dailyEst >= 0 ? '+' : '') + dailyEst.toFixed(0)).padStart(9)
        );
    }

    // Comparison with split straddle
    console.log('\n=== COMPARISON: BUY-WINNER vs SPLIT-STRADDLE ===\n');
    console.log('Metric'.padEnd(30) + ' | Split Straddle (T-60s)  | Buy Winner (T-60s, >0.10%)');
    console.log('-'.repeat(85));

    // Run split straddle for comparison
    let ssCorrect = 0, ssTotal = 0;
    for (const w of windows) {
        if (w.moveAtMin4Pct < 0.10) continue;
        ssTotal++;
        const dir = w.priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
        if (dir === w.outcome) ssCorrect++;
    }
    const ssAcc = ssCorrect / ssTotal;
    const ssAvgWin = 15; // 15c loser bid
    const ssAvgLoss = 85;
    const ssEv = ssAcc * ssAvgWin - (1 - ssAcc) * ssAvgLoss;

    // Buy winner
    let bwCorrect = 0, bwTotal = 0, bwPnl = 0;
    const bwWins: number[] = [], bwLosses: number[] = [];
    for (const w of windows) {
        if (w.moveAtMin4Pct < 0.10) continue;
        bwTotal++;
        const dir = w.priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
        const wp = estimateWinnerPrice(w.moveAtMin4Pct);
        const fee = takerFee(wp);
        const cost = wp + fee;
        if (dir === w.outcome) {
            bwCorrect++;
            const win = (100 / cost) * (1 - cost);
            bwWins.push(win);
            bwPnl += win;
        } else {
            bwLosses.push(100);
            bwPnl -= 100;
        }
    }
    const bwAcc = bwCorrect / bwTotal;
    const bwAvgWin = bwWins.reduce((a, b) => a + b, 0) / bwWins.length;
    const bwAvgLoss = 100;
    const bwEv = bwPnl / bwTotal;

    console.log('Win amount (per $100)'.padEnd(30) + ' | +$' + ssAvgWin + '                     | +$' + bwAvgWin.toFixed(0));
    console.log('Loss amount (per $100)'.padEnd(30) + ' | -$' + ssAvgLoss + '                    | -$' + bwAvgLoss);
    console.log('Break-even accuracy'.padEnd(30) + ' | ' + ((1 - ssAvgWin/100) * 100).toFixed(0) + '%                      | ' + (bwAvgLoss / (bwAvgLoss + bwAvgWin) * 100).toFixed(0) + '%');
    console.log('Actual accuracy'.padEnd(30) + ' | ' + (ssAcc * 100).toFixed(1) + '%                    | ' + (bwAcc * 100).toFixed(1) + '%');
    console.log('EV per $100 trade'.padEnd(30) + ' | $' + (ssEv >= 0 ? '+' : '') + ssEv.toFixed(2) + '                   | $' + (bwEv >= 0 ? '+' : '') + bwEv.toFixed(2));
    console.log('Wins to recover 1 loss'.padEnd(30) + ' | ' + (ssAvgLoss / ssAvgWin).toFixed(1) + ' wins                 | ' + (bwAvgLoss / bwAvgWin).toFixed(1) + ' wins');
    console.log('Wins to recover 3 losses'.padEnd(30) + ' | ' + (ssAvgLoss * 3 / ssAvgWin).toFixed(0) + ' wins                  | ' + (bwAvgLoss * 3 / bwAvgWin).toFixed(0) + ' wins');

    // Streak analysis
    console.log('\n=== WORST STREAK ANALYSIS (Buy Winner T-60s, >0.10%) ===\n');
    let maxConsecLosses = 0, currentLosses = 0;
    let maxDrawdown = 0, currentDrawdown = 0;
    let runningPnl = 0;
    let peakPnl = 0;

    for (const w of windows) {
        if (w.moveAtMin4Pct < 0.10) continue;
        const dir = w.priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
        const wp = estimateWinnerPrice(w.moveAtMin4Pct);
        const fee = takerFee(wp);
        const cost = wp + fee;

        if (dir === w.outcome) {
            const win = (100 / cost) * (1 - cost);
            runningPnl += win;
            currentLosses = 0;
        } else {
            runningPnl -= 100;
            currentLosses++;
            maxConsecLosses = Math.max(maxConsecLosses, currentLosses);
        }

        peakPnl = Math.max(peakPnl, runningPnl);
        currentDrawdown = peakPnl - runningPnl;
        maxDrawdown = Math.max(maxDrawdown, currentDrawdown);
    }

    console.log('Max consecutive losses: ' + maxConsecLosses);
    console.log('Max drawdown: $' + maxDrawdown.toFixed(0));
    console.log('Total P&L over ' + DAYS + ' days: $' + (runningPnl >= 0 ? '+' : '') + runningPnl.toFixed(0));
    console.log('Per day: $' + (runningPnl / DAYS >= 0 ? '+' : '') + (runningPnl / DAYS).toFixed(0));
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
