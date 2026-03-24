/**
 * Minority-structure report for wallet reverse-engineering.
 *
 * Purpose:
 * - isolate the small slice of flow that sits outside exact complementary
 *   cross-outcome bundles
 * - rank primitives inside non-paired and sub-$1.00 structures
 * - highlight where a real standalone edge is more likely to survive
 *
 * Usage:
 *   npx tsx src/scripts/wallet-minority-structure-report.ts
 *   npx tsx src/scripts/wallet-minority-structure-report.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl
 */

import { readFileSync } from 'node:fs';

const EXECUTIONS_INPUT = process.argv[2] || 'wallet-wallet-executions.normalized.jsonl';
const TX_INPUT = process.argv[3] || 'wallet-tx-events.normalized.jsonl';
const BUNDLE_EQ_TOLERANCE = 0.0001;

interface NormalizedLeg {
    outcome: string | null;
    totalSize: number;
    totalNotional: number;
    dominantPrimitiveKey: string | null;
}

interface NormalizedTxEvent {
    txHash: string;
    structureLabel: string;
    legs: NormalizedLeg[];
}

interface NormalizedWalletExecution {
    txHash: string;
    wallet: string;
    marketSlug: string | null;
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    txStructureLabel: string;
    totalNotional: number;
    buyHoldPnl: number;
    buyResolvedWinRate: number | null;
}

interface PrimitiveSummary {
    primitive: string;
    executions: number;
    uniqueWallets: number;
    uniqueMarkets: number;
    notional: number;
    buyHoldPnl: number;
    buyHoldRoi: number | null;
    avgBuyWinRate: number | null;
}

function loadJsonl<T>(filePath: string): T[] {
    const content = readFileSync(filePath, 'utf8').trim();
    if (!content) return [];

    return content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line) as T);
}

function formatPct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

function bundleCostPerShare(tx: NormalizedTxEvent): number | null {
    const byOutcome: Record<string, number> = {};
    for (const leg of tx.legs) {
        const outcome = String(leg.outcome ?? '').toUpperCase();
        if (!outcome) continue;
        byOutcome[outcome] = (byOutcome[outcome] ?? 0) + leg.totalSize;
    }

    const up = byOutcome.UP ?? 0;
    const down = byOutcome.DOWN ?? 0;
    if (!(up > 0 && down > 0)) return null;

        const totalNotional = tx.legs.reduce((sum, leg) => sum + leg.totalNotional, 0);
    return totalNotional / Math.max(up, down);
}

function buildPrimitiveSummaries(rows: NormalizedWalletExecution[]): PrimitiveSummary[] {
    const buckets = new Map<string, {
        executions: number;
        wallets: Set<string>;
        markets: Set<string>;
        notional: number;
        buyHoldPnl: number;
        winRates: number[];
    }>();

    for (const row of rows) {
        const primitive = row.dominantPrimitiveKey ?? 'UNKNOWN';
        if (!buckets.has(primitive)) {
            buckets.set(primitive, {
                executions: 0,
                wallets: new Set<string>(),
                markets: new Set<string>(),
                notional: 0,
                buyHoldPnl: 0,
                winRates: [],
            });
        }

        const bucket = buckets.get(primitive)!;
        bucket.executions++;
        bucket.wallets.add(row.wallet.toLowerCase());
        bucket.markets.add(row.marketSlug ?? 'unknown-market');
        bucket.notional += row.totalNotional;
        bucket.buyHoldPnl += row.buyHoldPnl;
        if (row.buyResolvedWinRate !== null) bucket.winRates.push(row.buyResolvedWinRate);
    }

    return [...buckets.entries()]
        .map(([primitive, bucket]) => ({
            primitive,
            executions: bucket.executions,
            uniqueWallets: bucket.wallets.size,
            uniqueMarkets: bucket.markets.size,
            notional: bucket.notional,
            buyHoldPnl: bucket.buyHoldPnl,
            buyHoldRoi: bucket.notional > 0 ? bucket.buyHoldPnl / bucket.notional : null,
            avgBuyWinRate: bucket.winRates.length > 0
                ? bucket.winRates.reduce((sum, value) => sum + value, 0) / bucket.winRates.length
                : null,
        }))
        .sort((a, b) => {
            if ((b.buyHoldRoi ?? -Infinity) !== (a.buyHoldRoi ?? -Infinity)) {
                return (b.buyHoldRoi ?? -Infinity) - (a.buyHoldRoi ?? -Infinity);
            }
            return b.notional - a.notional;
        });
}

