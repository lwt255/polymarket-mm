/**
 * Historical Backtest: CL direction accuracy at various timepoints
 *
 * Uses Binance 1-second kline data to simulate Polymarket 5-min candles.
 * For each 5-min window, checks: was BTC above or below the open price
 * at T-180s, T-150s, T-120s, T-90s, T-60s, T-40s, T-30s, T-20s, T-10s?
 * Then checks actual close to determine accuracy.
 *
 * This gives us thousands of data points instead of our 100 live candles.
 *
 * Run: npx tsx src/scripts/crypto-5min/historical-accuracy-backtest.ts [days]
 */

const BINANCE_API = 'https://api.binance.com/api/v3/klines';

interface Candle {
    openTime: number;
    open: number;
    high: number;
    low: number;
    close: number;
    closeTime: number;
}

async function fetchKlines(startTime: number, endTime: number): Promise<Candle[]> {
    // Fetch 1-minute klines (max 1000 per request)
    const allCandles: Candle[] = [];
    let cursor = startTime;

    while (cursor < endTime) {
        const url = `${BINANCE_API}?symbol=BTCUSDT&interval=1m&startTime=${cursor}&endTime=${endTime}&limit=1000`;
        const resp = await fetch(url);
        if (!resp.ok) {
            console.log('Binance error:', resp.status);
            break;
        }
        const data = await resp.json() as any[];
        if (data.length === 0) break;

        for (const k of data) {
            allCandles.push({
                openTime: k[0],
                open: parseFloat(k[1]),
                high: parseFloat(k[2]),
                low: parseFloat(k[3]),
                close: parseFloat(k[4]),
                closeTime: k[6],
            });
        }

        cursor = data[data.length - 1][6] + 1; // closeTime + 1ms

        // Rate limit
        await new Promise(r => setTimeout(r, 200));
    }

    return allCandles;
}

function findPriceAt(candles: Candle[], targetMs: number): number | null {
    // Find the 1-min candle that contains this timestamp
    for (const c of candles) {
        if (targetMs >= c.openTime && targetMs <= c.closeTime) {
            // Interpolate: use close as best estimate for price at that time
            return c.close;
        }
    }
    return null;
}

