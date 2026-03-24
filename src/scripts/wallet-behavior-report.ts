/**
 * Behavior-first report over enriched wallet trades.
 *
 * Focus:
 * - summarize recurring trade behaviors in the late pricing window
 * - segment by market state and regime
 * - measure concentration so we can distinguish broad structure from
 *   single-wallet anecdotes
 *
 * Usage:
 *   npx tsx src/scripts/wallet-behavior-report.ts
 *   npx tsx src/scripts/wallet-behavior-report.ts wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';

interface EnrichedTrade {
    crypto: string;
    interval: number;
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        nearestSnapshotMatchedSummary?: {
            snapshotState?: string;
        } | null;
        regimeLabels?: {
            t120State?: string;
            t90State?: string;
            t60State?: string;
            firstOneSidedBucket?: string;
        } | null;
        walletActionLabel?: string;
        tradeOutcomeRole?: string;
        priceContext?: {
            likelyExecutionStyle?: string;
        } | null;
    };
}

type MetricRow = {
    key: string;
    trades: number;
    notional: number;
    uniqueWallets: number;
    topWalletShare: number;
    top5WalletShare: number;
};

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

function aggregateBy(trades: EnrichedTrade[], keyFn: (trade: EnrichedTrade) => string): MetricRow[] {
    const buckets = new Map<string, { trades: number; notional: number; walletNotional: Map<string, number> }>();

    for (const trade of trades) {
        const key = keyFn(trade);
        if (!buckets.has(key)) {
            buckets.set(key, {
                trades: 0,
                notional: 0,
                walletNotional: new Map<string, number>(),
            });
        }

        const bucket = buckets.get(key)!;
        bucket.trades++;
        bucket.notional += trade.notional;
        bucket.walletNotional.set(
            trade.proxyWallet.toLowerCase(),
            (bucket.walletNotional.get(trade.proxyWallet.toLowerCase()) ?? 0) + trade.notional,
        );
    }

    return [...buckets.entries()]
        .map(([key, bucket]) => {
            const walletTotals = [...bucket.walletNotional.values()].sort((a, b) => b - a);
            const totalNotional = bucket.notional || 1;
            const topWalletShare = (walletTotals[0] ?? 0) / totalNotional;
            const top5WalletShare = walletTotals.slice(0, 5).reduce((sum, value) => sum + value, 0) / totalNotional;

            return {
                key,
                trades: bucket.trades,
                notional: bucket.notional,
                uniqueWallets: bucket.walletNotional.size,
                topWalletShare,
                top5WalletShare,
            };
        })
        .sort((a, b) => {
            if (b.notional !== a.notional) return b.notional - a.notional;
            return b.trades - a.trades;
        });
}

function printTable(title: string, rows: MetricRow[], limit = 10): void {
    console.log(`\n${title}`);
    for (const row of rows.slice(0, limit)) {
        console.log(
            `  ${row.key.padEnd(38)} | trades ${String(row.trades).padStart(5)} | ` +
            `notional ${formatUsd(row.notional).padStart(12)} | wallets ${String(row.uniqueWallets).padStart(5)} | ` +
            `top1 ${formatPct(row.topWalletShare).padStart(6)} | top5 ${formatPct(row.top5WalletShare).padStart(6)}`,
        );
    }
}

function main(): void {
    const trades = loadJsonl<EnrichedTrade>(INPUT);
    const lateWindow = trades.filter((trade) => trade.enrichment?.matchedSnapshot);
    const walletsAll = new Set(trades.map((trade) => trade.proxyWallet.toLowerCase()));
    const walletsLate = new Set(lateWindow.map((trade) => trade.proxyWallet.toLowerCase()));

    console.log(`Loaded ${trades.length} enriched trades from ${INPUT}`);
    console.log(`Late-window matched trades: ${lateWindow.length} (${formatPct(lateWindow.length / Math.max(1, trades.length))})`);
    console.log(`Unique wallets: ${walletsAll.size} overall | ${walletsLate.size} in late-window matched sample`);

    printTable(
        'By Asset/Interval (late-window matched)',
        aggregateBy(lateWindow, (trade) => `${trade.crypto.toUpperCase()} ${trade.interval}m`),
        12,
    );

    printTable(
        'By Wallet Action (late-window matched)',
        aggregateBy(lateWindow, (trade) => trade.enrichment?.walletActionLabel ?? 'UNKNOWN'),
        12,
    );

    printTable(
        'By Wallet Action x Snapshot State',
        aggregateBy(
            lateWindow,
            (trade) => `${trade.enrichment?.walletActionLabel ?? 'UNKNOWN'} | ${trade.enrichment?.nearestSnapshotMatchedSummary?.snapshotState ?? 'unknown'}`,
        ),
        16,
    );

    printTable(
        'By Wallet Action x T60 State',
        aggregateBy(
            lateWindow,
            (trade) => `${trade.enrichment?.walletActionLabel ?? 'UNKNOWN'} | ${trade.enrichment?.regimeLabels?.t60State ?? 'unknown'}`,
        ),
        16,
    );

    printTable(
        'By Time-To-End Bucket x Wallet Action',
        aggregateBy(
            lateWindow,
            (trade) => `${secondsBucket(trade.tradeSecondsBeforeEnd)} | ${trade.enrichment?.walletActionLabel ?? 'UNKNOWN'}`,
        ),
        16,
    );

    printTable(
        'By Execution Style x Wallet Action',
        aggregateBy(
            lateWindow,
            (trade) => `${trade.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown'} | ${trade.enrichment?.walletActionLabel ?? 'UNKNOWN'}`,
        ),
        16,
    );
}

main();
