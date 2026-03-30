/**
 * Analyze straddle study results by hour and volume to find peak trading windows.
 */
import { readFileSync } from 'fs';

const data = JSON.parse(readFileSync('straddle-study-results.json', 'utf8'));

console.log('=== Per-Candle Breakdown ===\n');
for (let i = 0; i < data.length; i++) {
    const c = data[i];
    const dt = new Date(c.timestamp);
    const hour = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false });
    const day = dt.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
    const strat2c = c.strategies?.find((s: any) => s.offset === 0.02);
    const bothFill = strat2c ? strat2c.bothFilled : 'N/A';
    console.log(`Candle ${String(i + 1).padStart(2)}: ${day} ${hour} ET | Vol: $${String(c.volume || 0).padStart(8)} | Range: ${((c.range || 0) * 100).toFixed(1)}c | 2c Both-fill: ${bothFill}`);
}

console.log('\n=== Summary by Hour (ET) ===\n');
const byHour: Record<string, { total: number; bothFill: number; volumes: number[] }> = {};

for (const c of data) {
    const dt = new Date(c.timestamp);
    const hour = dt.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false });
    if (!byHour[hour]) byHour[hour] = { total: 0, bothFill: 0, volumes: [] };
    byHour[hour].total++;
    const strat2c = c.strategies?.find((s: any) => s.offset === 0.02);
    if (strat2c?.bothFilled) byHour[hour].bothFill++;
    byHour[hour].volumes.push(c.volume || 0);
}

const sorted = Object.keys(byHour).sort((a, b) => parseInt(a) - parseInt(b));
for (const h of sorted) {
    const b = byHour[h];
    const avgVol = b.volumes.reduce((s, v) => s + v, 0) / b.volumes.length;
    const minVol = Math.min(...b.volumes);
    const maxVol = Math.max(...b.volumes);
    console.log(`${h}:00 ET | Candles: ${b.total} | Both-fill: ${b.bothFill}/${b.total} (${((b.bothFill / b.total) * 100).toFixed(0)}%) | Vol: avg $${avgVol.toFixed(0)}, min $${minVol}, max $${maxVol}`);
}

// Volume threshold analysis
console.log('\n=== Both-Fill Rate by Volume Threshold ===\n');
const allCandles = data.map((c: any) => {
    const strat2c = c.strategies?.find((s: any) => s.offset === 0.02);
    return { volume: c.volume || 0, bothFill: strat2c?.bothFilled || false, range: c.range || 0 };
});

for (const threshold of [0, 5000, 10000, 25000, 50000, 75000, 100000, 150000, 200000]) {
    const above = allCandles.filter((c: any) => c.volume >= threshold);
    const bothFills = above.filter((c: any) => c.bothFill).length;
    if (above.length > 0) {
        const avgRange = above.reduce((s: number, c: any) => s + c.range, 0) / above.length;
        console.log(`Vol >= $${String(threshold).padStart(7)} | Candles: ${String(above.length).padStart(3)} | Both-fill: ${bothFills}/${above.length} (${((bothFills / above.length) * 100).toFixed(0)}%) | Avg range: ${(avgRange * 100).toFixed(1)}c`);
    }
}
