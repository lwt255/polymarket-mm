/**
 * Underdog Edge Analysis
 *
 * Question: Is the market overpricing certainty?
 * If the winner costs 95c but only wins 85% of the time,
 * then buying the LOSER at 5c is +EV.
 *
 * Tests:
 * 1. What does the market IMPLY the accuracy is (from token prices)?
 * 2. What is the ACTUAL accuracy (from BTC data)?
 * 3. Is there a gap, and which side benefits?
 * 4. What if we buy the loser at various checkpoints?
 *
 * Run: npx tsx src/scripts/crypto-5min/underdog-edge.ts [days]
 */

import ccxt from 'ccxt';

async function main() {
    const DAYS = parseInt(process.argv[2] || '60');
    const TRADE_SIZE = 100;

    const exchange = new ccxt.binance();
    const allCandles: any[] = [];
    const endTime = Date.now();
    const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;
    let since = startTime;

    console.log(`Fetching ${DAYS} days of 1-min BTCUSDT candles (new regime)...`);
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

    // Estimate what the MARKET would price the winner/loser at
    // Based on our observed pricing model
    function marketWinnerPrice(movePct: number): number {
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

    const sortedBuckets = [...groups.entries()].sort((a, b) => a[0] - b[0]);

    // === 1. MARKET IMPLIED vs ACTUAL ACCURACY (by move band) ===
    console.log('=== MARKET IMPLIED vs ACTUAL ACCURACY (5-min, last 60 days) ===\n');
    console.log('The market prices the winner token based on move size.');
    console.log('If the market OVERESTIMATES accuracy, the loser is underpriced.\n');

    const bands = [
        { label: '3-5bps', min: 0.03, max: 0.05, impliedAcc: 0.575 },  // winner ~57.5c avg
        { label: '5-8bps', min: 0.05, max: 0.08, impliedAcc: 0.625 },  // winner ~62.5c
        { label: '8-10bps', min: 0.08, max: 0.10, impliedAcc: 0.675 }, // winner ~67.5c
        { label: '10-15bps', min: 0.10, max: 0.15, impliedAcc: 0.74 }, // winner ~74c
        { label: '15-20bps', min: 0.15, max: 0.20, impliedAcc: 0.805 }, // winner ~80.5c
        { label: '20+bps', min: 0.20, max: 999, impliedAcc: 0.88 },    // winner ~88c
    ];

    console.log(
        'Band'.padEnd(12) + ' | ' +
        'Winner Price'.padEnd(13) + ' | ' +
        'Implied Acc'.padEnd(12) + ' | ' +
        'Actual Acc'.padEnd(11) + ' | ' +
        'Gap'.padEnd(8) + ' | ' +
        'Winner EV'.padEnd(10) + ' | ' +
        'Loser EV'.padEnd(10) + ' | ' +
        'Edge?'
    );
    console.log('-'.repeat(100));

    for (const band of bands) {
        let correct = 0, total = 0;
        let winnerPnl = 0, loserPnl = 0;

        for (const [, mins] of sortedBuckets) {
            if (mins.length < 5) continue;
            mins.sort((a: any, b: any) => a[0] - b[0]);

            const openPrice = mins[0][1];
            const closePrice = mins[4][4];
            const priceAtT60 = mins[3][4];
            const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;

            if (movePct < band.min || movePct >= band.max) continue;

            const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';
            const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
            const isCorrect = direction === outcome;

            total++;
            if (isCorrect) correct++;

            const winnerPrice = marketWinnerPrice(movePct);
            const loserPrice = 1 - winnerPrice;
            const winnerFee = takerFee(winnerPrice);
            const loserFee = takerFee(loserPrice);

            // Buy winner: pay winnerPrice + fee. Win = $1, Lose = $0
            const winnerCost = winnerPrice + winnerFee;
            if (isCorrect) {
                winnerPnl += (1 - winnerCost) * (TRADE_SIZE / winnerCost);
            } else {
                winnerPnl -= TRADE_SIZE;
            }

            // Buy loser: pay loserPrice + fee. Win (reversal) = $1, Lose = $0
            const loserCost = loserPrice + loserFee;
            if (!isCorrect) {
                // Reversal! Loser wins!
                loserPnl += (1 - loserCost) * (TRADE_SIZE / loserCost);
            } else {
                loserPnl -= TRADE_SIZE;
            }
        }

        if (total < 20) continue;

        const actualAcc = correct / total;
        const gap = actualAcc - band.impliedAcc;
        const winnerEV = winnerPnl / total;
        const loserEV = loserPnl / total;

        // Edge: if actual acc < implied acc, loser is underpriced
        const edge = gap < -0.02 ? 'LOSER ✓' : gap > 0.02 ? 'WINNER ✓' : 'fair';

        console.log(
            band.label.padEnd(12) + ' | ' +
            ((marketWinnerPrice((band.min + band.max) / 2) * 100).toFixed(0) + 'c').padEnd(13) + ' | ' +
            ((band.impliedAcc * 100).toFixed(1) + '%').padEnd(12) + ' | ' +
            ((actualAcc * 100).toFixed(1) + '%').padEnd(11) + ' | ' +
            ((gap >= 0 ? '+' : '') + (gap * 100).toFixed(1) + 'pp').padEnd(8) + ' | ' +
            ((winnerEV >= 0 ? '+' : '') + '$' + winnerEV.toFixed(2)).padEnd(10) + ' | ' +
            ((loserEV >= 0 ? '+' : '') + '$' + loserEV.toFixed(2)).padEnd(10) + ' | ' +
            edge
        );
    }

    // === 2. BUY-LOSER STRATEGY AT DIFFERENT PRICE POINTS ===
    console.log('\n=== BUY-LOSER STRATEGY: What if we buy the loser at specific prices? ===\n');
    console.log('When loser is cheap (5-20c), you risk little. When it reverses, you win big.\n');

    const loserBands = [
        { label: 'Loser at 5-10c', minLoser: 0.05, maxLoser: 0.10 },
        { label: 'Loser at 10-15c', minLoser: 0.10, maxLoser: 0.15 },
        { label: 'Loser at 15-20c', minLoser: 0.15, maxLoser: 0.20 },
        { label: 'Loser at 20-25c', minLoser: 0.20, maxLoser: 0.25 },
        { label: 'Loser at 25-30c', minLoser: 0.25, maxLoser: 0.30 },
        { label: 'Loser at 30-35c', minLoser: 0.30, maxLoser: 0.35 },
        { label: 'Loser at 35-40c', minLoser: 0.35, maxLoser: 0.40 },
    ];

    console.log(
        'Loser Price'.padEnd(18) + ' | ' +
        'Trades'.padEnd(7) + ' | ' +
        'Reversals'.padEnd(10) + ' | ' +
        'Rev Rate'.padEnd(9) + ' | ' +
        'Avg Win'.padEnd(9) + ' | ' +
        'Avg Loss'.padEnd(9) + ' | ' +
        'BE Rate'.padEnd(8) + ' | ' +
        'EV/Trade'.padEnd(10) + ' | ' +
        'Total P&L'
    );
    console.log('-'.repeat(110));

    for (const lb of loserBands) {
        let wins = 0, losses = 0, totalPnl = 0;
        const winAmounts: number[] = [];
        const lossAmounts: number[] = [];

        for (const [, mins] of sortedBuckets) {
            if (mins.length < 5) continue;
            mins.sort((a: any, b: any) => a[0] - b[0]);

            const openPrice = mins[0][1];
            const closePrice = mins[4][4];
            const priceAtT60 = mins[3][4];
            const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;

            const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';
            const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';

            const winnerPrice = marketWinnerPrice(movePct);
            const loserPrice = 1 - winnerPrice;

            if (loserPrice < lb.minLoser || loserPrice >= lb.maxLoser) continue;

            const fee = takerFee(loserPrice);
            const cost = loserPrice + fee;
            const tokens = TRADE_SIZE / cost;

            if (direction !== outcome) {
                // REVERSAL — loser wins!
                const profit = tokens * (1 - cost);
                totalPnl += profit;
                winAmounts.push(profit);
                wins++;
            } else {
                // No reversal — loser goes to $0
                totalPnl -= TRADE_SIZE;
                lossAmounts.push(TRADE_SIZE);
                losses++;
            }
        }

        const total = wins + losses;
        if (total < 20) continue;

        const revRate = wins / total * 100;
        const avgWin = winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0;
        const avgLoss = TRADE_SIZE;
        const beRate = avgLoss / (avgLoss + avgWin) * 100;
        const ev = totalPnl / total;

        console.log(
            lb.label.padEnd(18) + ' | ' +
            String(total).padEnd(7) + ' | ' +
            String(wins).padEnd(10) + ' | ' +
            (revRate.toFixed(1) + '%').padEnd(9) + ' | ' +
            ('+$' + avgWin.toFixed(0)).padEnd(9) + ' | ' +
            ('-$' + avgLoss.toFixed(0)).padEnd(9) + ' | ' +
            (beRate.toFixed(0) + '%').padEnd(8) + ' | ' +
            ((ev >= 0 ? '+' : '') + '$' + ev.toFixed(2)).padEnd(10) + ' | ' +
            (totalPnl >= 0 ? '+' : '') + '$' + totalPnl.toFixed(0)
        );
    }

    // === 3. THE KEY QUESTION: In the new regime, is the market slow to reprice? ===
    console.log('\n=== NEW REGIME vs OLD: Is the market slow to adjust? ===\n');
    console.log('If reversal rate doubled but market still prices like old regime,');
    console.log('the loser is systematically underpriced.\n');

    // Compare Feb-Mar (new regime) vs Sep-Nov (old regime)
    const periods = [
        { label: 'Old regime (Sep-Nov 2025)', startMonth: 9, startYear: 2025, endMonth: 11, endYear: 2025 },
        { label: 'New regime (Feb-Mar 2026)', startMonth: 2, startYear: 2026, endMonth: 3, endYear: 2026 },
    ];

    // We need to check using timestamps
    for (const period of periods) {
        console.log(`--- ${period.label} ---`);

        let correct = 0, total = 0;
        let loserPnl5_15 = 0, loserTrades5_15 = 0, loserWins5_15 = 0;

        for (const [bucket, mins] of sortedBuckets) {
            if (mins.length < 5) continue;
            const date = new Date(bucket);
            const month = date.getMonth() + 1;
            const year = date.getFullYear();

            let inPeriod = false;
            if (period.startYear === period.endYear) {
                inPeriod = year === period.startYear && month >= period.startMonth && month <= period.endMonth;
            } else {
                inPeriod = (year === period.startYear && month >= period.startMonth) ||
                           (year === period.endYear && month <= period.endMonth);
            }
            if (!inPeriod) continue;

            mins.sort((a: any, b: any) => a[0] - b[0]);
            const openPrice = mins[0][1];
            const closePrice = mins[4][4];
            const priceAtT60 = mins[3][4];
            const movePct = Math.abs(priceAtT60 - openPrice) / openPrice * 100;
            if (movePct < 0.05) continue;

            const direction = priceAtT60 >= openPrice ? 'UP' : 'DOWN';
            const outcome = closePrice >= openPrice ? 'UP' : 'DOWN';
            const isCorrect = direction === outcome;

            total++;
            if (isCorrect) correct++;

            // Buy loser when it's 5-15c (big moves, loser is cheap)
            const winnerPrice = marketWinnerPrice(movePct);
            const loserPrice = 1 - winnerPrice;
            if (loserPrice >= 0.05 && loserPrice <= 0.22) {
                const fee = takerFee(loserPrice);
                const cost = loserPrice + fee;
                const tokens = TRADE_SIZE / cost;
                loserTrades5_15++;
                if (!isCorrect) {
                    loserPnl5_15 += tokens * (1 - cost);
                    loserWins5_15++;
                } else {
                    loserPnl5_15 -= TRADE_SIZE;
                }
            }
        }

        const actualAcc = total > 0 ? (correct / total * 100).toFixed(1) : 'N/A';
        const revRate = total > 0 ? ((total - correct) / total * 100).toFixed(1) : 'N/A';
        console.log(`  Momentum accuracy (>5bps): ${actualAcc}% | Reversal rate: ${revRate}%`);
        if (loserTrades5_15 > 0) {
            console.log(`  Buy-loser (5-22c): ${loserWins5_15}/${loserTrades5_15} wins (${(loserWins5_15/loserTrades5_15*100).toFixed(1)}%) | P&L: ${loserPnl5_15 >= 0 ? '+' : ''}$${loserPnl5_15.toFixed(0)} | EV: ${(loserPnl5_15/loserTrades5_15).toFixed(2)}/trade`);
        }
        console.log();
    }

    // === 4. THE REAL TEST: What does the loser ACTUALLY cost on Polymarket? ===
    console.log('=== CRITICAL QUESTION ===\n');
    console.log('Our price model ESTIMATES loser prices based on BTC move size.');
    console.log('But the REAL question is: has the Polymarket MM adjusted loser prices');
    console.log('to reflect the higher reversal rate? If yes, the loser is now 20-25c');
    console.log('instead of 10-15c, and the edge disappears.');
    console.log();
    console.log('The 15-min live study will answer this with REAL order book data.');
    console.log('So far from 28 candles: avg loser bid at T-300s = 10c, T-60s = 4c');
    console.log('→ The MM may NOT be adjusting fast enough.\n');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
