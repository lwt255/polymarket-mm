/**
 * Primitive replicability report over enriched wallet trades.
 *
 * Purpose:
 * - score late-window BUY primitives on structure, breadth, timing, and likely
 *   execution feasibility
 * - keep the analysis centered on "can we build this ourselves?" rather than
 *   "which wallet should we follow?"
 *
 * Important:
 * - this is a provisional replicability filter, not a trading model
 * - any promising primitive still needs forward validation across more days
 *
 * Usage:
 *   npx tsx src/scripts/wallet-primitive-replicability-report.ts
 *   npx tsx src/scripts/wallet-primitive-replicability-report.ts wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';

interface EnrichedTrade {
    crypto: string;
    interval: number;
    proxyWallet: string;
    marketSlug: string | null;
    side: 'BUY' | 'SELL';
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    buyResolvedWin: boolean | null;
    buyHoldToResolutionPnl: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
        priceContext?: {
            likelyExecutionStyle?: string;
        } | null;
    };
}

interface PrimitiveMetric {
    primitive: string;
    trades: number;
    notional: number;
    uniqueWallets: number;
    uniqueMarkets: number;
    repeatWalletShare: number;
    topWalletShare: number;
    top5WalletShare: number;
    matchedSnapshotShare: number;
    resolvedBuyTrades: number;
    buyWinRate: number | null;
    buyHoldPnl: number;
    buyHoldRoi: number | null;
    executionMix: Record<string, number>;
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

function formatPct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function formatUsd(value: number): string {
    return `$${value.toFixed(2)}`;
}

function secondsBucket(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
    if (seconds > 210) return '>210s';
    if (seconds > 120) return '121-210s';
    if (seconds > 60) return '61-120s';
    if (seconds > 30) return '31-60s';
    if (seconds >= 0) return '0-30s';
    return 'after_end';
}

function primitiveKey(trade: EnrichedTrade): string {
    return [
        trade.enrichment?.walletActionLabel ?? 'UNKNOWN',
        trade.enrichment?.regimeLabels?.t60State ?? 'unknown',
        secondsBucket(trade.tradeSecondsBeforeEnd),
    ].join(' | ');
}

function clamp(value: number, min = 0, max = 1): number {
    return Math.max(min, Math.min(max, value));
}

function average(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function buildPrimitiveMetrics(trades: EnrichedTrade[]): PrimitiveMetric[] {
    const buckets = new Map<string, {
        trades: number;
        notional: number;
        wallets: Set<string>;
        markets: Set<string>;
        walletTrades: Map<string, number>;
        walletNotional: Map<string, number>;
        matchedSnapshot: number;
        resolvedBuyTrades: number;
        buyWins: number;
        buyHoldPnl: number;
        executionMix: Map<string, number>;
    }>();

    for (const trade of trades) {
        if (trade.side !== 'BUY') continue;

        const primitive = primitiveKey(trade);
        const wallet = trade.proxyWallet.toLowerCase();
        const market = trade.marketSlug ?? 'unknown-market';
        const executionStyle = trade.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown';

        if (!buckets.has(primitive)) {
            buckets.set(primitive, {
                trades: 0,
                notional: 0,
                wallets: new Set<string>(),
                markets: new Set<string>(),
                walletTrades: new Map<string, number>(),
                walletNotional: new Map<string, number>(),
                matchedSnapshot: 0,
                resolvedBuyTrades: 0,
                buyWins: 0,
                buyHoldPnl: 0,
                executionMix: new Map<string, number>(),
            });
        }

        const bucket = buckets.get(primitive)!;
        bucket.trades++;
        bucket.notional += trade.notional;
        bucket.wallets.add(wallet);
        bucket.markets.add(market);
        bucket.walletTrades.set(wallet, (bucket.walletTrades.get(wallet) ?? 0) + 1);
        bucket.walletNotional.set(wallet, (bucket.walletNotional.get(wallet) ?? 0) + trade.notional);
        if (trade.enrichment?.matchedSnapshot) bucket.matchedSnapshot++;
        bucket.executionMix.set(executionStyle, (bucket.executionMix.get(executionStyle) ?? 0) + 1);

        if (trade.buyResolvedWin !== null && trade.buyHoldToResolutionPnl !== null) {
            bucket.resolvedBuyTrades++;
            if (trade.buyResolvedWin) bucket.buyWins++;
            bucket.buyHoldPnl += trade.buyHoldToResolutionPnl;
        }
    }

    return [...buckets.entries()]
        .map(([primitive, bucket]) => {
            const walletTotals = [...bucket.walletNotional.values()].sort((a, b) => b - a);
            const repeatWallets = [...bucket.walletTrades.values()].filter((count) => count >= 2).length;
            const uniqueWallets = bucket.wallets.size;
            const top5Share = bucket.notional > 0
                ? walletTotals.slice(0, 5).reduce((sum, value) => sum + value, 0) / bucket.notional
                : 0;

            const metric: PrimitiveMetric = {
                primitive,
                trades: bucket.trades,
                notional: bucket.notional,
                uniqueWallets,
                uniqueMarkets: bucket.markets.size,
                repeatWalletShare: uniqueWallets > 0 ? repeatWallets / uniqueWallets : 0,
                topWalletShare: bucket.notional > 0 ? (walletTotals[0] ?? 0) / bucket.notional : 0,
                top5WalletShare: top5Share,
                matchedSnapshotShare: bucket.trades > 0 ? bucket.matchedSnapshot / bucket.trades : 0,
                resolvedBuyTrades: bucket.resolvedBuyTrades,
                buyWinRate: bucket.resolvedBuyTrades > 0 ? bucket.buyWins / bucket.resolvedBuyTrades : null,
                buyHoldPnl: bucket.buyHoldPnl,
                buyHoldRoi: bucket.notional > 0 ? bucket.buyHoldPnl / bucket.notional : null,
                executionMix: Object.fromEntries(bucket.executionMix.entries()),
                score: 0,
                classification: 'non_replicable',
                blockers: [],
                notes: [],
            };

            const timingBucket = primitive.split(' | ')[2] ?? 'unknown';
            const regime = primitive.split(' | ')[1] ?? 'unknown';
            const styleCounts = metric.executionMix;
            const totalStyles = Object.values(styleCounts).reduce((sum, value) => sum + value, 0) || 1;
            const nearAskShare = (styleCounts.near_ask ?? 0) / totalStyles;
            const insideSpreadShare = (styleCounts.inside_spread ?? 0) / totalStyles;
            const outsideBookShare = (styleCounts.outside_book ?? 0) / totalStyles;

            const breadthScore = average([
                clamp(metric.uniqueWallets / 250),
                clamp(metric.uniqueMarkets / 8),
                clamp(metric.repeatWalletShare / 0.3),
                1 - clamp(metric.topWalletShare / 0.35),
                1 - clamp(metric.top5WalletShare / 0.75),
            ]);

            const observabilityScore = average([
                metric.matchedSnapshotShare,
                timingBucket === '121-210s' ? 1
                    : timingBucket === '61-120s' ? 0.85
                    : timingBucket === '31-60s' ? 0.65
                    : timingBucket === '0-30s' ? 0.4
                    : 0.25,
            ]);

            const executionScore = average([
                nearAskShare,
                clamp(insideSpreadShare / 0.5),
                1 - clamp(outsideBookShare / 0.5),
                regime === 'two-sided' ? 1 : regime === 'one-sided' ? 0.35 : 0.2,
            ]);

            const edgeScore = average([
                clamp(((metric.buyHoldRoi ?? -1) + 0.1) / 0.35),
                metric.buyWinRate !== null ? clamp((metric.buyWinRate - 0.4) / 0.2) : 0,
                clamp(metric.resolvedBuyTrades / 1500),
            ]);

            let score = (
                0.35 * breadthScore +
                0.3 * observabilityScore +
                0.2 * executionScore +
                0.15 * edgeScore
            );

            const blockers: string[] = [];
            const notes: string[] = [];

            if (metric.matchedSnapshotShare < 0.8) blockers.push('partial_snapshot_coverage');
            if (timingBucket === '0-30s') blockers.push('late_latency_sensitive');
            if (outsideBookShare > 0.35) blockers.push('outside_book_heavy');
            if (regime === 'one-sided') blockers.push('one_sided_regime');
            if (metric.uniqueMarkets < 4) blockers.push('thin_market_coverage');
            if (metric.buyHoldRoi !== null && metric.buyHoldRoi < 0) blockers.push('negative_hold_proxy');

            if (nearAskShare >= 0.6) notes.push('mostly_visible_taker_entries');
            if (insideSpreadShare >= 0.25) notes.push('possible_passive_or_improved_execution');
            if (metric.topWalletShare <= 0.12) notes.push('low_single_wallet_dominance');
            if (metric.repeatWalletShare >= 0.22) notes.push('repeat_wallet_presence');
            if (regime === 'two-sided') notes.push('two_sided_regime');

            if (blockers.includes('late_latency_sensitive')) score -= 0.1;
            if (blockers.includes('outside_book_heavy')) score -= 0.15;
            if (blockers.includes('one_sided_regime')) score -= 0.2;
            if (blockers.includes('negative_hold_proxy')) score -= 0.2;

            score = clamp(score);

            let classification: PrimitiveMetric['classification'] = 'non_replicable';
            if (score >= 0.7 && blockers.filter((blocker) => blocker !== 'late_latency_sensitive').length === 0) {
                classification = 'replicable';
            } else if (score >= 0.5) {
                classification = 'maybe_replicable';
            }

            metric.score = score;
            metric.classification = classification;
            metric.blockers = blockers;
            metric.notes = notes;

            return metric;
        })
        .filter((row) => row.trades >= 50 && row.resolvedBuyTrades >= 50)
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            return b.notional - a.notional;
        });
}

function printMetric(row: PrimitiveMetric): void {
    const executionSummary = Object.entries(row.executionMix)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([style, count]) => `${style}:${count}`)
        .join(', ');

    console.log(
        `  ${row.classification.padEnd(17)} | score ${row.score.toFixed(2)} | ${row.primitive.padEnd(34)} | ` +
        `trades ${String(row.trades).padStart(5)} | mkts ${String(row.uniqueMarkets).padStart(3)} | wallets ${String(row.uniqueWallets).padStart(4)} | ` +
        `win ${row.buyWinRate === null ? 'N/A '.padStart(6) : formatPct(row.buyWinRate).padStart(6)} | ` +
        `roi ${row.buyHoldRoi === null ? 'N/A '.padStart(8) : formatPct(row.buyHoldRoi).padStart(8)} | ` +
        `top1 ${formatPct(row.topWalletShare).padStart(6)} | snap ${formatPct(row.matchedSnapshotShare).padStart(6)}`
    );
    console.log(`    execution: ${executionSummary || 'none'}`);
    if (row.notes.length > 0) console.log(`    notes: ${row.notes.join(', ')}`);
    if (row.blockers.length > 0) console.log(`    blockers: ${row.blockers.join(', ')}`);
}

function main(): void {
    const trades = loadJsonl<EnrichedTrade>(INPUT);
    const matchedLateBuys = trades.filter((trade) => trade.side === 'BUY' && trade.enrichment?.matchedSnapshot);
    const metrics = buildPrimitiveMetrics(matchedLateBuys);

    console.log(`Loaded ${trades.length} enriched trades from ${INPUT}`);
    console.log(`Matched BUY trades used: ${matchedLateBuys.length}`);

    const replicable = metrics.filter((row) => row.classification === 'replicable');
    const maybe = metrics.filter((row) => row.classification === 'maybe_replicable');
    const nonReplicable = metrics.filter((row) => row.classification === 'non_replicable');

    console.log('\nReplicable Primitives');
    if (replicable.length === 0) {
        console.log('  none yet');
    } else {
        for (const row of replicable.slice(0, 10)) printMetric(row);
    }

    console.log('\nMaybe Replicable Primitives');
    for (const row of maybe.slice(0, 12)) printMetric(row);

    console.log('\nHighest-Risk / Likely Non-Replicable Primitives');
    for (const row of nonReplicable.slice(0, 10)) printMetric(row);

    console.log('\nSummary');
    console.log(`  replicable: ${replicable.length}`);
    console.log(`  maybe_replicable: ${maybe.length}`);
    console.log(`  non_replicable: ${nonReplicable.length}`);

    const strongestMaybe = maybe.find((row) => row.primitive.startsWith('BUY_UNDERDOG | two-sided'));
    if (strongestMaybe) {
        console.log(
            `  best two-sided underdog candidate: ${strongestMaybe.primitive} | ` +
            `score ${strongestMaybe.score.toFixed(2)} | roi ${strongestMaybe.buyHoldRoi === null ? 'N/A' : formatPct(strongestMaybe.buyHoldRoi)}`
        );
    }

    const strongestReplicable = replicable[0];
    if (strongestReplicable) {
        console.log(
            `  top replicable candidate: ${strongestReplicable.primitive} | ` +
            `score ${strongestReplicable.score.toFixed(2)} | ${formatUsd(strongestReplicable.buyHoldPnl)} buy-hold proxy`
        );
    }
}

main();