function printPrimitiveTable(title: string, rows: PrimitiveSummary[], limit = 10): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.primitive.padEnd(34)} | execs ${String(row.executions).padStart(5)} | ` +
            `wallets ${String(row.uniqueWallets).padStart(4)} | mkts ${String(row.uniqueMarkets).padStart(3)} | ` +
            `notional ${formatUsd(row.notional).padStart(10)} | ` +
            `roi ${row.buyHoldRoi === null ? 'N/A'.padStart(8) : formatPct(row.buyHoldRoi).padStart(8)} | ` +
            `win ${row.avgBuyWinRate === null ? 'N/A'.padStart(6) : formatPct(row.avgBuyWinRate).padStart(6)}`
        );
    }
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);

    const txByHash = new Map<string, NormalizedTxEvent>();
    const subOneCrossOutcomeTx = new Set<string>();
    for (const tx of txEvents) {
        txByHash.set(tx.txHash.toLowerCase(), tx);
        if (tx.structureLabel !== 'cross_outcome_same_side') continue;
        const cost = bundleCostPerShare(tx);
        if (cost !== null && cost < 1 - BUNDLE_EQ_TOLERANCE) {
            subOneCrossOutcomeTx.add(tx.txHash.toLowerCase());
        }
    }

    const buyExecutions = executions.filter((row) => (row.dominantActionLabel ?? '').startsWith('BUY_'));
    const nonCrossOutcomeSameSide = buyExecutions.filter((row) => row.txStructureLabel !== 'cross_outcome_same_side');
    const sameOutcomeOppositeSide = buyExecutions.filter((row) => row.txStructureLabel === 'same_outcome_opposite_side');
    const subOneCrossOutcomeExecutions = buyExecutions.filter((row) => subOneCrossOutcomeTx.has(row.txHash.toLowerCase()));

    const nonCrossSummaries = buildPrimitiveSummaries(nonCrossOutcomeSameSide).filter((row) => row.executions >= 20);
    const oppositeSideSummaries = buildPrimitiveSummaries(sameOutcomeOppositeSide).filter((row) => row.executions >= 20);
    const subOneSummaries = buildPrimitiveSummaries(subOneCrossOutcomeExecutions).filter((row) => row.executions >= 5);

    console.log(`Loaded ${buyExecutions.length} BUY-dominant normalized executions`);
    console.log(`Loaded ${txEvents.length} normalized tx events`);
    console.log(`Sub-$1.00 cross-outcome bundles: ${subOneCrossOutcomeTx.size}`);
    console.log(`BUY executions outside exact complementary bundles: ${nonCrossOutcomeSameSide.length} (${formatPct(buyExecutions.length > 0 ? nonCrossOutcomeSameSide.length / buyExecutions.length : 0)})`);
    console.log(`BUY executions in same-outcome opposite-side structure: ${sameOutcomeOppositeSide.length} (${formatPct(buyExecutions.length > 0 ? sameOutcomeOppositeSide.length / buyExecutions.length : 0)})`);
    console.log(`BUY executions in sub-$1.00 cross-outcome bundles: ${subOneCrossOutcomeExecutions.length} (${formatPct(buyExecutions.length > 0 ? subOneCrossOutcomeExecutions.length / buyExecutions.length : 0)})`);

    printPrimitiveTable('Top BUY Primitives Outside Cross-Outcome Same-Side', nonCrossSummaries, 12);
    printPrimitiveTable('Top BUY Primitives In Same-Outcome Opposite-Side', oppositeSideSummaries, 12);
    printPrimitiveTable('Top BUY Primitives In Sub-$1.00 Cross-Outcome Bundles', subOneSummaries, 12);

    const keyTargets = [
        'BUY_UNDERDOG | two-sided | 121-210s',
        'BUY_UNDERDOG | two-sided | 31-60s',
        'BUY_UNDERDOG | two-sided | 0-30s',
        'BUY_FAVORITE | two-sided | 61-120s',
    ];

    console.log('\nKey Target Minority Slices');
    for (const target of keyTargets) {
        const outside = nonCrossSummaries.find((row) => row.primitive === target);
        const opposite = oppositeSideSummaries.find((row) => row.primitive === target);
        const subOne = subOneSummaries.find((row) => row.primitive === target);

        console.log(`  ${target}`);
        if (outside) {
            console.log(
                `    outside_cross_outcome_same_side: execs ${outside.executions}, ` +
                `notional ${formatUsd(outside.notional)}, roi ${outside.buyHoldRoi === null ? 'N/A' : formatPct(outside.buyHoldRoi)}`
            );
        }
        if (opposite) {
            console.log(
                `    same_outcome_opposite_side: execs ${opposite.executions}, ` +
                `notional ${formatUsd(opposite.notional)}, roi ${opposite.buyHoldRoi === null ? 'N/A' : formatPct(opposite.buyHoldRoi)}`
            );
        }
        if (subOne) {
            console.log(
                `    sub_$1_bundle: execs ${subOne.executions}, ` +
                `notional ${formatUsd(subOne.notional)}, roi ${subOne.buyHoldRoi === null ? 'N/A' : formatPct(subOne.buyHoldRoi)}`
            );
        }
    }
}

main();
