/**
 * Primitive and cohort analysis over enriched wallet trades.
 *
 * Purpose:
 * - identify recurring behavior primitives with breadth across wallets/markets
 * - measure whether a primitive is broad structure or dominated by a few wallets
 * - group wallets by their dominant primitive without making wallet ranking the
 *   center of gravity
 *
 * Usage:
 *   npx tsx src/scripts/wallet-primitive-analysis.ts
 *   npx tsx src/scripts/wallet-primitive-analysis.ts wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';
const MIN_COHORT_TRADES = 5;
const MIN_COHORT_MARKETS = 2;

interface EnrichedTrade {
    crypto: string;
    interval: number;
    proxyWallet: string;
    marketSlug: string | null;
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        nearestSnapshotMatchedSummary?: {
            snapshotState?: string;
        } | null;
        regimeLabels?: {
            t60State?: string;
            firstOneSidedBucket?: string;
        } | null;
        priceContext?: {
            likelyExecutionStyle?: string;
        } | null;
    };
}

interface PrimitiveMetric {
    key: string;
    trades: number;
    notional: number;
    uniqueWallets: number;
    uniqueMarkets: number;
    repeatWallets: number;
    repeatWalletShare: number;
    topWalletShare: number;
    top5WalletShare: number;
    marketsPerWallet: number;
}

interface WalletSummary {
    wallet: string;
    trades: number;
    notional: number;
    markets: Set<string>;
    primitiveNotional: Map<string, number>;
}

interface CohortMetric {
    primitive: string;
    wallets: number;
    totalTrades: number;
    totalNotional: number;
    avgMarketsPerWallet: number;
    avgPurity: number;
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

function coarsePrimitive(trade: EnrichedTrade): string {
    return [
        trade.enrichment?.walletActionLabel ?? 'UNKNOWN',
        trade.enrichment?.regimeLabels?.t60State ?? 'unknown',
        secondsBucket(trade.tradeSecondsBeforeEnd),
    ].join(' | ');
}

function finePrimitive(trade: EnrichedTrade): string {
    return [
        coarsePrimitive(trade),
        trade.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown',
        `${trade.crypto.toUpperCase()} ${trade.interval}m`,
    ].join(' | ');
}

function aggregatePrimitives(trades: EnrichedTrade[], keyFn: (trade: EnrichedTrade) => string): PrimitiveMetric[] {
    const buckets = new Map<string, {
        trades: number;
        notional: number;
        walletNotional: Map<string, number>;
        walletMarkets: Map<string, Set<string>>;
        markets: Set<string>;
    }>();

    for (const trade of trades) {
        const key = keyFn(trade);
        const wallet = trade.proxyWallet.toLowerCase();
        const market = trade.marketSlug ?? 'unknown-market';

        if (!buckets.has(key)) {
            buckets.set(key, {
                trades: 0,
                notional: 0,
                walletNotional: new Map<string, number>(),
                walletMarkets: new Map<string, Set<string>>(),
                markets: new Set<string>(),
            });
        }

        const bucket = buckets.get(key)!;
        bucket.trades++;
        bucket.notional += trade.notional;
        bucket.markets.add(market);
        bucket.walletNotional.set(wallet, (bucket.walletNotional.get(wallet) ?? 0) + trade.notional);
        if (!bucket.walletMarkets.has(wallet)) {
            bucket.walletMarkets.set(wallet, new Set<string>());
        }
        bucket.walletMarkets.get(wallet)!.add(market);
    }

    return [...buckets.entries()]
        .map(([key, bucket]) => {
            const walletTotals = [...bucket.walletNotional.values()].sort((a, b) => b - a);
            const totalNotional = bucket.notional || 1;
            const repeatWallets = [...bucket.walletMarkets.values()].filter((markets) => markets.size >= 2).length;
            const uniqueWallets = bucket.walletNotional.size;
            const marketsPerWallet = uniqueWallets > 0
                ? [...bucket.walletMarkets.values()].reduce((sum, markets) => sum + markets.size, 0) / uniqueWallets
                : 0;

            return {
                key,
                trades: bucket.trades,
                notional: bucket.notional,
                uniqueWallets,
                uniqueMarkets: bucket.markets.size,
                repeatWallets,
                repeatWalletShare: uniqueWallets > 0 ? repeatWallets / uniqueWallets : 0,
                topWalletShare: (walletTotals[0] ?? 0) / totalNotional,
                top5WalletShare: walletTotals.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalNotional,
                marketsPerWallet,
            };
        })
        .sort((a, b) => {
            if (b.notional !== a.notional) return b.notional - a.notional;
            return b.trades - a.trades;
        });
}

function buildWalletCohorts(trades: EnrichedTrade[]): CohortMetric[] {
    const walletSummaries = new Map<string, WalletSummary>();

    for (const trade of trades) {
        const wallet = trade.proxyWallet.toLowerCase();
        const primitive = coarsePrimitive(trade);
        const market = trade.marketSlug ?? 'unknown-market';

        if (!walletSummaries.has(wallet)) {
            walletSummaries.set(wallet, {
                wallet,
                trades: 0,
                notional: 0,
                markets: new Set<string>(),
                primitiveNotional: new Map<string, number>(),
            });
        }

        const summary = walletSummaries.get(wallet)!;
        summary.trades++;
        summary.notional += trade.notional;
        summary.markets.add(market);
        summary.primitiveNotional.set(primitive, (summary.primitiveNotional.get(primitive) ?? 0) + trade.notional);
    }

    const cohorts = new Map<string, {
        wallets: number;
        totalTrades: number;
        totalNotional: number;
        totalMarkets: number;
        totalPurity: number;
    }>();

    for (const summary of walletSummaries.values()) {
        if (summary.trades < MIN_COHORT_TRADES) continue;
        if (summary.markets.size < MIN_COHORT_MARKETS) continue;

        const dominant = [...summary.primitiveNotional.entries()].sort((a, b) => b[1] - a[1])[0];
        if (!dominant) continue;

        const [primitive, dominantNotional] = dominant;
        if (!cohorts.has(primitive)) {
            cohorts.set(primitive, {
                wallets: 0,
                totalTrades: 0,
                totalNotional: 0,
                totalMarkets: 0,
                totalPurity: 0,
            });
        }

        const cohort = cohorts.get(primitive)!;
        cohort.wallets++;
        cohort.totalTrades += summary.trades;
        cohort.totalNotional += summary.notional;
        cohort.totalMarkets += summary.markets.size;
        cohort.totalPurity += summary.notional > 0 ? dominantNotional / summary.notional : 0;
    }

    return [...cohorts.entries()]
        .map(([primitive, cohort]) => ({
            primitive,
            wallets: cohort.wallets,
            totalTrades: cohort.totalTrades,
            totalNotional: cohort.totalNotional,
            avgMarketsPerWallet: cohort.wallets > 0 ? cohort.totalMarkets / cohort.wallets : 0,
            avgPurity: cohort.wallets > 0 ? cohort.totalPurity / cohort.wallets : 0,
        }))
        .sort((a, b) => {
            if (b.wallets !== a.wallets) return b.wallets - a.wallets;
            return b.totalNotional - a.totalNotional;
        });
}

function printPrimitiveTable(title: string, rows: PrimitiveMetric[], limit = 12): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.key.padEnd(44)} | trades ${String(row.trades).padStart(5)} | ` +
            `notional ${formatUsd(row.notional).padStart(12)} | wallets ${String(row.uniqueWallets).padStart(5)} | ` +
            `markets ${String(row.uniqueMarkets).padStart(4)} | repeat ${formatPct(row.repeatWalletShare).padStart(6)} | ` +
            `top1 ${formatPct(row.topWalletShare).padStart(6)} | top5 ${formatPct(row.top5WalletShare).padStart(6)}`,
        );
    }
}

function printCohortTable(title: string, rows: CohortMetric[], limit = 12): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.primitive.padEnd(44)} | wallets ${String(row.wallets).padStart(4)} | ` +
            `trades ${String(row.totalTrades).padStart(5)} | notional ${formatUsd(row.totalNotional).padStart(12)} | ` +
            `avg mkts ${row.avgMarketsPerWallet.toFixed(1).padStart(4)} | purity ${formatPct(row.avgPurity).padStart(6)}`,
        );
    }
}

function main(): void {
    const allTrades = loadJsonl<EnrichedTrade>(INPUT);
    const lateWindow = allTrades.filter((trade) => trade.enrichment?.matchedSnapshot);

    console.log(`Loaded ${allTrades.length} enriched trades from ${INPUT}`);
    console.log(`Late-window matched sample: ${lateWindow.length}`);

    const coarse = aggregatePrimitives(lateWindow, coarsePrimitive);
    const fine = aggregatePrimitives(lateWindow, finePrimitive);
    const broadCoarse = coarse
        .filter((row) => row.uniqueWallets >= 25 && row.uniqueMarkets >= 4)
        .sort((a, b) => {
            if (b.repeatWalletShare !== a.repeatWalletShare) return b.repeatWalletShare - a.repeatWalletShare;
            if (a.topWalletShare !== b.topWalletShare) return a.topWalletShare - b.topWalletShare;
            return b.notional - a.notional;
        });
    const cohorts = buildWalletCohorts(lateWindow);

    printPrimitiveTable('Top Coarse Primitives By Notional', coarse, 14);
    printPrimitiveTable('Broad Coarse Primitives (repeat wallets, low single-wallet dominance)', broadCoarse, 14);
    printPrimitiveTable('Top Fine Primitives By Notional', fine, 14);
    printCohortTable(`Wallet Dominant Cohorts (min ${MIN_COHORT_TRADES} trades and ${MIN_COHORT_MARKETS} markets)`, cohorts, 14);
}

main();
