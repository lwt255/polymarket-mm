/**
 * Success/failure feature comparison for minority-slice BUY_UNDERDOG executions.
 *
 * Purpose:
 * - isolate BUY_UNDERDOG | two-sided executions that are outside exact
 *   complementary bundles
 * - aggregate collector microstructure features around each wallet execution
 * - compare winning vs losing executions to identify candidate strategy filters
 *
 * Usage:
 *   npx tsx src/scripts/wallet-underdog-feature-compare.ts
 *   npx tsx src/scripts/wallet-underdog-feature-compare.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl wallet-trades.enriched.jsonl
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
    marketSlug: string | null;
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    txStructureLabel: string;
    totalNotional: number;
    buyHoldPnl: number;
    buyResolvedWinRate: number | null;
}

interface EnrichedTrade {
    transactionHash: string | null;
    proxyWallet: string;
    marketSlug: string | null;
    notional: number;
    buyHoldToResolutionPnl: number | null;
    tradeSecondsBeforeEnd: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
        nearestSnapshotMatchedSummary?: {
            upBid?: number;
            upAsk?: number;
            downBid?: number;
            downAsk?: number;
            underdogSide?: 'UP' | 'DOWN' | null;
            favoriteSide?: 'UP' | 'DOWN' | null;
            underdogBestAskDepth?: number | null;
            favoriteBestBidDepth?: number | null;
            clMoveFromOpen?: number | null;
            totalFetchLatencyMs?: number | null;
            captureDelayMs?: number | null;
            upQuoteAgeMs?: number | null;
            downQuoteAgeMs?: number | null;
            moveLast30s?: number | null;
            moveLast60s?: number | null;
            moveLast120s?: number | null;
        } | null;
        liquidityProfile?: {
            tradableRatio?: number;
            twoSidedRatio?: number;
            oneSidedRatio?: number;
            stateTransitionCount?: number;
            oneSidedReopenCount?: number;
        } | null;
        quoteStability?: {
            quoteChangeCount?: number;
            spreadChangeCount?: number;
            underdogAskChangeCount?: number;
            favoriteBidChangeCount?: number;
            largestUnderdogAskJumpCents?: number;
            largestFavoriteBidJumpCents?: number;
            largestFavoriteImpliedJumpPct?: number;
        } | null;
        underlyingPathProfile?: {
            snapshotRangeBps?: number;
            realizedVolBps?: number;
            trendAtT120Dollars?: number;
            finalTrendDollars?: number;
            moveLast30sAtClose?: number;
            moveLast60sAtClose?: number;
            moveLast120sAtClose?: number;
            reversedAfterT120?: boolean;
        } | null;
    };
}

interface ExecutionFeatureRow {
    primitive: string;
    bucket: string;
    success: boolean;
    notional: number;
    buyHoldPnl: number;
    buyResolvedWinRate: number | null;
    underdogAsk: number | null;
    favoriteBid: number | null;
    underdogAskDepth: number | null;
    favoriteBidDepth: number | null;
    clMoveFromOpen: number | null;
    absMoveLast30s: number | null;
    absMoveLast60s: number | null;
    absMoveLast120s: number | null;
    quoteAgeMs: number | null;
    captureDelayMs: number | null;
    fetchLatencyMs: number | null;
    tradableRatio: number | null;
    twoSidedRatio: number | null;
    oneSidedRatio: number | null;
    quoteChangeCount: number | null;
    spreadChangeCount: number | null;
    underdogAskChangeCount: number | null;
    favoriteBidChangeCount: number | null;
    largestUnderdogAskJumpCents: number | null;
    largestFavoriteBidJumpCents: number | null;
    largestFavoriteImpliedJumpPct: number | null;
    snapshotRangeBps: number | null;
    realizedVolBps: number | null;
    trendAtT120Dollars: number | null;
    finalTrendDollars: number | null;
    reversedAfterT120: number | null;
}

interface ComparisonStat {
    feature: string;
    winsAvg: number | null;
    lossesAvg: number | null;
    delta: number | null;
}

const FEATURE_KEYS: Array<keyof Omit<ExecutionFeatureRow, 'primitive' | 'bucket' | 'success' | 'notional' | 'buyHoldPnl' | 'buyResolvedWinRate'>> = [
    'underdogAsk',
    'favoriteBid',
    'underdogAskDepth',
    'favoriteBidDepth',
    'clMoveFromOpen',
    'absMoveLast30s',
    'absMoveLast60s',
    'absMoveLast120s',
    'quoteAgeMs',
    'captureDelayMs',
    'fetchLatencyMs',
    'tradableRatio',
    'twoSidedRatio',
    'oneSidedRatio',
    'quoteChangeCount',
    'spreadChangeCount',
    'underdogAskChangeCount',
    'favoriteBidChangeCount',
    'largestUnderdogAskJumpCents',
    'largestFavoriteBidJumpCents',
    'largestFavoriteImpliedJumpPct',
    'snapshotRangeBps',
    'realizedVolBps',
    'trendAtT120Dollars',
    'finalTrendDollars',
    'reversedAfterT120',
];

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

function formatNum(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return 'N/A';
    return value.toFixed(2);
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

function relevantQuoteAgeMs(snapshot: NonNullable<EnrichedTrade['enrichment']>['nearestSnapshotMatchedSummary']): number | null {
    if (!snapshot) return null;
    const upAge = snapshot.upQuoteAgeMs ?? null;
    const downAge = snapshot.downQuoteAgeMs ?? null;
    if (upAge !== null && downAge !== null) return Math.min(upAge, downAge);
    return upAge ?? downAge;
}

function buildExecutionFeatureRows(
    executions: NormalizedWalletExecution[],
    txEvents: Map<string, NormalizedTxEvent>,
    enrichedTrades: EnrichedTrade[],
): ExecutionFeatureRow[] {
    const exactComplementTx = new Set<string>();
    for (const tx of txEvents.values()) {
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

    const rows: ExecutionFeatureRow[] = [];

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

        const snapshots = trades
            .map((trade) => trade.enrichment?.nearestSnapshotMatchedSummary)
            .filter(Boolean);
        const liquidity = trades
            .map((trade) => trade.enrichment?.liquidityProfile)
            .filter(Boolean);
        const quoteStability = trades
            .map((trade) => trade.enrichment?.quoteStability)
            .filter(Boolean);
        const pathProfiles = trades
            .map((trade) => trade.enrichment?.underlyingPathProfile)
            .filter(Boolean);

        const underdogAskValues = snapshots.map((snapshot) => {
            const underdogSide = snapshot?.underdogSide;
            if (underdogSide === 'UP') return snapshot?.upAsk ?? null;
            if (underdogSide === 'DOWN') return snapshot?.downAsk ?? null;
            return null;
        });
        const favoriteBidValues = snapshots.map((snapshot) => {
            const favoriteSide = snapshot?.favoriteSide;
            if (favoriteSide === 'UP') return snapshot?.upBid ?? null;
            if (favoriteSide === 'DOWN') return snapshot?.downBid ?? null;
            return null;
        });

        rows.push({
            primitive: execution.dominantPrimitiveKey ?? 'UNKNOWN',
            bucket: secondsBucket(mean(trades.map((trade) => trade.tradeSecondsBeforeEnd))),
            success: execution.buyHoldPnl > 0,
            notional: execution.totalNotional,
            buyHoldPnl: execution.buyHoldPnl,
            buyResolvedWinRate: execution.buyResolvedWinRate,
            underdogAsk: mean(underdogAskValues),
            favoriteBid: mean(favoriteBidValues),
            underdogAskDepth: mean(snapshots.map((snapshot) => snapshot?.underdogBestAskDepth ?? null)),
            favoriteBidDepth: mean(snapshots.map((snapshot) => snapshot?.favoriteBestBidDepth ?? null)),
            clMoveFromOpen: mean(snapshots.map((snapshot) => snapshot?.clMoveFromOpen ?? null)),
            absMoveLast30s: mean(snapshots.map((snapshot) => snapshot?.moveLast30s === null || snapshot?.moveLast30s === undefined ? null : Math.abs(snapshot.moveLast30s))),
            absMoveLast60s: mean(snapshots.map((snapshot) => snapshot?.moveLast60s === null || snapshot?.moveLast60s === undefined ? null : Math.abs(snapshot.moveLast60s))),
            absMoveLast120s: mean(snapshots.map((snapshot) => snapshot?.moveLast120s === null || snapshot?.moveLast120s === undefined ? null : Math.abs(snapshot.moveLast120s))),
            quoteAgeMs: mean(snapshots.map((snapshot) => relevantQuoteAgeMs(snapshot ?? null))),
            captureDelayMs: mean(snapshots.map((snapshot) => snapshot?.captureDelayMs ?? null)),
            fetchLatencyMs: mean(snapshots.map((snapshot) => snapshot?.totalFetchLatencyMs ?? null)),
            tradableRatio: mean(liquidity.map((row) => row?.tradableRatio ?? null)),
            twoSidedRatio: mean(liquidity.map((row) => row?.twoSidedRatio ?? null)),
            oneSidedRatio: mean(liquidity.map((row) => row?.oneSidedRatio ?? null)),
            quoteChangeCount: mean(quoteStability.map((row) => row?.quoteChangeCount ?? null)),
            spreadChangeCount: mean(quoteStability.map((row) => row?.spreadChangeCount ?? null)),
            underdogAskChangeCount: mean(quoteStability.map((row) => row?.underdogAskChangeCount ?? null)),
            favoriteBidChangeCount: mean(quoteStability.map((row) => row?.favoriteBidChangeCount ?? null)),
            largestUnderdogAskJumpCents: mean(quoteStability.map((row) => row?.largestUnderdogAskJumpCents ?? null)),
            largestFavoriteBidJumpCents: mean(quoteStability.map((row) => row?.largestFavoriteBidJumpCents ?? null)),
            largestFavoriteImpliedJumpPct: mean(quoteStability.map((row) => row?.largestFavoriteImpliedJumpPct ?? null)),
            snapshotRangeBps: mean(pathProfiles.map((row) => row?.snapshotRangeBps ?? null)),
            realizedVolBps: mean(pathProfiles.map((row) => row?.realizedVolBps ?? null)),
            trendAtT120Dollars: mean(pathProfiles.map((row) => row?.trendAtT120Dollars ?? null)),
            finalTrendDollars: mean(pathProfiles.map((row) => row?.finalTrendDollars ?? null)),
            reversedAfterT120: mean(pathProfiles.map((row) => row?.reversedAfterT120 === undefined ? null : row.reversedAfterT120 ? 1 : 0)),
        });
    }

    return rows;
}

function buildComparisons(rows: ExecutionFeatureRow[]): ComparisonStat[] {
    const winners = rows.filter((row) => row.success);
    const losers = rows.filter((row) => !row.success);

    return FEATURE_KEYS.map((feature) => {
        const winsAvg = mean(winners.map((row) => row[feature] as number | null));
        const lossesAvg = mean(losers.map((row) => row[feature] as number | null));
        return {
            feature,
            winsAvg,
            lossesAvg,
            delta: winsAvg !== null && lossesAvg !== null ? winsAvg - lossesAvg : null,
        };
    }).sort((a, b) => Math.abs(b.delta ?? 0) - Math.abs(a.delta ?? 0));
}

function printComparison(title: string, rows: ExecutionFeatureRow[]): void {
    const winners = rows.filter((row) => row.success);
    const losers = rows.filter((row) => !row.success);
    const winRate = rows.length > 0 ? winners.length / rows.length : 0;
    const totalNotional = rows.reduce((sum, row) => sum + row.notional, 0);
    const totalPnl = rows.reduce((sum, row) => sum + row.buyHoldPnl, 0);

    console.log(`\n${title}`);
    console.log(
        `  executions ${rows.length} | wins ${winners.length} | losses ${losers.length} | ` +
        `win rate ${formatPct(winRate)} | notional ${totalNotional.toFixed(2)} | pnl ${totalPnl.toFixed(2)}`
    );

    for (const stat of buildComparisons(rows).slice(0, 12)) {
        console.log(
            `  ${stat.feature.padEnd(28)} wins ${formatNum(stat.winsAvg).padStart(8)} | ` +
            `losses ${formatNum(stat.lossesAvg).padStart(8)} | delta ${formatNum(stat.delta).padStart(8)}`
        );
    }
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);
    const enrichedTrades = loadJsonl<EnrichedTrade>(ENRICHED_INPUT);

    const txByHash = new Map<string, NormalizedTxEvent>();
    for (const tx of txEvents) txByHash.set(tx.txHash.toLowerCase(), tx);

    const rows = buildExecutionFeatureRows(executions, txByHash, enrichedTrades);
    const buckets = ['121-210s', '61-120s', '31-60s', '0-30s'];

    console.log(`Built ${rows.length} minority-slice BUY_UNDERDOG feature rows`);
    printComparison('Overall Minority-Slice BUY_UNDERDOG | two-sided', rows);

    for (const bucket of buckets) {
        const bucketRows = rows.filter((row) => row.bucket === bucket);
        if (bucketRows.length >= 30) {
            printComparison(`Bucket ${bucket}`, bucketRows);
        }
    }
}

main();
