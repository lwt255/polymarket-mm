/**
 * 1-Minute Pattern Backtest
 *
 * Uses CCXT to pull 1-min BTC candles, groups them into 5-min Polymarket windows,
 * and tests various signals/patterns for predicting the 5-min close.
 *
 * Signals tested:
 *   1. Simple direction at various timepoints (baseline)
 *   2. Momentum: rate of price change in last N minutes
 *   3. Consecutive candles: if last 2-3 1-min candles agree on direction
 *   4. Volume spike: does high volume in a 1-min candle predict continuation?
 *   5. Candle body size: big move in one 1-min candle = continuation?
 *   6. First 3 min trend → last 2 min prediction
 *   7. Reversal patterns: up-down or down-up in consecutive minutes
 *   8. Combined signals: momentum + direction + consistency
 *
 * Run: npx tsx src/scripts/crypto-5min/one-minute-pattern-backtest.ts [days]
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
        await new Promise(r => setTimeout(r, 100)); // rate limit
    }

    console.log(`Got ${allCandles.length} 1-min candles\n`);
    return allCandles; // [timestamp, open, high, low, close, volume]
}

interface FiveMinWindow {
    openTime: number;
    openPrice: number;
    closePrice: number;
    outcome: 'UP' | 'DOWN';
    minutes: {
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        direction: 'UP' | 'DOWN';
        bodySize: number; // |close - open|
        range: number; // high - low
    }[];
}

function groupIntoFiveMin(candles: any[]): FiveMinWindow[] {
    // Group by 5-min boundaries (matching Polymarket's schedule)
    const groups: Map<number, any[]> = new Map();

    for (const c of candles) {
        const fiveMinBucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(fiveMinBucket)) groups.set(fiveMinBucket, []);
        groups.get(fiveMinBucket)!.push(c);
    }

    const windows: FiveMinWindow[] = [];
    for (const [openTime, mins] of groups) {
        if (mins.length < 5) continue; // need all 5 minutes

        // Sort by timestamp
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1]; // first candle open
        const closePrice = mins[mins.length - 1][4]; // last candle close
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';

        const minutes = mins.map((m: any) => ({
            open: m[1],
            high: m[2],
            low: m[3],
            close: m[4],
            volume: m[5],
            direction: (m[4] >= m[1] ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
            bodySize: Math.abs(m[4] - m[1]),
            range: m[2] - m[3],
        }));

        windows.push({ openTime, openPrice, closePrice, outcome, minutes });
    }

    return windows.sort((a, b) => a.openTime - b.openTime);
}

interface Signal {
    name: string;
    predict: (w: FiveMinWindow) => 'UP' | 'DOWN' | 'SKIP';
}

function runSignal(windows: FiveMinWindow[], signal: Signal) {
    let correct = 0, total = 0, skipped = 0;

    for (const w of windows) {
        const prediction = signal.predict(w);
        if (prediction === 'SKIP') { skipped++; continue; }
        total++;
        if (prediction === w.outcome) correct++;
    }

    return { correct, total, skipped, accuracy: total > 0 ? correct / total : 0 };
}

async function main() {
    const DAYS = parseInt(process.argv[2] || '60');
    const candles = await fetchOneMinCandles(DAYS);
    const windows = groupIntoFiveMin(candles);
    console.log(`5-min windows: ${windows.length}\n`);

    const signals: Signal[] = [
        // === BASELINE: Simple direction at timepoints ===
        {
            name: 'Direction at min 3 (T-120s)',
            predict: (w) => {
                const priceAtMin3 = w.minutes[2]?.close;
                if (!priceAtMin3) return 'SKIP';
                return priceAtMin3 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },
        {
            name: 'Direction at min 4 (T-60s)',
            predict: (w) => {
                const priceAtMin4 = w.minutes[3]?.close;
                if (!priceAtMin4) return 'SKIP';
                return priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },
        {
            name: 'Direction at min 4.33 (T-40s)',
            predict: (w) => {
                // Best we can do with 1-min data: same as min 4
                const priceAtMin4 = w.minutes[3]?.close;
                if (!priceAtMin4) return 'SKIP';
                return priceAtMin4 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },

        // === MOMENTUM: Rate of change ===
        {
            name: 'Momentum: min3→min4 same as open→min4',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const min3 = w.minutes[2].close;
                const min4 = w.minutes[3].close;
                const overallDir = min4 >= w.openPrice ? 'UP' : 'DOWN';
                const recentDir = min4 >= min3 ? 'UP' : 'DOWN';
                // Only trade if recent momentum agrees with overall direction
                if (overallDir !== recentDir) return 'SKIP';
                return overallDir;
            }
        },
        {
            name: 'Momentum: min2→min3→min4 all same direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m2 = w.minutes[1].close;
                const m3 = w.minutes[2].close;
                const m4 = w.minutes[3].close;
                const d23 = m3 >= m2 ? 'UP' : 'DOWN';
                const d34 = m4 >= m3 ? 'UP' : 'DOWN';
                if (d23 !== d34) return 'SKIP';
                return d23;
            }
        },
        {
            name: 'Strong momentum: 3 consecutive 1-min candles same direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d1 = w.minutes[1].direction;
                const d2 = w.minutes[2].direction;
                const d3 = w.minutes[3].direction;
                if (d1 !== d2 || d2 !== d3) return 'SKIP';
                return d1;
            }
        },

        // === CONSECUTIVE CANDLE DIRECTION ===
        {
            name: 'Last 2 candles (min3+min4) same direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d3 = w.minutes[2].direction;
                const d4 = w.minutes[3].direction;
                if (d3 !== d4) return 'SKIP';
                return d3;
            }
        },
        {
            name: 'First 3 candles trending, predict continuation',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d0 = w.minutes[0].direction;
                const d1 = w.minutes[1].direction;
                const d2 = w.minutes[2].direction;
                if (d0 !== d1 || d1 !== d2) return 'SKIP';
                return d0;
            }
        },

        // === VOLUME SIGNALS ===
        {
            name: 'High volume min4 candle (>2x avg) → predict its direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const avgVol = w.minutes.slice(0, 4).reduce((s, m) => s + m.volume, 0) / 4;
                const m4Vol = w.minutes[3].volume;
                if (m4Vol < avgVol * 2) return 'SKIP';
                return w.minutes[3].direction;
            }
        },

        // === BODY SIZE (big move = continuation) ===
        {
            name: 'Big body min4 (>2x avg body) → predict continuation',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const avgBody = w.minutes.slice(0, 4).reduce((s, m) => s + m.bodySize, 0) / 4;
                const m4Body = w.minutes[3].bodySize;
                if (m4Body < avgBody * 2) return 'SKIP';
                return w.minutes[3].direction;
            }
        },

        // === REVERSAL DETECTION ===
        {
            name: 'Reversal: min3 opposite of min1+min2 → predict min3 direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d1 = w.minutes[0].direction;
                const d2 = w.minutes[1].direction;
                const d3 = w.minutes[2].direction;
                if (d1 !== d2) return 'SKIP'; // need first 2 to agree
                if (d3 === d1) return 'SKIP'; // not a reversal
                return d3; // bet on the reversal continuing
            }
        },
        {
            name: 'Anti-reversal: min3 opposite of min1+min2 → predict min1 direction',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d1 = w.minutes[0].direction;
                const d2 = w.minutes[1].direction;
                const d3 = w.minutes[2].direction;
                if (d1 !== d2) return 'SKIP';
                if (d3 === d1) return 'SKIP';
                return d1; // bet against the reversal (original trend resumes)
            }
        },

        // === COMBINED SIGNALS ===
        {
            name: 'COMBO: direction at min4 + momentum min3→min4 agrees + overall from open',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m3 = w.minutes[2].close;
                const m4 = w.minutes[3].close;
                const fromOpen = m4 >= w.openPrice ? 'UP' : 'DOWN';
                const momentum = m4 >= m3 ? 'UP' : 'DOWN';
                const candle4Dir = w.minutes[3].direction;
                if (fromOpen !== momentum || momentum !== candle4Dir) return 'SKIP';
                return fromOpen;
            }
        },
        {
            name: 'COMBO: all 4 candles same direction (strong trend)',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const d0 = w.minutes[0].direction;
                if (w.minutes.slice(1, 4).every(m => m.direction === d0)) {
                    return d0;
                }
                return 'SKIP';
            }
        },
        {
            name: 'COMBO: direction + big body + momentum aligned at min4',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m3 = w.minutes[2].close;
                const m4 = w.minutes[3].close;
                const fromOpen = m4 >= w.openPrice ? 'UP' : 'DOWN';
                const momentum = m4 >= m3 ? 'UP' : 'DOWN';
                if (fromOpen !== momentum) return 'SKIP';
                const avgBody = w.minutes.slice(0, 4).reduce((s, m) => s + m.bodySize, 0) / 4;
                if (w.minutes[3].bodySize < avgBody * 1.5) return 'SKIP';
                return fromOpen;
            }
        },

        // === MOVE SIZE FILTERS ===
        {
            name: 'Direction at min4 BUT only if move > 0.05% from open',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m4 = w.minutes[3].close;
                const movePct = Math.abs(m4 - w.openPrice) / w.openPrice * 100;
                if (movePct < 0.05) return 'SKIP';
                return m4 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },
        {
            name: 'Direction at min4 BUT only if move > 0.10% from open',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m4 = w.minutes[3].close;
                const movePct = Math.abs(m4 - w.openPrice) / w.openPrice * 100;
                if (movePct < 0.10) return 'SKIP';
                return m4 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },
        {
            name: 'Direction at min4 BUT only if move > 0.15% from open',
            predict: (w) => {
                if (w.minutes.length < 5) return 'SKIP';
                const m4 = w.minutes[3].close;
                const movePct = Math.abs(m4 - w.openPrice) / w.openPrice * 100;
                if (movePct < 0.15) return 'SKIP';
                return m4 >= w.openPrice ? 'UP' : 'DOWN';
            }
        },
    ];

    // Run all signals
    console.log('=== 1-MINUTE PATTERN BACKTEST RESULTS ===');
    console.log(`${windows.length} 5-min windows over ${DAYS} days\n`);
    console.log('Signal'.padEnd(60) + ' | Acc    | Trades | Skip%  | Break-Even Bid');
    console.log('-'.repeat(105));

    const results: { name: string; accuracy: number; total: number; skipRate: number }[] = [];

    for (const signal of signals) {
        const r = runSignal(windows, signal);
        const skipRate = r.skipped / (r.total + r.skipped);
        const breakEvenBid = (1 - r.accuracy); // minimum bid needed to break even

        console.log(
            signal.name.padEnd(60) + ' | ' +
            (r.accuracy * 100).toFixed(1).padStart(5) + '% | ' +
            String(r.total).padStart(6) + ' | ' +
            (skipRate * 100).toFixed(0).padStart(4) + '%  | ' +
            (breakEvenBid * 100).toFixed(0) + 'c'
        );

        results.push({ name: signal.name, accuracy: r.accuracy, total: r.total, skipRate });
    }

    // Best signals
    console.log('\n=== TOP SIGNALS BY ACCURACY (min 100 trades) ===\n');
    const viable = results.filter(r => r.total >= 100).sort((a, b) => b.accuracy - a.accuracy);
    for (const r of viable.slice(0, 10)) {
        const ev15c = r.accuracy * 15 - (1 - r.accuracy) * 85; // EV at 15c bid
        const ev27c = r.accuracy * 27 - (1 - r.accuracy) * 73; // EV at 27c bid
        console.log(
            `  ${(r.accuracy * 100).toFixed(1)}% | ${r.name}`
        );
        console.log(
            `         n=${r.total} | skip=${(r.skipRate * 100).toFixed(0)}% | EV@15c: $${ev15c >= 0 ? '+' : ''}${ev15c.toFixed(2)} | EV@27c: $${ev27c >= 0 ? '+' : ''}${ev27c.toFixed(2)}`
        );
    }

    // What accuracy do we actually need?
    console.log('\n=== BREAK-EVEN REFERENCE ===');
    console.log('  At 8c loser bid:  need 92% accuracy');
    console.log('  At 15c loser bid: need 85% accuracy');
    console.log('  At 20c loser bid: need 80% accuracy');
    console.log('  At 27c loser bid: need 73% accuracy');
    console.log('  At 35c loser bid: need 65% accuracy');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
