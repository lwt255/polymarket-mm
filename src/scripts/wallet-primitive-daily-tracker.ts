/**
 * Daily primitive tracker with resolved buy-side outcome scoring.
 *
 * Purpose:
 * - track recurring primitives by market-end day
 * - score late-window BUY behavior against actual market resolution
 * - provide a forward-test style summary layer once more days accumulate
 *
 * Important:
 * - the profit proxy here is only for BUY trades held to resolution
 * - SELL trades are counted for participation/breadth but are not treated as a
 *   clean PnL signal because many sells are likely exits or inventory management
 *
 * Usage:
 *   npx tsx src/scripts/wallet-primitive-daily-tracker.ts
 *   npx tsx src/scripts/wallet-primitive-daily-tracker.ts wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';

interface EnrichedTrade {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    marketEnd: string | null;
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    resolvedOutcome: 'UP' | 'DOWN' | null;
    buyResolvedWin: boolean | null;
    buyHoldToResolutionPnl: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
    };
}

interface DayPrimitiveMetric {
    day: string;
    primitive: string;
    trades: number;
    notional: number;
    uniqueWallets: number;
    uniqueMarkets: number;
    buyTrades: number;
    resolvedBuyTrades: number;
    unresolvedBuyTrades: number;
    buyWinRate: number | null;
    buyHoldPnl: number;
    avgBuyHoldPnl: number | null;
    topWalletShare: number;
}

interface PrimitiveRollup {
    primitive: string;
    activeDays: number;
    totalTrades: number;
    totalNotional: number;
    totalResolvedBuyTrades: number;
    totalBuyHoldPnl: number;
    avgDailyBuyWinRate: number | null;
    avgDailyTopWalletShare: number | null;
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

function marketEndDay(marketEnd: string | null): string {
    if (!marketEnd) return 'unknown-day';
    return marketEnd.slice(0, 10);
}

function buildDayPrimitiveMetrics(trades: EnrichedTrade[]): DayPrimitiveMetric[] {
    const buckets = new Map<string, {
        day: string;
        primitive: string;
        trades: number;
        notional: number;
        wallets: Set<string>;
        markets: Set<string>;
        walletNotional: Map<string, number>;
        buyTrades: number;
        resolvedBuyTrades: number;
        unresolvedBuyTrades: number;
        buyWins: number;
        buyHoldPnl: number;
    }>();

    for (const trade of trades) {
        const day = marketEndDay(trade.marketEnd);
        const primitive = primitiveKey(trade);
        const key = `${day}||${primitive}`;
        const wallet = trade.proxyWallet.toLowerCase();
        const market = trade.marketSlug ?? 'unknown-market';

        if (!buckets.has(key)) {
            buckets.set(key, {
                day,
                primitive,
                trades: 0,
                notional: 0,
                wallets: new Set<string>(),
                markets: new Set<string>(),
                walletNotional: new Map<string, number>(),
                buyTrades: 0,
                resolvedBuyTrades: 0,
                unresolvedBuyTrades: 0,
                buyWins: 0,
                buyHoldPnl: 0,
            });
        }

        const bucket = buckets.get(key)!;
        bucket.trades++;
        bucket.notional += trade.notional;
        bucket.wallets.add(wallet);
        bucket.markets.add(market);
        bucket.walletNotional.set(wallet, (bucket.walletNotional.get(wallet) ?? 0) + trade.notional);

        if (trade.side === 'BUY') {
            bucket.buyTrades++;
            if (trade.buyResolvedWin === null || trade.buyHoldToResolutionPnl === null) {
                bucket.unresolvedBuyTrades++;
            } else {
                bucket.resolvedBuyTrades++;
                if (trade.buyResolvedWin) bucket.buyWins++;
                bucket.buyHoldPnl += trade.buyHoldToResolutionPnl;
            }
        }
    }

    return [...buckets.values()]
        .map((bucket) => {
            const walletTotals = [...bucket.walletNotional.values()].sort((a, b) => b - a);
            return {
                day: bucket.day,
                primitive: bucket.primitive,
                trades: bucket.trades,
                notional: bucket.notional,
                uniqueWallets: bucket.wallets.size,
                uniqueMarkets: bucket.markets.size,
                buyTrades: bucket.buyTrades,
                resolvedBuyTrades: bucket.resolvedBuyTrades,
                unresolvedBuyTrades: bucket.unresolvedBuyTrades,
                buyWinRate: bucket.resolvedBuyTrades > 0 ? bucket.buyWins / bucket.resolvedBuyTrades : null,
                buyHoldPnl: bucket.buyHoldPnl,
                avgBuyHoldPnl: bucket.resolvedBuyTrades > 0 ? bucket.buyHoldPnl / bucket.resolvedBuyTrades : null,
                topWalletShare: bucket.notional > 0 ? (walletTotals[0] ?? 0) / bucket.notional : 0,
            };
        })
        .sort((a, b) => {
            if (a.day !== b.day) return b.day.localeCompare(a.day);
            if (b.notional !== a.notional) return b.notional - a.notional;
            return b.trades - a.trades;
        });
}

function buildPrimitiveRollups(rows: DayPrimitiveMetric[]): PrimitiveRollup[] {
    const buckets = new Map<string, {
        activeDays: number;
        totalTrades: number;
        totalNotional: number;
        totalResolvedBuyTrades: number;
        totalBuyHoldPnl: number;
        dailyWinRates: number[];
        dailyTopWalletShares: number[];
    }>();

    for (const row of rows) {
        if (!buckets.has(row.primitive)) {
            buckets.set(row.primitive, {
                activeDays: 0,
                totalTrades: 0,
                totalNotional: 0,
                totalResolvedBuyTrades: 0,
                totalBuyHoldPnl: 0,
                dailyWinRates: [],
                dailyTopWalletShares: [],
            });
        }

        const bucket = buckets.get(row.primitive)!;
        bucket.activeDays++;
        bucket.totalTrades += row.trades;
        bucket.totalNotional += row.notional;
        bucket.totalResolvedBuyTrades += row.resolvedBuyTrades;
        bucket.totalBuyHoldPnl += row.buyHoldPnl;
        if (row.buyWinRate !== null) bucket.dailyWinRates.push(row.buyWinRate);
        bucket.dailyTopWalletShares.push(row.topWalletShare);
    }

    return [...buckets.entries()]
        .map(([primitive, bucket]) => ({
            primitive,
            activeDays: bucket.activeDays,
            totalTrades: bucket.totalTrades,
            totalNotional: bucket.totalNotional,
            totalResolvedBuyTrades: bucket.totalResolvedBuyTrades,
            totalBuyHoldPnl: bucket.totalBuyHoldPnl,
            avgDailyBuyWinRate: bucket.dailyWinRates.length > 0
                ? bucket.dailyWinRates.reduce((sum, value) => sum + value, 0) / bucket.dailyWinRates.length
                : null,
            avgDailyTopWalletShare: bucket.dailyTopWalletShares.length > 0
                ? bucket.dailyTopWalletShares.reduce((sum, value) => sum + value, 0) / bucket.dailyTopWalletShares.length
                : null,
        }))
        .sort((a, b) => {
            if ((b.avgDailyBuyWinRate ?? -1) !== (a.avgDailyBuyWinRate ?? -1)) {
                return (b.avgDailyBuyWinRate ?? -1) - (a.avgDailyBuyWinRate ?? -1);
            }
            return b.totalNotional - a.totalNotional;
        });
}

function printDayTable(title: string, rows: DayPrimitiveMetric[], limit = 12): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.day} | ${row.primitive.padEnd(36)} | trades ${String(row.trades).padStart(5)} | ` +
            `notional ${formatUsd(row.notional).padStart(11)} | wallets ${String(row.uniqueWallets).padStart(4)} | ` +
            `mkts ${String(row.uniqueMarkets).padStart(3)} | buy wins ${row.buyWinRate === null ? 'N/A'.padStart(6) : formatPct(row.buyWinRate).padStart(6)} | ` +
            `buy pnl ${formatUsd(row.buyHoldPnl).padStart(10)} | top1 ${formatPct(row.topWalletShare).padStart(6)}`,
        );
    }
}

function printRollupTable(title: string, rows: PrimitiveRollup[], limit = 12): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.primitive.padEnd(36)} | days ${String(row.activeDays).padStart(3)} | ` +
            `trades ${String(row.totalTrades).padStart(5)} | notional ${formatUsd(row.totalNotional).padStart(11)} | ` +
            `resolved buys ${String(row.totalResolvedBuyTrades).padStart(5)} | avg win ${row.avgDailyBuyWinRate === null ? 'N/A'.padStart(6) : formatPct(row.avgDailyBuyWinRate).padStart(6)} | ` +
            `buy pnl ${formatUsd(row.totalBuyHoldPnl).padStart(10)} | avg top1 ${row.avgDailyTopWalletShare === null ? 'N/A'.padStart(6) : formatPct(row.avgDailyTopWalletShare).padStart(6)}`,
        );
    }
}

function main(): void {
    const trades = loadJsonl<EnrichedTrade>(INPUT);
    const lateWindowBuys = trades.filter((trade) => trade.enrichment?.matchedSnapshot);
    const rows = buildDayPrimitiveMetrics(lateWindowBuys);
    const rollups = buildPrimitiveRollups(rows);
    const broadRows = rows
        .filter((row) => row.uniqueWallets >= 25 && row.uniqueMarkets >= 3 && row.resolvedBuyTrades >= 25)
        .sort((a, b) => {
            if ((b.buyWinRate ?? -1) !== (a.buyWinRate ?? -1)) return (b.buyWinRate ?? -1) - (a.buyWinRate ?? -1);
            return b.buyHoldPnl - a.buyHoldPnl;
        });

    console.log(`Loaded ${trades.length} enriched trades from ${INPUT}`);
    console.log(`Late-window matched trades used: ${lateWindowBuys.length}`);

    printDayTable('Top Day x Primitive Rows By Notional', rows, 14);
    printDayTable('Broad Day x Primitive Rows With Resolved BUY Scoring', broadRows, 14);
    printRollupTable('Primitive Rollups Across Available Days', rollups, 14);
}

main();