async function main() {
    const DAYS = parseInt(process.argv[2] || '30');
    console.log(`=== Historical Accuracy Backtest: ${DAYS} days ===`);
    console.log(`Using Binance BTCUSDT 1-minute candles\n`);

    const endTime = Date.now();
    const startTime = endTime - DAYS * 24 * 60 * 60 * 1000;

    console.log(`Fetching ${DAYS} days of 1-min data...`);
    const candles = await fetchKlines(startTime, endTime);
    console.log(`Got ${candles.length} 1-min candles (${(candles.length / 60 / 24).toFixed(1)} days)\n`);

    if (candles.length < 300) {
        console.log('Not enough data');
        return;
    }

    // Simulate 5-minute Polymarket candles
    // Each candle: open at round 5-min mark, close 300s later
    const checkpoints = [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10];

    interface Result {
        secondsBefore: number;
        correct: number;
        total: number;
        // With simulated bid filter: if price is close to open at checkpoint, it's "uncertain"
        filteredCorrect: number;
        filteredTotal: number;
    }

    const results: Map<number, Result> = new Map();
    for (const cp of checkpoints) {
        results.set(cp, { secondsBefore: cp, correct: 0, total: 0, filteredCorrect: 0, filteredTotal: 0 });
    }

    // Also track consistency
    let totalCandles = 0;
    let consistent60to20 = 0, consistent60to20_correct = 0;
    let flipped60to20 = 0, flipped60to20_correct = 0;
    let consistent90to20 = 0, consistent90to20_correct = 0;
    let flipped90to20 = 0, flipped90to20_correct = 0;
    let consistent120to20 = 0, consistent120to20_correct = 0;
    let consistent180to20 = 0, consistent180to20_correct = 0;

    // Build a map of timestamp -> price for fast lookup
    const priceMap: Map<number, number> = new Map();
    for (const c of candles) {
        // Store close price keyed by minute start
        priceMap.set(c.openTime, c.close);
    }

    // Get price closest to a timestamp (within 1 minute)
    function getPrice(targetMs: number): number | null {
        // Round down to nearest minute
        const minute = Math.floor(targetMs / 60000) * 60000;
        return priceMap.get(minute) || null;
    }

    // Iterate through 5-min windows
    const firstCandle = Math.ceil(candles[0].openTime / 300000) * 300000; // Round up to 5-min
    const lastCandle = Math.floor(candles[candles.length - 1].closeTime / 300000) * 300000;

    for (let candleOpen = firstCandle; candleOpen < lastCandle; candleOpen += 300000) {
        const candleClose = candleOpen + 300000;

        // Get open price (price at candle start)
        const openPrice = getPrice(candleOpen);
        // Get close price (price at candle end)
        const closePrice = getPrice(candleClose);

        if (!openPrice || !closePrice) continue;

        const actualOutcome = closePrice >= openPrice ? 'UP' : 'DOWN';
        totalCandles++;

        // Check each checkpoint
        const directions: Map<number, 'UP' | 'DOWN'> = new Map();

        for (const cp of checkpoints) {
            const checkTime = candleClose - cp * 1000; // T-Xs before end
            const price = getPrice(checkTime);
            if (!price) continue;

            const predicted = price >= openPrice ? 'UP' : 'DOWN';
            directions.set(cp, predicted);
            const isCorrect = predicted === actualOutcome;

            const r = results.get(cp)!;
            r.total++;
            if (isCorrect) r.correct++;

            // Simulated "≤30c filter": skip when price is very close to open
            // In real market, close-to-open = loser bid > 30c (uncertain)
            // Approximate: if |price - open| > threshold, it "passes" the filter
            const movePct = Math.abs(price - openPrice) / openPrice * 100;
            if (movePct > 0.01) { // > 0.01% move = reasonably directional
                r.filteredTotal++;
                if (isCorrect) r.filteredCorrect++;
            }
        }

        // Consistency checks
        const d180 = directions.get(180);
        const d120 = directions.get(120);
        const d90 = directions.get(90);
        const d60 = directions.get(60);
        const d30 = directions.get(30);
        const d20 = directions.get(20);

        if (d60 && d30 && d20) {
            if (d60 === d30 && d30 === d20) {
                consistent60to20++;
                if (d20 === actualOutcome) consistent60to20_correct++;
            } else {
                flipped60to20++;
                if (d20 === actualOutcome) flipped60to20_correct++;
            }
        }

        if (d90 && d60 && d30 && d20) {
            if (d90 === d60 && d60 === d30 && d30 === d20) {
                consistent90to20++;
                if (d20 === actualOutcome) consistent90to20_correct++;
            } else {
                flipped90to20++;
                if (d20 === actualOutcome) flipped90to20_correct++;
            }
        }

        if (d120 && d90 && d60 && d30 && d20) {
            if (d120 === d90 && d90 === d60 && d60 === d30 && d30 === d20) {
                consistent120to20++;
                if (d20 === actualOutcome) consistent120to20_correct++;
            }
        }

        if (d180 && d120 && d90 && d60 && d30 && d20) {
            if (d180 === d120 && d120 === d90 && d90 === d60 && d60 === d30 && d30 === d20) {
                consistent180to20++;
                if (d20 === actualOutcome) consistent180to20_correct++;
            }
        }
    }

    // Print results
    console.log(`Total 5-min candles simulated: ${totalCandles}\n`);

    console.log('--- Raw Accuracy by Checkpoint ---');
    console.log('Time  | Correct | Total  | Accuracy | Filtered Acc | Filtered n');
    console.log('-'.repeat(70));
    for (const cp of checkpoints) {
        const r = results.get(cp)!;
        if (r.total === 0) continue;
        console.log(
            String(cp).padStart(4) + 's | ' +
            String(r.correct).padStart(7) + ' | ' +
            String(r.total).padStart(6) + ' | ' +
            (r.correct / r.total * 100).toFixed(1).padStart(7) + '% | ' +
            (r.filteredTotal > 0 ? (r.filteredCorrect / r.filteredTotal * 100).toFixed(1) + '%' : 'N/A').padStart(11) + ' | ' +
            String(r.filteredTotal).padStart(9)
        );
    }

    console.log('\n--- Consistency Analysis ---');
    console.log('T-60→T-20 consistent:  ' + consistent60to20_correct + '/' + consistent60to20 + ' (' + (consistent60to20 > 0 ? (consistent60to20_correct/consistent60to20*100).toFixed(1) : 'N/A') + '%)');
    console.log('T-60→T-20 flipped:     ' + flipped60to20_correct + '/' + flipped60to20 + ' (' + (flipped60to20 > 0 ? (flipped60to20_correct/flipped60to20*100).toFixed(1) : 'N/A') + '%)');
    console.log('T-90→T-20 consistent:  ' + consistent90to20_correct + '/' + consistent90to20 + ' (' + (consistent90to20 > 0 ? (consistent90to20_correct/consistent90to20*100).toFixed(1) : 'N/A') + '%)');
    console.log('T-90→T-20 flipped:     ' + flipped90to20_correct + '/' + flipped90to20 + ' (' + (flipped90to20 > 0 ? (flipped90to20_correct/flipped90to20*100).toFixed(1) : 'N/A') + '%)');
    console.log('T-120→T-20 consistent: ' + consistent120to20_correct + '/' + consistent120to20);
    console.log('T-180→T-20 consistent: ' + consistent180to20_correct + '/' + consistent180to20);

    // EV modeling
    console.log('\n--- EV Model (per $100 split, using live study bid data) ---');
    // Use avg loser bids from our live study at each checkpoint
    const avgBids: Record<number, number> = {
        180: 0.27, 150: 0.18, 120: 0.175, 90: 0.153,
        60: 0.148, 50: 0.114, 40: 0.116, 30: 0.089, 20: 0.082, 15: 0.067, 10: 0.05
    };

    for (const cp of checkpoints) {
        const r = results.get(cp)!;
        if (r.filteredTotal < 10) continue;
        const accuracy = r.filteredCorrect / r.filteredTotal;
        const bid = avgBids[cp] || 0.10;
        const winRev = bid * 100;
        const lossAmt = (1 - bid) * 100;
        const ev = accuracy * winRev - (1 - accuracy) * lossAmt;

        console.log(
            '  T-' + String(cp).padStart(3) + 's: ' +
            'Acc ' + (accuracy * 100).toFixed(1) + '% | ' +
            'Bid ~' + (bid * 100).toFixed(0) + 'c | ' +
            'Win: +$' + winRev.toFixed(2) + ' | Loss: -$' + lossAmt.toFixed(2) + ' | ' +
            'EV: $' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '/trade | ' +
            'n=' + r.filteredTotal
        );
    }

    console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
