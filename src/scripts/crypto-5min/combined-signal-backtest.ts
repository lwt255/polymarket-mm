/**
 * Test: Does combining 1-min patterns WITH the move filter improve accuracy
 * beyond the move filter alone? If not, the move filter is all we need.
 *
 * Run: npx tsx src/scripts/crypto-5min/combined-signal-backtest.ts [days]
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

interface Window {
    openPrice: number;
    closePrice: number;
    outcome: 'UP' | 'DOWN';
    mins: { open: number; high: number; low: number; close: number; volume: number; dir: 'UP' | 'DOWN'; body: number }[];
    moveAtMin4Pct: number;
    dirAtMin4: 'UP' | 'DOWN';
}

function buildWindows(candles: any[]): Window[] {
    const groups: Map<number, any[]> = new Map();
    for (const c of candles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    const windows: Window[] = [];
    for (const [, raw] of groups) {
        if (raw.length < 5) continue;
        raw.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = raw[0][1];
        const closePrice = raw[4][4];
        const outcome: 'UP' | 'DOWN' = closePrice >= openPrice ? 'UP' : 'DOWN';

        const mins = raw.map((m: any) => ({
            open: m[1], high: m[2], low: m[3], close: m[4], volume: m[5],
            dir: (m[4] >= m[1] ? 'UP' : 'DOWN') as 'UP' | 'DOWN',
            body: Math.abs(m[4] - m[1]),
        }));

        const priceAtMin4 = mins[3].close;
        const moveAtMin4Pct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        const dirAtMin4: 'UP' | 'DOWN' = priceAtMin4 >= openPrice ? 'UP' : 'DOWN';

        windows.push({ openPrice, closePrice, outcome, mins, moveAtMin4Pct, dirAtMin4 });
    }
    return windows;
}

async function main() {
    const DAYS = parseInt(process.argv[2] || '180');
    const candles = await fetchOneMinCandles(DAYS);
    const windows = buildWindows(candles);
    console.log(`5-min windows: ${windows.length}\n`);

    // Define combined signals — each ADDS to the base move > 0.03% filter
    const tests: { name: string; filter: (w: Window) => boolean }[] = [
        {
            name: 'Move > 0.03% ALONE (baseline)',
            filter: (w) => w.moveAtMin4Pct >= 0.03,
        },
        {
            name: '+ min4 candle agrees with overall direction',
            filter: (w) => w.moveAtMin4Pct >= 0.03 && w.mins[3].dir === w.dirAtMin4,
        },
        {
            name: '+ min3 AND min4 candles agree with direction',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const m3dir = w.mins[2].close >= w.mins[2].open ? 'UP' : 'DOWN';
                return w.mins[3].dir === w.dirAtMin4 && m3dir === w.dirAtMin4;
            },
        },
        {
            name: '+ momentum: min3→min4 in same direction as open→min4',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const momentum = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
                return momentum === w.dirAtMin4;
            },
        },
        {
            name: '+ all first 4 candles same direction',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                return w.mins.slice(0, 4).every(m => m.dir === w.dirAtMin4);
            },
        },
        {
            name: '+ min4 body > average body (strong last candle)',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const avgBody = w.mins.slice(0, 4).reduce((s, m) => s + m.body, 0) / 4;
                return w.mins[3].body >= avgBody;
            },
        },
        {
            name: '+ min4 body > 1.5x average body',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const avgBody = w.mins.slice(0, 4).reduce((s, m) => s + m.body, 0) / 4;
                return w.mins[3].body >= avgBody * 1.5;
            },
        },
        {
            name: '+ min4 volume > average volume',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const avgVol = w.mins.slice(0, 4).reduce((s, m) => s + m.volume, 0) / 4;
                return w.mins[3].volume >= avgVol;
            },
        },
        {
            name: '+ no reversal: min3 direction same as overall',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const m3dir = w.mins[2].close >= w.openPrice ? 'UP' : 'DOWN';
                return m3dir === w.dirAtMin4;
            },
        },
        {
            name: '+ COMBO: momentum + min4 agrees + no reversal',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const momentum = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
                const m3overall = w.mins[2].close >= w.openPrice ? 'UP' : 'DOWN';
                return momentum === w.dirAtMin4 && w.mins[3].dir === w.dirAtMin4 && m3overall === w.dirAtMin4;
            },
        },
        {
            name: '+ COMBO: first 3 trending + momentum into min4',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const d0 = w.mins[0].dir;
                const d1 = w.mins[1].dir;
                const d2 = w.mins[2].dir;
                if (d0 !== d1 || d1 !== d2) return false;
                const momentum = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
                return d0 === w.dirAtMin4 && momentum === w.dirAtMin4;
            },
        },
        // What about ANTI-patterns? When should we NOT trade?
        {
            name: 'Move > 0.03% BUT min4 candle OPPOSES direction (bad sign)',
            filter: (w) => w.moveAtMin4Pct >= 0.03 && w.mins[3].dir !== w.dirAtMin4,
        },
        {
            name: 'Move > 0.03% BUT momentum (min3→min4) OPPOSES direction',
            filter: (w) => {
                if (w.moveAtMin4Pct < 0.03) return false;
                const momentum = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
                return momentum !== w.dirAtMin4;
            },
        },
    ];

    console.log('=== COMBINED SIGNAL ANALYSIS (does anything beat move filter alone?) ===\n');
    console.log('Signal'.padEnd(58) + ' | Acc    | Trades | Skip%  | Improvement');
    console.log('-'.repeat(100));

    let baselineAcc = 0;

    for (const test of tests) {
        let correct = 0, total = 0;
        for (const w of windows) {
            if (!test.filter(w)) continue;
            total++;
            if (w.dirAtMin4 === w.outcome) correct++;
        }

        if (total < 50) continue;

        const accuracy = correct / total;
        const skipRate = 1 - total / windows.length;
        if (test.name.includes('baseline')) baselineAcc = accuracy;
        const improvement = accuracy - baselineAcc;

        console.log(
            test.name.padEnd(58) + ' | ' +
            (accuracy * 100).toFixed(1).padStart(5) + '% | ' +
            String(total).padStart(6) + ' | ' +
            (skipRate * 100).toFixed(0).padStart(4) + '%  | ' +
            (improvement >= 0 ? '+' : '') + (improvement * 100).toFixed(1) + '%'
        );
    }

    // Key question: for the WRONG trades (the 6.6% that lose), is there a pattern?
    console.log('\n=== ANATOMY OF LOSSES (move > 0.03%, direction wrong) ===\n');

    const wrongTrades = windows.filter(w => w.moveAtMin4Pct >= 0.03 && w.dirAtMin4 !== w.outcome);
    const rightTrades = windows.filter(w => w.moveAtMin4Pct >= 0.03 && w.dirAtMin4 === w.outcome);

    console.log('Total wrong: ' + wrongTrades.length + ' / ' + (wrongTrades.length + rightTrades.length));

    // Did min4 candle oppose?
    const wrongMin4Opposes = wrongTrades.filter(w => w.mins[3].dir !== w.dirAtMin4).length;
    const rightMin4Opposes = rightTrades.filter(w => w.mins[3].dir !== w.dirAtMin4).length;
    console.log('\nMin4 candle OPPOSES overall direction:');
    console.log('  In WRONG trades: ' + wrongMin4Opposes + '/' + wrongTrades.length + ' (' + (wrongMin4Opposes/wrongTrades.length*100).toFixed(0) + '%)');
    console.log('  In RIGHT trades: ' + rightMin4Opposes + '/' + rightTrades.length + ' (' + (rightMin4Opposes/rightTrades.length*100).toFixed(0) + '%)');

    // Momentum opposing?
    const wrongMomOpposes = wrongTrades.filter(w => {
        const mom = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
        return mom !== w.dirAtMin4;
    }).length;
    const rightMomOpposes = rightTrades.filter(w => {
        const mom = w.mins[3].close >= w.mins[2].close ? 'UP' : 'DOWN';
        return mom !== w.dirAtMin4;
    }).length;
    console.log('\nMomentum (min3→min4) OPPOSES overall direction:');
    console.log('  In WRONG trades: ' + wrongMomOpposes + '/' + wrongTrades.length + ' (' + (wrongMomOpposes/wrongTrades.length*100).toFixed(0) + '%)');
    console.log('  In RIGHT trades: ' + rightMomOpposes + '/' + rightTrades.length + ' (' + (rightMomOpposes/rightTrades.length*100).toFixed(0) + '%)');

    // Move size of wrong trades
    const wrongMoves = wrongTrades.map(w => w.moveAtMin4Pct).sort((a, b) => a - b);
    const rightMoves = rightTrades.map(w => w.moveAtMin4Pct).sort((a, b) => a - b);
    console.log('\nMove size distribution:');
    console.log('  WRONG avg move: ' + (wrongMoves.reduce((a,b)=>a+b,0)/wrongMoves.length).toFixed(3) + '%');
    console.log('  RIGHT avg move: ' + (rightMoves.reduce((a,b)=>a+b,0)/rightMoves.length).toFixed(3) + '%');
    console.log('  WRONG median:   ' + wrongMoves[Math.floor(wrongMoves.length/2)].toFixed(3) + '%');
    console.log('  RIGHT median:   ' + rightMoves[Math.floor(rightMoves.length/2)].toFixed(3) + '%');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
