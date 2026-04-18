/**
 * Ledger audit for microstructure bot runs.
 *
 * Flags three common analysis hazards:
 * - dry-run rows mixed into the live ledger
 * - duplicate filled slugs from concurrent live instances
 * - divergence between summed trade PnL and wallet balance delta
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/ledger-audit.ts
 *   npx tsx src/scripts/crypto-5min/ledger-audit.ts --ledger /tmp/microstructure-trades.jsonl
 *   npx tsx src/scripts/crypto-5min/ledger-audit.ts --since 2026-04-15T23:24:30Z
 */

import { readFileSync } from 'node:fs';

type TradeRow = {
    timestamp: string;
    slug: string;
    expectedPnl: number;
    won: boolean;
    balanceBefore: number;
    balanceAfter: number;
    execution: {
        status: 'FILLED' | 'UNFILLED' | 'ERROR';
        orderId: string;
        fillPrice: number;
        fillSize: number;
        fillCost: number;
        fillType?: 'MAKER' | 'TAKER' | 'UNFILLED';
    };
};

const args = process.argv.slice(2);

function getArg(name: string, defaultValue: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultValue;
}

const ledgerPath = getArg('--ledger', 'microstructure-trades.jsonl');
const since = getArg('--since', '');

function isDryRun(row: TradeRow): boolean {
    return row.execution.orderId === 'dry-run' || row.balanceBefore < 0 || row.balanceAfter < 0;
}

function sumExpected(rows: TradeRow[]): number {
    return rows.reduce((sum, row) => sum + row.expectedPnl, 0);
}

function walletDelta(rows: TradeRow[]): number | null {
    const first = rows.find(row => row.balanceBefore > 0);
    const last = [...rows].reverse().find(row => row.balanceAfter > 0);
    if (!first || !last) return null;
    return last.balanceAfter - first.balanceBefore;
}

function fmtMoney(value: number | null): string {
    if (value == null) return 'n/a';
    const sign = value > 0 ? '+' : '';
    return `${sign}$${value.toFixed(2)}`;
}

function printSection(title: string): void {
    console.log(`\n${title}`);
    console.log('-'.repeat(title.length));
}

const rows = readFileSync(ledgerPath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as TradeRow)
    .filter(row => !since || row.timestamp >= since);

const filled = rows.filter(row => row.execution.status === 'FILLED');
const dryRunRows = rows.filter(isDryRun);
const liveRows = rows.filter(row => !isDryRun(row));
const liveFilled = liveRows.filter(row => row.execution.status === 'FILLED');

const duplicateMap = new Map<string, TradeRow[]>();
for (const row of liveFilled) {
    const items = duplicateMap.get(row.slug) ?? [];
    items.push(row);
    duplicateMap.set(row.slug, items);
}
const duplicateFilled = [...duplicateMap.entries()]
    .filter(([, items]) => items.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

const uniqueLiveFilled = [...duplicateMap.values()].map(items => items[0]);

console.log(`Ledger: ${ledgerPath}`);
if (since) console.log(`Since:  ${since}`);
console.log(`Rows:   ${rows.length} total | ${filled.length} filled`);
if (rows.length > 0) {
    console.log(`Span:   ${rows[0].timestamp} -> ${rows[rows.length - 1].timestamp}`);
}

printSection('Contamination');
console.log(`Dry-run rows:          ${dryRunRows.length}`);
console.log(`Dry-run filled PnL:    ${fmtMoney(sumExpected(dryRunRows.filter(row => row.execution.status === 'FILLED')))}`);
console.log(`Live rows:             ${liveRows.length}`);
console.log(`Live filled rows:      ${liveFilled.length}`);

printSection('Duplicates');
console.log(`Duplicate live slugs:  ${duplicateFilled.length}`);
console.log(`Extra filled rows:     ${liveFilled.length - uniqueLiveFilled.length}`);
console.log(`Raw live filled PnL:   ${fmtMoney(sumExpected(liveFilled))}`);
console.log(`Deduped live PnL:      ${fmtMoney(sumExpected(uniqueLiveFilled))}`);

for (const [slug, items] of duplicateFilled.slice(0, 10)) {
    const details = items
        .map(item => `${item.timestamp} ${item.execution.fillType ?? 'unknown'} ${fmtMoney(item.expectedPnl)}`)
        .join(' | ');
    console.log(`  ${slug}: ${details}`);
}

printSection('Wallet Check');
console.log(`Live wallet delta:     ${fmtMoney(walletDelta(liveRows))}`);
console.log(`Deduped live PnL:      ${fmtMoney(sumExpected(uniqueLiveFilled))}`);
const delta = walletDelta(liveRows);
if (delta != null) {
    const gap = delta - sumExpected(uniqueLiveFilled);
    console.log(`Wallet - deduped PnL:  ${fmtMoney(gap)}`);
}

printSection('Live Fill Stats');
const wins = uniqueLiveFilled.filter(row => row.won).length;
const avgFill = uniqueLiveFilled.length > 0
    ? uniqueLiveFilled.reduce((sum, row) => sum + row.execution.fillPrice, 0) / uniqueLiveFilled.length
    : 0;
console.log(`Unique live fills:     ${uniqueLiveFilled.length}`);
console.log(`Win rate:              ${uniqueLiveFilled.length > 0 ? (100 * wins / uniqueLiveFilled.length).toFixed(1) : '0.0'}%`);
console.log(`Avg fill price:        ${avgFill.toFixed(3)}`);
console.log(`Avg PnL / fill:        ${uniqueLiveFilled.length > 0 ? fmtMoney(sumExpected(uniqueLiveFilled) / uniqueLiveFilled.length) : 'n/a'}`);
