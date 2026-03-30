/**
 * One-time backfill: add simulatedTrades to existing pricing-data.jsonl records.
 * Uses the same simulation logic as the updated pricing-collector.
 */

import { readFileSync, writeFileSync } from 'node:fs';

const TAKER_FEE_RATE = 0.001;
const GAS_COST_CENTS = 100;

const INPUT = process.argv[2] || 'pricing-data.raw.jsonl';

const lines = readFileSync(INPUT, 'utf-8').trim().split('\n');
console.log(`Processing ${lines.length} records...`);

function isEmptyBookSnapshot(snap: { upBid: number; upAsk: number; downBid: number; downAsk: number }): boolean {
    return snap.upBid === 0 && snap.upAsk === 1 && snap.downBid === 0 && snap.downAsk === 1;
}

let backfilled = 0;
let alreadyHad = 0;

const output: string[] = [];

for (const line of lines) {
    const record = JSON.parse(line);

    if (record.simulatedTrades && record.simulatedTrades.length > 0) {
        alreadyHad++;
        output.push(line);
        continue;
    }

    const resolution = record.resolution;
    if (resolution === 'UNKNOWN' || !record.snapshots?.length) {
        record.simulatedTrades = [];
        output.push(JSON.stringify(record));
        continue;
    }

    record.simulatedTrades = record.snapshots.flatMap((snap: any) => {
        if (isEmptyBookSnapshot(snap)) return [];

        const upIsUnderdog = snap.upMid < snap.downMid;
        const side = upIsUnderdog ? 'UP' : 'DOWN';
        const entryAsk = upIsUnderdog ? snap.upAsk : snap.downAsk;
        const entryBid = upIsUnderdog ? snap.upBid : snap.downBid;
        const favoriteImpliedProb = upIsUnderdog ? snap.downMid : snap.upMid;

        if (entryAsk <= 0 || entryAsk >= 1) return [];

        const entryCostCents = entryAsk * 100;
        const takerFeeCents = entryCostCents * TAKER_FEE_RATE;
        const spreadCostCents = ((entryAsk - entryBid) * 100) / 2;
        const totalCostCents = entryCostCents + takerFeeCents + GAS_COST_CENTS + spreadCostCents;

        const won = side === resolution;
        const payoutCents = won ? 100 : 0;
        const netPnlCents = payoutCents - totalCostCents;

        return [{
            snapshotSecBefore: snap.secondsBeforeEnd,
            side,
            entryAsk,
            entryCostCents,
            takerFeeCents,
            gasCostCents: GAS_COST_CENTS,
            spreadCostCents,
            totalCostCents,
            won,
            payoutCents,
            netPnlCents,
            favoriteImpliedProb,
        }];
    });

    backfilled++;
    output.push(JSON.stringify(record));
}

writeFileSync(INPUT, output.join('\n') + '\n');
console.log(`Done: ${backfilled} backfilled, ${alreadyHad} already had simulated trades`);

// Print summary of simulated results
let wins = 0, losses = 0, totalPnl = 0;
const byConf: Record<string, { w: number; l: number; pnl: number }> = {};

for (const line of output) {
    const record = JSON.parse(line);
    for (const t of record.simulatedTrades || []) {
        if (t.snapshotSecBefore < 110 || t.snapshotSecBefore > 130) continue; // T-120s only

        if (t.won) wins++; else losses++;
        totalPnl += t.netPnlCents;

        const confPct = Math.round(t.favoriteImpliedProb * 100);
        const bucket = confPct >= 80 ? '80-100%' : confPct >= 60 ? '60-80%' : confPct >= 50 ? '50-60%' : '<50%';
        if (!byConf[bucket]) byConf[bucket] = { w: 0, l: 0, pnl: 0 };
        if (t.won) byConf[bucket].w++; else byConf[bucket].l++;
        byConf[bucket].pnl += t.netPnlCents;
    }
}

console.log(`\n=== Simulated Underdog Strategy @ T-120s (with fees) ===`);
console.log(`Total: ${wins}W / ${losses}L (${(wins / (wins + losses) * 100).toFixed(1)}%) | Net PnL: ${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(0)}¢`);
console.log(`\nBy favorite confidence:`);
for (const [bucket, data] of Object.entries(byConf).sort()) {
    const n = data.w + data.l;
    console.log(`  Fav ${bucket}: ${data.w}W/${data.l}L (${(data.w / n * 100).toFixed(0)}%) | PnL: ${data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(0)}¢`);
}
