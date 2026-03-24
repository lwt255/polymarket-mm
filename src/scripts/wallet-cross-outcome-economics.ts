/**
 * Economic characterization of cross-outcome same-side tx structures.
 *
 * Purpose:
 * - determine whether dominant paired tx structures are mostly exact
 *   complementary bundles
 * - show which primitive pairs co-occur inside those bundles
 * - separate actionable directional behavior from venue-level pairing artifacts
 *
 * Usage:
 *   npx tsx src/scripts/wallet-cross-outcome-economics.ts
 *   npx tsx src/scripts/wallet-cross-outcome-economics.ts wallet-tx-events.normalized.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-tx-events.normalized.jsonl';
const BUNDLE_EQ_TOLERANCE = 0.0001;

interface NormalizedLeg {
    wallet: string;
    side: 'BUY' | 'SELL';
    outcome: string | null;
    trades: number;
    totalSize: number;
    totalNotional: number;
    averagePrice: number;
    dominantPrimitiveKey: string | null;
}

interface NormalizedTxEvent {
    txHash: string;
    structureLabel: string;
    marketSlug: string | null;
    crypto: string;
    interval: number;
    legs: NormalizedLeg[];
}

interface BundleSummary {
    txHash: string;
    primitivePairKey: string;
    legCount: number;
    exactTwoLeg: boolean;
    totalUpSize: number;
    totalDownSize: number;
    sizeRatio: number;
    bundleCostPerShare: number | null;
    underOne: boolean;
    exactlyOne: boolean;
    overOne: boolean;
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

function formatNum(value: number): string {
    return value.toFixed(4);
}

function canonicalPair(parts: string[]): string {
    return [...parts].sort((a, b) => a.localeCompare(b)).join('  <->  ');
}

function summarizeCrossOutcomeBundles(rows: NormalizedTxEvent[]): BundleSummary[] {
    const summaries: BundleSummary[] = [];

    for (const tx of rows.filter((row) => row.structureLabel === 'cross_outcome_same_side')) {
        const upLegs = tx.legs.filter((leg) => String(leg.outcome ?? '').toUpperCase() === 'UP');
        const downLegs = tx.legs.filter((leg) => String(leg.outcome ?? '').toUpperCase() === 'DOWN');
        if (upLegs.length === 0 || downLegs.length === 0) continue;

        const totalUpSize = upLegs.reduce((sum, leg) => sum + leg.totalSize, 0);
        const totalDownSize = downLegs.reduce((sum, leg) => sum + leg.totalSize, 0);
        const sizeRatio = Math.min(totalUpSize, totalDownSize) / Math.max(totalUpSize, totalDownSize);
        const totalNotional = tx.legs.reduce((sum, leg) => sum + leg.totalNotional, 0);
        const bundleCostPerShare = totalUpSize > 0 && totalDownSize > 0
            ? totalNotional / Math.max(totalUpSize, totalDownSize)
            : null;

        const primitivePairKey = canonicalPair(
            tx.legs.map((leg) => leg.dominantPrimitiveKey ?? 'UNKNOWN'),
        );

        summaries.push({
            txHash: tx.txHash,
            primitivePairKey,
            legCount: tx.legs.length,
            exactTwoLeg: tx.legs.length === 2,
            totalUpSize,
            totalDownSize,
            sizeRatio,
            bundleCostPerShare,
            underOne: bundleCostPerShare !== null && bundleCostPerShare < 1 - BUNDLE_EQ_TOLERANCE,
            exactlyOne: bundleCostPerShare !== null && Math.abs(bundleCostPerShare - 1) <= BUNDLE_EQ_TOLERANCE,
            overOne: bundleCostPerShare !== null && bundleCostPerShare > 1 + BUNDLE_EQ_TOLERANCE,
        });
    }

    return summaries;
}

function main(): void {
    const txEvents = loadJsonl<NormalizedTxEvent>(INPUT);
    const bundles = summarizeCrossOutcomeBundles(txEvents);

    const exactTwoLeg = bundles.filter((bundle) => bundle.exactTwoLeg);
    const exactSize = bundles.filter((bundle) => bundle.sizeRatio > 0.999);
    const exactlyOne = bundles.filter((bundle) => bundle.exactlyOne);
    const underOne = bundles.filter((bundle) => bundle.underOne);
    const overOne = bundles.filter((bundle) => bundle.overOne);

    console.log(`Loaded ${txEvents.length} normalized tx events from ${INPUT}`);
    console.log(`Cross-outcome same-side bundles: ${bundles.length}`);
    console.log(`  exact two-leg: ${exactTwoLeg.length} (${formatPct(bundles.length > 0 ? exactTwoLeg.length / bundles.length : 0)})`);
    console.log(`  exact size match: ${exactSize.length} (${formatPct(bundles.length > 0 ? exactSize.length / bundles.length : 0)})`);
    console.log(`  bundle cost == 1: ${exactlyOne.length} (${formatPct(bundles.length > 0 ? exactlyOne.length / bundles.length : 0)})`);
    console.log(`  bundle cost < 1: ${underOne.length} (${formatPct(bundles.length > 0 ? underOne.length / bundles.length : 0)})`);
    console.log(`  bundle cost > 1: ${overOne.length} (${formatPct(bundles.length > 0 ? overOne.length / bundles.length : 0)})`);

    const usableCosts = bundles
        .map((bundle) => bundle.bundleCostPerShare)
        .filter((value): value is number => value !== null && Number.isFinite(value))
        .sort((a, b) => a - b);
    const meanCost = usableCosts.reduce((sum, value) => sum + value, 0) / Math.max(usableCosts.length, 1);
    const medianCost = usableCosts[Math.floor(usableCosts.length / 2)] ?? null;
    console.log(`  mean bundle cost/share: ${formatNum(meanCost)}`);
    console.log(`  median bundle cost/share: ${medianCost === null ? 'N/A' : formatNum(medianCost)}`);

    const pairCounts = new Map<string, number>();
    for (const bundle of bundles) {
        pairCounts.set(bundle.primitivePairKey, (pairCounts.get(bundle.primitivePairKey) ?? 0) + 1);
    }

    console.log('\nTop Primitive Pairings Inside Cross-Outcome Same-Side Bundles');
    for (const [pair, count] of [...pairCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) {
        console.log(`  ${pair} -> ${count}`);
    }

    const targets = [
        'BUY_UNDERDOG | two-sided | 121-210s',
        'BUY_UNDERDOG | two-sided | 31-60s',
        'BUY_UNDERDOG | two-sided | 0-30s',
        'BUY_FAVORITE | one-sided | 61-120s',
    ];

    console.log('\nTarget Primitive Bundle Characterization');
    for (const target of targets) {
        const subset = bundles.filter((bundle) => bundle.primitivePairKey.includes(target));
        const counterpartCounts = new Map<string, number>();

        for (const bundle of subset) {
            const parts = bundle.primitivePairKey.split('  <->  ');
            for (const part of parts) {
                if (part !== target) {
                    counterpartCounts.set(part, (counterpartCounts.get(part) ?? 0) + 1);
                }
            }
        }

        const topCounterpart = [...counterpartCounts.entries()].sort((a, b) => b[1] - a[1])[0];
        const subsetCosts = subset
            .map((bundle) => bundle.bundleCostPerShare)
            .filter((value): value is number => value !== null && Number.isFinite(value));
        const meanSubsetCost = subsetCosts.reduce((sum, value) => sum + value, 0) / Math.max(subsetCosts.length, 1);

        console.log(`  ${target}`);
        console.log(`    bundles: ${subset.length}`);
        console.log(`    exact_size: ${formatPct(subset.length > 0 ? subset.filter((bundle) => bundle.sizeRatio > 0.999).length / subset.length : 0)}`);
        console.log(`    cost_eq_1: ${formatPct(subset.length > 0 ? subset.filter((bundle) => bundle.exactlyOne).length / subset.length : 0)}`);
        console.log(`    cost_lt_1: ${formatPct(subset.length > 0 ? subset.filter((bundle) => bundle.underOne).length / subset.length : 0)}`);
        console.log(`    mean_bundle_cost/share: ${formatNum(meanSubsetCost)}`);
        if (topCounterpart) {
            console.log(`    top_counterpart: ${topCounterpart[0]} (${topCounterpart[1]})`);
        }
    }

    const underOneExamples = bundles
        .filter((bundle) => bundle.underOne)
        .sort((a, b) => (a.bundleCostPerShare ?? 1) - (b.bundleCostPerShare ?? 1))
        .slice(0, 5);

    if (underOneExamples.length > 0) {
        console.log('\nSub-1 Bundle Examples');
        for (const bundle of underOneExamples) {
            console.log(`  ${bundle.txHash} | cost/share ${bundle.bundleCostPerShare?.toFixed(6)} | pair ${bundle.primitivePairKey}`);
        }
    }
}

main();
