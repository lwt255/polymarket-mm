/**
 * Robustness report for minority-slice underdog strategy presets.
 *
 * Purpose:
 * - stress-test named presets by crypto, interval, and market concentration
 * - determine whether the chosen 31-60s preset is broad or concentrated
 * - provide the next decision point before any true strategy build/backtest
 *
 * Usage:
 *   npx tsx src/scripts/wallet-underdog-strategy-robustness.ts
 *   npx tsx src/scripts/wallet-underdog-strategy-robustness.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const EXECUTIONS_INPUT = process.argv[2] || 'wallet-wallet-executions.normalized.jsonl';
const TX_INPUT = process.argv[3] || 'wallet-tx-events.normalized.jsonl';
const ENRICHED_INPUT = process.argv[4] || 'wallet-trades.enriched.jsonl';
const BUNDLE_EQ_TOLERANCE = 0.0001;

interface NormalizedLeg {
    outcome: string | null;
    totalSize: number;
    totalNotional: number;
}

interface NormalizedTxEvent {
    txHash: string;
    structureLabel: string;
    legs: NormalizedLeg[];
}

interface NormalizedWalletExecution {
    txHash: string;
    wallet: string;
    crypto: string;
    interval: number;
    marketSlug: string | null;
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    totalNotional: number;
    buyHoldPnl: number;
}

interface EnrichedTrade {
    transactionHash: string | null;
    proxyWallet: string;
    tradeSecondsBeforeEnd: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
        nearestSnapshotMatchedSummary?: {
            favoriteBestBidDepth?: number | null;
            clMoveFromOpen?: number | null;
            totalFetchLatencyMs?: number | null;
            captureDelayMs?: number | null;
            moveLast30s?: number | null;
        } | null;
        quoteStability?: {
            largestFavoriteImpliedJumpPct?: number;
        } | null;
        underlyingPathProfile?: {
            trendAtT120Dollars?: number;
            finalTrendDollars?: number;
        } | null;
    };
}

interface FeatureRow {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    bucket: string;
    notional: number;
    buyHoldPnl: number;
    success: boolean;
    favoriteBidDepth: number | null;
    clMoveFromOpen: number | null;
    absMoveLast30s: number | null;
    fetchLatencyMs: number | null;
    captureDelayMs: number | null;
    largestFavoriteImpliedJumpPct: number | null;
    trendAtT120Dollars: number | null;
    finalTrendDollars: number | null;
}

interface Preset {
    id: string;
    description: string;
    predicate: (row: FeatureRow) => boolean;
}

interface Score {
    sample: number;
    winRate: number;
    notional: number;
    pnl: number;
    roi: number;
    uniqueMarkets: number;
    topMarketShare: number;
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

function mean(values: Array<number | null | undefined>): number | null {
    const nums = values.filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    if (nums.length === 0) return null;
    return nums.reduce((sum, value) => sum + value, 0) / nums.length;
}

function formatPct(value: number): string {
    return `${(value * 100).toFixed(1)}%`;
}

function secondsBucket(seconds: number | null): string {
    if (seconds === null || !Number.isFinite(seconds)) return 'unknown';
    if (seconds > 120) return '121-210s';
    if (seconds > 60) return '61-120s';
    if (seconds > 30) return '31-60s';
    if (seconds >= 0) return '0-30s';
    return 'after_end';
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

function buildFeatureRows(
    executions: NormalizedWalletExecution[],
    txEvents: NormalizedTxEvent[],
    enrichedTrades: EnrichedTrade[],
): FeatureRow[] {
    const exactComplementTx = new Set<string>();
    for (const tx of txEvents) {
        if (tx.structureLabel !== 'cross_outcome_same_side') continue;
        const cost = bundleCostPerShare(tx);
        if (cost !== null && Math.abs(cost - 1) <= BUNDLE_EQ_TOLERANCE) {
            exactComplementTx.add(tx.txHash.toLowerCase());
        }
    }

    const tradesByExecution = new Map<string, EnrichedTrade[]>();
    for (const trade of enrichedTrades) {
        if (!trade.enrichment?.matchedSnapshot) continue;
        const txHash = trade.transactionHash?.toLowerCase();
        if (!txHash) continue;
        const wallet = trade.proxyWallet.toLowerCase();
        const key = `${txHash}||${wallet}`;
        if (!tradesByExecution.has(key)) tradesByExecution.set(key, []);
        tradesByExecution.get(key)!.push(trade);
    }

    const rows: FeatureRow[] = [];

    for (const execution of executions) {
        if (!(execution.dominantActionLabel ?? '').startsWith('BUY_UNDERDOG')) continue;
        if (!(execution.dominantPrimitiveKey ?? '').startsWith('BUY_UNDERDOG | two-sided')) continue;
        if (exactComplementTx.has(execution.txHash.toLowerCase())) continue;

        const key = `${execution.txHash.toLowerCase()}||${execution.wallet.toLowerCase()}`;
        const trades = (tradesByExecution.get(key) ?? []).filter((trade) =>
            trade.enrichment?.walletActionLabel === 'BUY_UNDERDOG'
            && trade.enrichment?.regimeLabels?.t60State === 'two-sided',
        );
        if (trades.length === 0) continue;

        const snapshots = trades.map((trade) => trade.enrichment?.nearestSnapshotMatchedSummary).filter(Boolean);

        rows.push({
            crypto: execution.crypto,
            interval: execution.interval,
            marketSlug: execution.marketSlug,
            bucket: secondsBucket(mean(trades.map((trade) => trade.tradeSecondsBeforeEnd))),
            notional: execution.totalNotional,
            buyHoldPnl: execution.buyHoldPnl,
            success: execution.buyHoldPnl > 0,
            favoriteBidDepth: mean(snapshots.map((snapshot) => snapshot?.favoriteBestBidDepth ?? null)),
            clMoveFromOpen: mean(snapshots.map((snapshot) => snapshot?.clMoveFromOpen ?? null)),
            absMoveLast30s: mean(snapshots.map((snapshot) => snapshot?.moveLast30s === undefined || snapshot?.moveLast30s === null ? null : Math.abs(snapshot.moveLast30s))),
            fetchLatencyMs: mean(snapshots.map((snapshot) => snapshot?.totalFetchLatencyMs ?? null)),
            captureDelayMs: mean(snapshots.map((snapshot) => snapshot?.captureDelayMs ?? null)),
            largestFavoriteImpliedJumpPct: mean(trades.map((trade) => trade.enrichment?.quoteStability?.largestFavoriteImpliedJumpPct ?? null)),
            trendAtT120Dollars: mean(trades.map((trade) => trade.enrichment?.underlyingPathProfile?.trendAtT120Dollars ?? null)),
            finalTrendDollars: mean(trades.map((trade) => trade.enrichment?.underlyingPathProfile?.finalTrendDollars ?? null)),
        });
    }

    return rows;
}

function score(rows: FeatureRow[]): Score {
    const sample = rows.length;
    const wins = rows.filter((row) => row.success).length;
    const notional = rows.reduce((sum, row) => sum + row.notional, 0);
    const pnl = rows.reduce((sum, row) => sum + row.buyHoldPnl, 0);
    const marketNotional = new Map<string, number>();
    for (const row of rows) {
        const market = row.marketSlug ?? 'unknown-market';
        marketNotional.set(market, (marketNotional.get(market) ?? 0) + row.notional);
    }
    const topMarket = [...marketNotional.values()].sort((a, b) => b - a)[0] ?? 0;
    return {
        sample,
        winRate: sample > 0 ? wins / sample : 0,
        notional,
        pnl,
        roi: notional > 0 ? pnl / notional : 0,
        uniqueMarkets: marketNotional.size,
        topMarketShare: notional > 0 ? topMarket / notional : 0,
    };
}

function buildPresets(): Preset[] {
    return [
        {
            id: 'practical_31_60_finaltrend',
            description: '31-60s and final trend still negative',
            predicate: (row) => row.bucket === '31-60s' && row.finalTrendDollars !== null && row.finalTrendDollars <= 0,
        },
        {
            id: 'practical_31_60_clmove_finaltrend',
            description: '31-60s, downside CL context, final trend still negative',
            predicate: (row) => row.bucket === '31-60s'
                && row.finalTrendDollars !== null && row.finalTrendDollars <= 0
                && row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1,
        },
        {
            id: 'practical_31_60_depth_add',
            description: '31-60s, downside CL context, final trend still negative, thinner favorite depth',
            predicate: (row) => row.bucket === '31-60s'
                && row.finalTrendDollars !== null && row.finalTrendDollars <= 0
                && row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1
                && row.favoriteBidDepth !== null && row.favoriteBidDepth <= 100,
        },
        {
            id: 'late_0_30_experimental',
            description: '0-30s extreme move/jump experimental slice',
            predicate: (row) => row.bucket === '0-30s'
                && row.largestFavoriteImpliedJumpPct !== null && row.largestFavoriteImpliedJumpPct >= 16
                && row.absMoveLast30s !== null && row.absMoveLast30s >= 5,
        },
    ];
}

function printDimension(title: string, groups: Array<[string, FeatureRow[]]>): void {
    console.log(`\n${title}`);
    for (const [label, rows] of groups) {
        const s = score(rows);
        console.log(
            `  ${label.padEnd(10)} | sample ${String(s.sample).padStart(4)} | ` +
            `win ${formatPct(s.winRate).padStart(6)} | roi ${formatPct(s.roi).padStart(8)} | ` +
            `pnl ${s.pnl.toFixed(2).padStart(10)} | mkts ${String(s.uniqueMarkets).padStart(3)} | ` +
            `top1 ${formatPct(s.topMarketShare).padStart(6)}`
        );
    }
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);
    const enrichedTrades = loadJsonl<EnrichedTrade>(ENRICHED_INPUT);
    const rows = buildFeatureRows(executions, txEvents, enrichedTrades);
    const presets = buildPresets();

    console.log(`Built ${rows.length} minority-slice BUY_UNDERDOG feature rows`);

    for (const preset of presets) {
        const filtered = rows.filter((row) => preset.predicate(row));
        const overall = score(filtered);
        console.log(`\n${preset.id}`);
        console.log(`  ${preset.description}`);
        console.log(
            `  overall sample ${overall.sample} | win ${formatPct(overall.winRate)} | roi ${formatPct(overall.roi)} | ` +
            `pnl ${overall.pnl.toFixed(2)} | mkts ${overall.uniqueMarkets} | top1 ${formatPct(overall.topMarketShare)}`
        );

        const byCrypto = ['btc', 'eth', 'sol', 'xrp']
            .map((crypto) => [crypto.toUpperCase(), filtered.filter((row) => row.crypto === crypto)] as [string, FeatureRow[]])
            .filter(([, rows]) => rows.length > 0);
        printDimension('  By Crypto', byCrypto);

        const byInterval = [5, 15]
            .map((interval) => [`${interval}m`, filtered.filter((row) => row.interval === interval)] as [string, FeatureRow[]])
            .filter(([, rows]) => rows.length > 0);
        printDimension('  By Interval', byInterval);
    }
}

main();
