/**
 * Deeper simulation analysis on backfilled pricing data.
 * Tests different position sizes, entry filters, and the mispricing zone.
 */

import { readFileSync } from 'node:fs';

const INPUT = 'pricing-data.jsonl';
const lines = readFileSync(INPUT, 'utf-8').trim().split('\n').map(l => JSON.parse(l));

console.log(`Analyzing ${lines.length} strategy-grade markets...\n`);

// --- Analysis 1: Position sizing impact ---
// Gas is fixed $1. With $10 position, gas is 10%. With $100, it's 1%.

console.log('=== Position Size Impact (T-120s, 60-80% fav zone only) ===');
for (const posSize of [10, 25, 50, 100, 200]) {
    let pnl = 0;
    let trades = 0;

    for (const record of lines) {
        const t120 = (record.simulatedTrades || []).find((t: any) =>
            t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130
        );
        if (!t120) continue;

        const confPct = Math.round(t120.favoriteImpliedProb * 100);
        if (confPct < 60 || confPct >= 80) continue;

        trades++;
        const shares = posSize / (t120.entryAsk); // shares we can buy
        const entryCost = shares * t120.entryAsk; // = posSize
        const takerFee = entryCost * 0.001;
        const gasCost = 1.00; // $1 fixed
        const payout = t120.won ? shares * 1.00 : 0;
        const tradePnl = payout - entryCost - takerFee - gasCost;
        pnl += tradePnl;
    }

    const avgPnl = trades > 0 ? pnl / trades : 0;
    console.log(`  $${posSize}/trade: ${trades} trades | Total PnL: $${pnl.toFixed(2)} | Avg: $${avgPnl.toFixed(2)}/trade | ROI: ${(pnl / (posSize * trades) * 100).toFixed(1)}%`);
}

// --- Analysis 2: Filter by underdog ask price (entry cost) ---

console.log('\n=== Entry Filter: Underdog Ask Price @ T-120s ===');
for (const maxAsk of [0.10, 0.15, 0.20, 0.25, 0.30, 0.35, 0.40, 0.45]) {
    let wins = 0, losses = 0, pnlCents = 0;

    for (const record of lines) {
        const t120 = (record.simulatedTrades || []).find((t: any) =>
            t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130
        );
        if (!t120) continue;
        if (t120.entryAsk > maxAsk) continue;

        if (t120.won) wins++; else losses++;
        pnlCents += t120.netPnlCents;
    }

    const n = wins + losses;
    if (n === 0) continue;
    const wr = (wins / n * 100).toFixed(0);
    console.log(`  Ask ≤ ${(maxAsk * 100).toFixed(0)}¢: ${wins}W/${losses}L (${wr}%) | PnL: ${pnlCents >= 0 ? '+' : ''}${pnlCents.toFixed(0)}¢ (per-share basis)`);
}

// --- Analysis 3: Best entry timing ---

console.log('\n=== Entry Timing (60-80% fav zone, $50 position) ===');
const timeBuckets = [240, 210, 180, 150, 120, 90, 60, 45, 30, 15, 10];
for (const targetSec of timeBuckets) {
    let wins = 0, losses = 0, pnl = 0;

    for (const record of lines) {
        const trade = (record.simulatedTrades || []).find((t: any) =>
            Math.abs(t.snapshotSecBefore - targetSec) <= 10
        );
        if (!trade) continue;

        const confPct = Math.round(trade.favoriteImpliedProb * 100);
        if (confPct < 60 || confPct >= 80) continue;

        const posSize = 50;
        const shares = posSize / trade.entryAsk;
        const entryCost = shares * trade.entryAsk;
        const takerFee = entryCost * 0.001;
        const gasCost = 1.00;
        const payout = trade.won ? shares * 1.00 : 0;
        const tradePnl = payout - entryCost - takerFee - gasCost;

        if (trade.won) wins++; else losses++;
        pnl += tradePnl;
    }

    const n = wins + losses;
    if (n === 0) continue;
    console.log(`  T-${targetSec}s: ${wins}W/${losses}L (${(wins/n*100).toFixed(0)}%) | PnL: $${pnl.toFixed(2)} | Avg: $${(pnl/n).toFixed(2)}/trade`);
}

// --- Analysis 4: Combined filter (the real strategy) ---

console.log('\n=== Combined Strategy: 60-80% fav + underdog ask 20-40¢ + T-120s entry ===');
{
    let wins = 0, losses = 0;
    const posSize = 50;
    let totalPnl = 0;
    const trades: Array<{ slug: string; side: string; ask: number; fav: number; won: boolean; pnl: number }> = [];

    for (const record of lines) {
        const t120 = (record.simulatedTrades || []).find((t: any) =>
            t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130
        );
        if (!t120) continue;

        const confPct = Math.round(t120.favoriteImpliedProb * 100);
        if (confPct < 60 || confPct >= 80) continue;
        if (t120.entryAsk < 0.20 || t120.entryAsk > 0.40) continue;

        const shares = posSize / t120.entryAsk;
        const entryCost = shares * t120.entryAsk;
        const takerFee = entryCost * 0.001;
        const gasCost = 1.00;
        const payout = t120.won ? shares * 1.00 : 0;
        const tradePnl = payout - entryCost - takerFee - gasCost;

        if (t120.won) wins++; else losses++;
        totalPnl += tradePnl;
        trades.push({
            slug: record.slug,
            side: t120.side,
            ask: t120.entryAsk,
            fav: t120.favoriteImpliedProb,
            won: t120.won,
            pnl: tradePnl,
        });
    }

    const n = wins + losses;
    console.log(`  Trades: ${n} | Win rate: ${(wins/n*100).toFixed(1)}%`);
    console.log(`  Total PnL: $${totalPnl.toFixed(2)} | Avg per trade: $${(totalPnl/n).toFixed(2)}`);
    console.log(`  ROI: ${(totalPnl / (posSize * n) * 100).toFixed(1)}%`);
    console.log(`  Individual trades:`);
    for (const t of trades) {
        console.log(`    ${t.slug}: ${t.won ? 'WIN ' : 'LOSS'} | buy ${t.side} @${(t.ask*100).toFixed(0)}¢ (fav=${(t.fav*100).toFixed(0)}%) → $${t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}`);
    }
}
