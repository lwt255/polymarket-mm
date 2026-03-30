/**
 * When does BTC move enough to trade?
 *
 * Analyzes 180 days of 5-min BTC moves broken down by:
 *   - Hour of day (UTC and ET)
 *   - Day of week
 *   - Day + hour combos
 *
 * For each time slot, shows: how often BTC moves > 0.03%, 0.05%, 0.10%
 *
 * Run: npx tsx src/scripts/crypto-5min/volatility-schedule-backtest.ts [days]
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
    openTime: number;
    openPrice: number;
    closePrice: number;
    movePct: number; // absolute % move at T-60s (close of min 4)
    totalMovePct: number; // absolute % move at close
    hourUTC: number;
    hourET: number;
    dayOfWeek: number; // 0=Sun, 6=Sat
    dayName: string;
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function buildWindows(candles: any[]): FiveMinWindow[] {
    const groups: Map<number, any[]> = new Map();
    for (const c of candles) {
        const bucket = Math.floor(c[0] / 300000) * 300000;
        if (!groups.has(bucket)) groups.set(bucket, []);
        groups.get(bucket)!.push(c);
    }

    const windows: FiveMinWindow[] = [];
    for (const [openTime, mins] of groups) {
        if (mins.length < 5) continue;
        mins.sort((a: any, b: any) => a[0] - b[0]);

        const openPrice = mins[0][1];
        const closePrice = mins[4][4];
        const priceAtMin4 = mins[3][4];
        const movePct = Math.abs(priceAtMin4 - openPrice) / openPrice * 100;
        const totalMovePct = Math.abs(closePrice - openPrice) / openPrice * 100;

        const date = new Date(openTime);
        const hourUTC = date.getUTCHours();
        // ET = UTC - 4 (EDT) or UTC - 5 (EST). Use -4 for simplicity.
        const hourET = (hourUTC - 4 + 24) % 24;
        const dayOfWeek = date.getUTCDay();

        windows.push({
            openTime, openPrice, closePrice, movePct, totalMovePct,
            hourUTC, hourET, dayOfWeek, dayName: DAYS[dayOfWeek],
        });
    }
    return windows.sort((a, b) => a.openTime - b.openTime);
}

async function main() {
    const DAYS_BACK = parseInt(process.argv[2] || '180');
    const candles = await fetchOneMinCandles(DAYS_BACK);
    const windows = buildWindows(candles);
    console.log(`5-min windows: ${windows.length}\n`);

    // Overall stats
    const thresholds = [0.03, 0.05, 0.08, 0.10, 0.15, 0.20];
    console.log('=== OVERALL MOVE DISTRIBUTION (at T-60s) ===\n');
    for (const t of thresholds) {
        const passing = windows.filter(w => w.movePct >= t).length;
        console.log(`  > ${(t * 100).toFixed(0).padStart(2)}bps: ${passing}/${windows.length} (${(passing / windows.length * 100).toFixed(1)}%) → ${(passing / DAYS_BACK).toFixed(0)}/day`);
    }

    // By hour of day (ET)
    console.log('\n=== BY HOUR (Eastern Time) ===\n');
    console.log('Hour ET  | Candles | >3bps      | >5bps      | >10bps     | >15bps     | Avg Move');
    console.log('-'.repeat(90));

    for (let h = 0; h < 24; h++) {
        const hourWindows = windows.filter(w => w.hourET === h);
        if (hourWindows.length === 0) continue;

        const counts = thresholds.map(t => hourWindows.filter(w => w.movePct >= t).length);
        const avgMove = hourWindows.reduce((s, w) => s + w.movePct, 0) / hourWindows.length;
        const perDay = hourWindows.length / DAYS_BACK;

        const label = h < 12 ? `${h === 0 ? 12 : h}AM` : `${h === 12 ? 12 : h - 12}PM`;

        console.log(
            `${label.padStart(7)}  | ${String(hourWindows.length).padStart(7)} | ` +
            `${counts[0]}(${(counts[0] / hourWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${counts[1]}(${(counts[1] / hourWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${counts[3]}(${(counts[3] / hourWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${counts[4]}(${(counts[4] / hourWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${(avgMove * 100).toFixed(1)}bps`
        );
    }

    // By day of week
    console.log('\n=== BY DAY OF WEEK ===\n');
    console.log('Day  | Candles | >3bps      | >5bps      | >10bps     | Avg Move');
    console.log('-'.repeat(75));

    for (let d = 0; d < 7; d++) {
        const dayWindows = windows.filter(w => w.dayOfWeek === d);
        if (dayWindows.length === 0) continue;

        const counts = thresholds.map(t => dayWindows.filter(w => w.movePct >= t).length);
        const avgMove = dayWindows.reduce((s, w) => s + w.movePct, 0) / dayWindows.length;

        console.log(
            `${DAYS[d].padEnd(4)} | ${String(dayWindows.length).padStart(7)} | ` +
            `${counts[0]}(${(counts[0] / dayWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${counts[1]}(${(counts[1] / dayWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${counts[3]}(${(counts[3] / dayWindows.length * 100).toFixed(0)}%)`.padEnd(10) + ' | ' +
            `${(avgMove * 100).toFixed(1)}bps`
        );
    }

    // Best trading windows: day + hour combos
    console.log('\n=== BEST TRADING WINDOWS (highest % of candles > 0.03%) ===\n');

    interface TimeSlot {
        day: string;
        hourET: number;
        label: string;
        total: number;
        passing03: number;
        passing05: number;
        passing10: number;
        rate03: number;
        avgMove: number;
        tradesPerDay: number;
    }

    const slots: TimeSlot[] = [];
    for (let d = 0; d < 7; d++) {
        for (let h = 0; h < 24; h++) {
            const slotWindows = windows.filter(w => w.dayOfWeek === d && w.hourET === h);
            if (slotWindows.length < 20) continue;

            const passing03 = slotWindows.filter(w => w.movePct >= 0.03).length;
            const passing05 = slotWindows.filter(w => w.movePct >= 0.05).length;
            const passing10 = slotWindows.filter(w => w.movePct >= 0.10).length;
            const avgMove = slotWindows.reduce((s, w) => s + w.movePct, 0) / slotWindows.length;

            const hourLabel = h < 12 ? `${h === 0 ? 12 : h}AM` : `${h === 12 ? 12 : h - 12}PM`;
            const numWeeks = DAYS_BACK / 7;
            const candlesPerHour = slotWindows.length / numWeeks;

            slots.push({
                day: DAYS[d],
                hourET: h,
                label: `${DAYS[d]} ${hourLabel} ET`,
                total: slotWindows.length,
                passing03,
                passing05,
                passing10,
                rate03: passing03 / slotWindows.length,
                avgMove,
                tradesPerDay: passing03 / numWeeks,
            });
        }
    }

    // Sort by qualifying trades per week-hour
    slots.sort((a, b) => b.rate03 - a.rate03);

    console.log('Slot              | Total | >3bps Rate | >5bps Rate | >10bps Rate | Avg Move | Trades/wk');
    console.log('-'.repeat(100));
    for (const s of slots.slice(0, 25)) {
        console.log(
            s.label.padEnd(17) + ' | ' +
            String(s.total).padStart(5) + ' | ' +
            `${(s.rate03 * 100).toFixed(0)}%`.padStart(9) + '  | ' +
            `${(s.passing05 / s.total * 100).toFixed(0)}%`.padStart(9) + '  | ' +
            `${(s.passing10 / s.total * 100).toFixed(0)}%`.padStart(10) + '  | ' +
            `${(s.avgMove * 100).toFixed(1)}bps`.padStart(8) + ' | ' +
            s.tradesPerDay.toFixed(1).padStart(9)
        );
    }

    // Worst windows
    console.log('\n=== WORST TRADING WINDOWS (avoid these) ===\n');
    const worst = [...slots].sort((a, b) => a.rate03 - b.rate03);
    console.log('Slot              | Total | >3bps Rate | Avg Move');
    console.log('-'.repeat(60));
    for (const s of worst.slice(0, 10)) {
        console.log(
            s.label.padEnd(17) + ' | ' +
            String(s.total).padStart(5) + ' | ' +
            `${(s.rate03 * 100).toFixed(0)}%`.padStart(9) + '  | ' +
            `${(s.avgMove * 100).toFixed(1)}bps`
        );
    }

    // Weekday peak hours summary
    console.log('\n=== WEEKDAY PEAK HOURS SUMMARY (Mon-Fri) ===\n');

    const peakRanges = [
        { name: 'Pre-market (4-9:30 AM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 4 && w.hourET < 10 },
        { name: 'US Market Open (9:30-11 AM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 9 && w.hourET < 11 },
        { name: 'Midday (11 AM-2 PM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 11 && w.hourET < 14 },
        { name: 'Afternoon (2-4 PM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 14 && w.hourET < 16 },
        { name: 'After hours (4-8 PM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 16 && w.hourET < 20 },
        { name: 'Night (8 PM-12 AM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET >= 20 },
        { name: 'Overnight (12-4 AM ET)', filter: (w: FiveMinWindow) => w.dayOfWeek >= 1 && w.dayOfWeek <= 5 && w.hourET < 4 },
        { name: 'Weekend all day', filter: (w: FiveMinWindow) => w.dayOfWeek === 0 || w.dayOfWeek === 6 },
    ];

    console.log('Period'.padEnd(35) + ' | Candles | >3bps | >5bps | >10bps | Trades/day | Est $/day @$10');
    console.log('-'.repeat(105));

    for (const range of peakRanges) {
        const rWindows = windows.filter(range.filter);
        if (rWindows.length === 0) continue;

        const p03 = rWindows.filter(w => w.movePct >= 0.03).length;
        const p05 = rWindows.filter(w => w.movePct >= 0.05).length;
        const p10 = rWindows.filter(w => w.movePct >= 0.10).length;

        // Estimate trading days
        const uniqueDays = new Set(rWindows.map(w => Math.floor(w.openTime / 86400000))).size;
        const tradesPerDay = p03 / uniqueDays;

        // EV estimate at $10/trade with buy-winner at 0.03% filter
        // 93.4% accuracy, avg win +$3.30, loss -$10
        const dailyEv = tradesPerDay * (0.934 * 3.30 - 0.066 * 10);

        console.log(
            range.name.padEnd(35) + ' | ' +
            String(rWindows.length).padStart(7) + ' | ' +
            `${(p03 / rWindows.length * 100).toFixed(0)}%`.padStart(5) + ' | ' +
            `${(p05 / rWindows.length * 100).toFixed(0)}%`.padStart(5) + ' | ' +
            `${(p10 / rWindows.length * 100).toFixed(0)}%`.padStart(6) + ' | ' +
            tradesPerDay.toFixed(1).padStart(10) + ' | ' +
            `$${dailyEv >= 0 ? '+' : ''}${dailyEv.toFixed(2)}`.padStart(14)
        );
    }
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
