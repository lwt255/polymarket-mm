/**
 * Strategy preset evaluator for minority-slice BUY_UNDERDOG | two-sided flow.
 *
 * Purpose:
 * - turn the threshold scorer output into a small set of named candidate rules
 * - compare presets side by side against bucket baselines
 * - provide the clearest current handoff from wallet archaeology to strategy
 *   hypothesis
 *
 * Usage:
 *   npx tsx src/scripts/wallet-underdog-strategy-evaluator.ts
 *   npx tsx src/scripts/wallet-underdog-strategy-evaluator.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl wallet-trades.enriched.jsonl
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
            underdogSide?: 'UP' | 'DOWN' | null;
            favoriteSide?: 'UP' | 'DOWN' | null;
            upAsk?: number;
            downAsk?: number;
            upBid?: number;
            downBid?: number;
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
    bucketScope: string;
    description: string;
    predicate: (row: FeatureRow) => boolean;
}

interface Score {
    sample: number;
    wins: number;
    winRate: number;
    notional: number;
    pnl: number;
    roi: number;
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
    return {
        sample,
        wins,
        winRate: sample > 0 ? wins / sample : 0,
        notional,
        pnl,
        roi: notional > 0 ? pnl / notional : 0,
    };
}

function buildPresets(): Preset[] {
    return [
        {
            id: 'baseline_all',
            bucketScope: 'all',
            description: 'Minority-slice BUY_UNDERDOG | two-sided baseline',
            predicate: () => true,
        },
        {
            id: 'baseline_31_60',
            bucketScope: '31-60s',
            description: '31-60s bucket baseline',
            predicate: (row) => row.bucket === '31-60s',
        },
        {
            id: 'practical_31_60_finaltrend',
            bucketScope: '31-60s',
            description: '31-60s and final trend still negative',
            predicate: (row) => row.bucket === '31-60s' && row.finalTrendDollars !== null && row.finalTrendDollars <= 0,
        },
        {
            id: 'practical_31_60_clmove_finaltrend',
            bucketScope: '31-60s',
            description: '31-60s, downside CL context, final trend still negative',
            predicate: (row) => row.bucket === '31-60s'
                && row.finalTrendDollars !== null && row.finalTrendDollars <= 0
                && row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1,
        },
        {
            id: 'practical_31_60_depth_add',
            bucketScope: '31-60s',
            description: '31-60s, downside CL context, final trend still negative, thinner favorite depth',
            predicate: (row) => row.bucket === '31-60s'
                && row.finalTrendDollars !== null && row.finalTrendDollars <= 0
                && row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1
                && row.favoriteBidDepth !== null && row.favoriteBidDepth <= 100,
        },
        {
            id: 'early_121_210_depth_downside',
            bucketScope: '121-210s',
            description: '121-210s with downside context and thin favorite depth',
            predicate: (row) => row.bucket === '121-210s'
                && row.trendAtT120Dollars !== null && row.trendAtT120Dollars <= -1
                && row.favoriteBidDepth !== null && row.favoriteBidDepth <= 50,
        },
        {
            id: 'late_0_30_experimental',
            bucketScope: '0-30s',
            description: '0-30s extreme move/jump experimental slice',
            predicate: (row) => row.bucket === '0-30s'
                && row.largestFavoriteImpliedJumpPct !== null && row.largestFavoriteImpliedJumpPct >= 16
                && row.absMoveLast30s !== null && row.absMoveLast30s >= 5,
        },
    ];
}

function baselineForScope(scope: string, rows: FeatureRow[]): Score {
    if (scope === 'all') return score(rows);
    return score(rows.filter((row) => row.bucket === scope));
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);
    const enrichedTrades = loadJsonl<EnrichedTrade>(ENRICHED_INPUT);
    const rows = buildFeatureRows(executions, txEvents, enrichedTrades);
    const presets = buildPresets();

    console.log(`Built ${rows.length} minority-slice BUY_UNDERDOG feature rows`);
    console.log('\nPreset Evaluation');

    for (const preset of presets) {
        const filtered = rows.filter((row) => preset.predicate(row));
        const result = score(filtered);
        const baseline = baselineForScope(preset.bucketScope, rows);
        console.log(
            `\n${preset.id}\n` +
            `  ${preset.description}\n` +
            `  sample ${result.sample} | win ${formatPct(result.winRate)} | roi ${formatPct(result.roi)} | pnl ${result.pnl.toFixed(2)}\n` +
            `  baseline(${preset.bucketScope}) sample ${baseline.sample} | win ${formatPct(baseline.winRate)} | roi ${formatPct(baseline.roi)} | pnl ${baseline.pnl.toFixed(2)}\n` +
            `  uplift win ${formatPct(result.winRate - baseline.winRate)} | uplift roi ${formatPct(result.roi - baseline.roi)}`
        );
    }
}

main();
