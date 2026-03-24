/**
 * Primitive and replicability analysis over normalized wallet-execution events.
 *
 * Purpose:
 * - rerun primitive analysis on tx-normalized wallet executions rather than raw
 *   feed rows
 * - surface which primitives stay broad after paired transaction structure is
 *   treated as first-class
 * - score normalized replicability with tx structure included explicitly
 *
 * Usage:
 *   npx tsx src/scripts/wallet-normalized-primitive-report.ts
 *   npx tsx src/scripts/wallet-normalized-primitive-report.ts wallet-wallet-executions.normalized.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-wallet-executions.normalized.jsonl';

type TxStructureLabel =
    | 'single_leg'
    | 'cross_outcome_same_side'
    | 'same_outcome_opposite_side'
    | 'cross_outcome_mixed_side'
    | 'same_outcome_same_side'
    | 'complex';

interface NormalizedWalletExecution {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    wallet: string;
    txHash: string;
    txStructureLabel: TxStructureLabel;
    txRowCount: number;
    txWalletCount: number;
    totalNotional: number;
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    executionStyles: Record<string, number>;
    outsideBookReasonCounts: Record<string, number>;
    matchedSnapshotShare: number;
    avgTradeSecondsBeforeEnd: number | null;
    avgSnapshotDeltaMs: number | null;
    avgRelevantQuoteAgeMs: number | null;
    buyHoldPnl: number;
    buyResolvedWinRate: number | null;
}

interface PrimitiveMetric {
    primitive: string;
    executions: number;
    notional: number;
    uniqueWallets: number;
    uniqueMarkets: number;
    repeatWalletShare: number;
    topWalletShare: number;
    top5WalletShare: number;
    matchedSnapshotShare: number;
    buyHoldPnl: number;
    buyHoldRoi: number | null;
    avgBuyWinRate: number | null;
    executionMix: Record<string, number>;
    structureMix: Record<string, number>;
    outsideBookReasonMix: Record<string, number>;
    avgQuoteAgeMs: number | null;
    avgSnapshotDeltaMs: number | null;
    score: number;
    classification: 'replicable' | 'maybe_replicable' | 'non_replicable';
    blockers: string[];
    notes: string[];
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

function clamp(value: number, min = 0, max = 1): number {
    return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
    return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function mean(values: Array<number | null | undefined>): number | null {
    const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (nums.length === 0) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function formatPct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

function increment(map: Map<string, number>, key: string, amount = 1): void {
    map.set(key, (map.get(key) ?? 0) + amount);
}

function buildPrimitiveMetrics(rows: NormalizedWalletExecution[]): PrimitiveMetric[] {
    const buckets = new Map<string, {
        executions: number;
        notional: number;
        wallets: Set<string>;
        markets: Set<string>;
        walletExecutions: Map<string, number>;
        walletNotional: Map<string, number>;
        matchedSnapshotShares: number[];
        buyHoldPnl: number;
        buyWinRates: number[];
        executionMix: Map<string, number>;
        structureMix: Map<string, number>;
        outsideBookReasonMix: Map<string, number>;
        quoteAges: number[];
        snapshotDeltas: number[];
    }>();

    for (const row of rows) {
        const primitive = row.dominantPrimitiveKey ?? 'UNKNOWN';
        const wallet = row.wallet.toLowerCase();
        const market = row.marketSlug ?? 'unknown-market';

        if (!buckets.has(primitive)) {
            buckets.set(primitive, {
                executions: 0,
                notional: 0,
                wallets: new Set<string>(),
                markets: new Set<string>(),
                walletExecutions: new Map<string, number>(),
                walletNotional: new Map<string, number>(),
                matchedSnapshotShares: [],
                buyHoldPnl: 0,
                buyWinRates: [],
                executionMix: new Map<string, number>(),
                structureMix: new Map<string, number>(),
                outsideBookReasonMix: new Map<string, number>(),
                quoteAges: [],
                snapshotDeltas: [],
            });
        }

        const bucket = buckets.get(primitive)!;
        bucket.executions++;
        bucket.notional += row.totalNotional;
        bucket.wallets.add(wallet);
        bucket.markets.add(market);
        bucket.walletExecutions.set(wallet, (bucket.walletExecutions.get(wallet) ?? 0) + 1);
        bucket.walletNotional.set(wallet, (bucket.walletNotional.get(wallet) ?? 0) + row.totalNotional);
        bucket.matchedSnapshotShares.push(row.matchedSnapshotShare);
        bucket.buyHoldPnl += row.buyHoldPnl;
        if (row.buyResolvedWinRate !== null) bucket.buyWinRates.push(row.buyResolvedWinRate);
        if (row.avgRelevantQuoteAgeMs !== null) bucket.quoteAges.push(row.avgRelevantQuoteAgeMs);
        if (row.avgSnapshotDeltaMs !== null) bucket.snapshotDeltas.push(row.avgSnapshotDeltaMs);

        for (const [style, count] of Object.entries(row.executionStyles ?? {})) {
            increment(bucket.executionMix, style, count);
        }
        increment(bucket.structureMix, row.txStructureLabel, 1);
        for (const [reason, count] of Object.entries(row.outsideBookReasonCounts ?? {})) {
            increment(bucket.outsideBookReasonMix, reason, count);
        }
    }

    return [...buckets.entries()]
        .map(([primitive, bucket]) => {
            const walletTotals = [...bucket.walletNotional.values()].sort((a, b) => b - a);
            const uniqueWallets = bucket.wallets.size;
            const repeatWallets = [...bucket.walletExecutions.values()].filter((count) => count >= 2).length;
            const totalStyles = [...bucket.executionMix.values()].reduce((sum, value) => sum + value, 0) || 1;
            const totalStructures = [...bucket.structureMix.values()].reduce((sum, value) => sum + value, 0) || 1;
            const totalOutsideReasons = [...bucket.outsideBookReasonMix.values()].reduce((sum, value) => sum + value, 0) || 1;
            const executionMix = Object.fromEntries([...bucket.executionMix.entries()].map(([key, value]) => [key, value / totalStyles]));
            const structureMix = Object.fromEntries([...bucket.structureMix.entries()].map(([key, value]) => [key, value / totalStructures]));
            const outsideBookReasonMix = Object.fromEntries([...bucket.outsideBookReasonMix.entries()].map(([key, value]) => [key, value / totalOutsideReasons]));

            const metric: PrimitiveMetric = {
                primitive,
                executions: bucket.executions,
                notional: bucket.notional,
                uniqueWallets,
                uniqueMarkets: bucket.markets.size,
                repeatWalletShare: uniqueWallets > 0 ? repeatWallets / uniqueWallets : 0,
                topWalletShare: bucket.notional > 0 ? (walletTotals[0] ?? 0) / bucket.notional : 0,
                top5WalletShare: bucket.notional > 0 ? walletTotals.slice(0, 5).reduce((sum, value) => sum + value, 0) / bucket.notional : 0,
                matchedSnapshotShare: average(bucket.matchedSnapshotShares),
                buyHoldPnl: bucket.buyHoldPnl,
                buyHoldRoi: bucket.notional > 0 ? bucket.buyHoldPnl / bucket.notional : null,
                avgBuyWinRate: bucket.buyWinRates.length > 0 ? average(bucket.buyWinRates) : null,
                executionMix,
                structureMix,
                outsideBookReasonMix,
                avgQuoteAgeMs: mean(bucket.quoteAges),
                avgSnapshotDeltaMs: mean(bucket.snapshotDeltas),
                score: 0,
                classification: 'non_replicable',
                blockers: [],
                notes: [],
            };

            const timingBucket = primitive.split(' | ')[2] ?? 'unknown';
            const regime = primitive.split(' | ')[1] ?? 'unknown';
            const nearAskShare = executionMix.near_ask ?? 0;
            const insideSpreadShare = executionMix.inside_spread ?? 0;
            const outsideBookShare = executionMix.outside_book ?? 0;
            const crossOutcomeSameSideShare = structureMix.cross_outcome_same_side ?? 0;
            const sameOutcomeOppositeSideShare = structureMix.same_outcome_opposite_side ?? 0;
            const crossOutcomeMixedSideShare = structureMix.cross_outcome_mixed_side ?? 0;
            const priceImprovedShare = outsideBookReasonMix.price_improved ?? 0;
            const worseThanVisibleShare = outsideBookReasonMix.worse_than_visible ?? 0;

            const breadthScore = average([
                clamp(metric.uniqueWallets / 220),
                clamp(metric.uniqueMarkets / 8),
                clamp(metric.repeatWalletShare / 0.3),
                1 - clamp(metric.topWalletShare / 0.35),
                1 - clamp(metric.top5WalletShare / 0.75),
            ]);

            const timingScore = timingBucket === '121-210s' ? 1
                : timingBucket === '61-120s' ? 0.85
                : timingBucket === '31-60s' ? 0.65
                : timingBucket === '0-30s' ? 0.4
                : 0.25;

            const structureScore = average([
                1 - clamp(crossOutcomeSameSideShare / 0.95),
                clamp(sameOutcomeOppositeSideShare / 0.25),
                1 - clamp(crossOutcomeMixedSideShare / 0.35),
            ]);

            const executionScore = average([
                nearAskShare,
                clamp(insideSpreadShare / 0.4),
                clamp(priceImprovedShare / 0.7),
                1 - clamp(worseThanVisibleShare / 0.7),
                regime === 'two-sided' ? 1 : regime === 'one-sided' ? 0.35 : 0.2,
            ]);

            const edgeScore = average([
                clamp(((metric.buyHoldRoi ?? -1) + 0.1) / 0.35),
                metric.avgBuyWinRate !== null ? clamp((metric.avgBuyWinRate - 0.4) / 0.2) : 0,
                clamp(metric.executions / 1500),
            ]);

            let score = (
                0.3 * breadthScore +
                0.2 * timingScore +
                0.2 * structureScore +
                0.15 * executionScore +
                0.15 * edgeScore
            );

            const blockers: string[] = [];
            const notes: string[] = [];

            if (timingBucket === '0-30s') blockers.push('late_latency_sensitive');
            if (regime === 'one-sided') blockers.push('one_sided_regime');
            if (metric.uniqueMarkets < 4) blockers.push('thin_market_coverage');
            if (metric.buyHoldRoi !== null && metric.buyHoldRoi < 0) blockers.push('negative_hold_proxy');
            if (crossOutcomeSameSideShare > 0.7) blockers.push('paired_cross_outcome_dominant');
            if (worseThanVisibleShare > 0.55) blockers.push('worse_than_visible_heavy');

            if (priceImprovedShare >= 0.55) notes.push('outside_book_often_improved');
            if (metric.topWalletShare <= 0.12) notes.push('low_single_wallet_dominance');
            if (metric.repeatWalletShare >= 0.22) notes.push('repeat_wallet_presence');
            if (regime === 'two-sided') notes.push('two_sided_regime');
            if (sameOutcomeOppositeSideShare >= 0.1) notes.push('has_direct_match_component');
            if (metric.avgQuoteAgeMs !== null && metric.avgQuoteAgeMs <= 250) notes.push('fresh_quote_context');

            if (blockers.includes('late_latency_sensitive')) score -= 0.1;
            if (blockers.includes('one_sided_regime')) score -= 0.2;
            if (blockers.includes('negative_hold_proxy')) score -= 0.2;
            if (blockers.includes('paired_cross_outcome_dominant')) score -= 0.1;
            if (blockers.includes('worse_than_visible_heavy')) score -= 0.1;

            score = clamp(score);

            let classification: PrimitiveMetric['classification'] = 'non_replicable';
            const hardBlockers = blockers.filter((blocker) => blocker !== 'paired_cross_outcome_dominant');
            if (score >= 0.7 && hardBlockers.length === 0) classification = 'replicable';
            else if (score >= 0.5) classification = 'maybe_replicable';

            metric.score = score;
            metric.classification = classification;
            metric.blockers = blockers;
            metric.notes = notes;

            return metric;
        })
        .filter((row) => row.executions >= 50)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.notional - a.notional;
        });
}

function formatMix(mix: Record<string, number>, keys: string[]): string {
    return keys
        .filter((key) => (mix[key] ?? 0) > 0)
        .map((key) => `${key}:${formatPct(mix[key] ?? 0)}`)
        .join(', ');
}

function printRow(row: PrimitiveMetric): void {
    console.log(
        `  ${row.classification.padEnd(17)} | score ${row.score.toFixed(2)} | ${row.primitive.padEnd(34)} | ` +
        `execs ${String(row.executions).padStart(5)} | mkts ${String(row.uniqueMarkets).padStart(3)} | wallets ${String(row.uniqueWallets).padStart(4)} | ` +
        `roi ${row.buyHoldRoi === null ? 'N/A'.padStart(8) : formatPct(row.buyHoldRoi).padStart(8)} | ` +
        `top1 ${formatPct(row.topWalletShare).padStart(6)}`
    );
    console.log(`    structures: ${formatMix(row.structureMix, ['cross_outcome_same_side', 'same_outcome_opposite_side', 'cross_outcome_mixed_side', 'single_leg']) || 'none'}`);
    console.log(`    execution: ${formatMix(row.executionMix, ['near_ask', 'inside_spread', 'outside_book', 'near_bid']) || 'none'}`);
    if (Object.keys(row.outsideBookReasonMix).length > 0) {
        console.log(`    outside_book: ${formatMix(row.outsideBookReasonMix, ['price_improved', 'worse_than_visible', 'ambiguous'])}`);
    }
    if (row.notes.length > 0) console.log(`    notes: ${row.notes.join(', ')}`);
    if (row.blockers.length > 0) console.log(`    blockers: ${row.blockers.join(', ')}`);
}

function main(): void {
    const rows = loadJsonl<NormalizedWalletExecution>(INPUT);
    const buyRows = rows.filter((row) => row.dominantActionLabel?.startsWith('BUY_'));
    const metrics = buildPrimitiveMetrics(buyRows);

    console.log(`Loaded ${rows.length} normalized wallet executions from ${INPUT}`);
    console.log(`BUY-dominant executions used: ${buyRows.length}`);

    const replicable = metrics.filter((row) => row.classification === 'replicable');
    const maybe = metrics.filter((row) => row.classification === 'maybe_replicable');
    const nonReplicable = metrics.filter((row) => row.classification === 'non_replicable');

    console.log('\nReplicable Normalized Primitives');
    if (replicable.length === 0) console.log('  none yet');
    else for (const row of replicable.slice(0, 10)) printRow(row);

    console.log('\nMaybe Replicable Normalized Primitives');
    for (const row of maybe.slice(0, 12)) printRow(row);

    console.log('\nHighest-Risk Normalized Primitives');
    for (const row of nonReplicable.slice(0, 10)) printRow(row);

    console.log('\nSummary');
    console.log(`  replicable: ${replicable.length}`);
    console.log(`  maybe_replicable: ${maybe.length}`);
    console.log(`  non_replicable: ${nonReplicable.length}`);

    const twoSidedUnderdog = metrics
        .filter((row) => row.primitive.startsWith('BUY_UNDERDOG | two-sided'))
        .sort((a, b) => b.score - a.score);

    if (twoSidedUnderdog[0]) {
        console.log(
            `  top normalized two-sided underdog: ${twoSidedUnderdog[0].primitive} | ` +
            `score ${twoSidedUnderdog[0].score.toFixed(2)} | ` +
            `roi ${twoSidedUnderdog[0].buyHoldRoi === null ? 'N/A' : formatPct(twoSidedUnderdog[0].buyHoldRoi)}`
        );
    }

    const rawCandidate = metrics.find((row) => row.primitive === 'BUY_FAVORITE | one-sided | 61-120s');
    if (rawCandidate) {
        console.log(
            `  reference favorite flow: ${rawCandidate.primitive} | ` +
            `score ${rawCandidate.score.toFixed(2)} | ` +
            `structures ${formatMix(rawCandidate.structureMix, ['cross_outcome_same_side', 'same_outcome_opposite_side', 'cross_outcome_mixed_side'])}`
        );
    }
}

main();
