/**
 * Threshold scorer for minority-slice BUY_UNDERDOG | two-sided executions.
 *
 * Purpose:
 * - convert the minority-slice feature comparison into concrete candidate rules
 * - score simple threshold filters against the surviving underdog execution set
 * - compare filtered vs baseline performance by bucket
 *
 * Usage:
 *   npx tsx src/scripts/wallet-underdog-filter-scorer.ts
 *   npx tsx src/scripts/wallet-underdog-filter-scorer.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const EXECUTIONS_INPUT = process.argv[2] || 'wallet-wallet-executions.normalized.jsonl';
const TX_INPUT = process.argv[3] || 'wallet-tx-events.normalized.jsonl';
const ENRICHED_INPUT = process.argv[4] || 'wallet-trades.enriched.jsonl';
const BUNDLE_EQ_TOLERANCE = 0.0001;
const MIN_SAMPLE = 40;
const MAX_CLAUSES = 4;

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
            underdogBestAskDepth?: number | null;
            clMoveFromOpen?: number | null;
            totalFetchLatencyMs?: number | null;
            captureDelayMs?: number | null;
            moveLast30s?: number | null;
            moveLast60s?: number | null;
            moveLast120s?: number | null;
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
    underdogAsk: number | null;
    favoriteBid: number | null;
    favoriteBidDepth: number | null;
    underdogAskDepth: number | null;
    clMoveFromOpen: number | null;
    absMoveLast30s: number | null;
    absMoveLast60s: number | null;
    absMoveLast120s: number | null;
    fetchLatencyMs: number | null;
    captureDelayMs: number | null;
    largestFavoriteImpliedJumpPct: number | null;
    trendAtT120Dollars: number | null;
    finalTrendDollars: number | null;
}

interface Clause {
    id: string;
    group: string;
    label: string;
    predicate: (row: FeatureRow) => boolean;
}

interface RuleResult {
    bucket: string;
    labels: string[];
    sample: number;
    winRate: number;
    notional: number;
    pnl: number;
    roi: number;
    baselineSample: number;
    baselineWinRate: number;
    baselineRoi: number;
    deltaWinRate: number;
    deltaRoi: number;
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
        const underdogAsk = mean(snapshots.map((snapshot) => {
            const side = snapshot?.underdogSide;
            if (side === 'UP') return snapshot?.upAsk ?? null;
            if (side === 'DOWN') return snapshot?.downAsk ?? null;
            return null;
        }));
        const favoriteBid = mean(snapshots.map((snapshot) => {
            const side = snapshot?.favoriteSide;
            if (side === 'UP') return snapshot?.upBid ?? null;
            if (side === 'DOWN') return snapshot?.downBid ?? null;
            return null;
        }));

        rows.push({
            bucket: secondsBucket(mean(trades.map((trade) => trade.tradeSecondsBeforeEnd))),
            notional: execution.totalNotional,
            buyHoldPnl: execution.buyHoldPnl,
            success: execution.buyHoldPnl > 0,
            underdogAsk,
            favoriteBid,
            favoriteBidDepth: mean(snapshots.map((snapshot) => snapshot?.favoriteBestBidDepth ?? null)),
            underdogAskDepth: mean(snapshots.map((snapshot) => snapshot?.underdogBestAskDepth ?? null)),
            clMoveFromOpen: mean(snapshots.map((snapshot) => snapshot?.clMoveFromOpen ?? null)),
            absMoveLast30s: mean(snapshots.map((snapshot) => snapshot?.moveLast30s === undefined || snapshot?.moveLast30s === null ? null : Math.abs(snapshot.moveLast30s))),
            absMoveLast60s: mean(snapshots.map((snapshot) => snapshot?.moveLast60s === undefined || snapshot?.moveLast60s === null ? null : Math.abs(snapshot.moveLast60s))),
            absMoveLast120s: mean(snapshots.map((snapshot) => snapshot?.moveLast120s === undefined || snapshot?.moveLast120s === null ? null : Math.abs(snapshot.moveLast120s))),
            fetchLatencyMs: mean(snapshots.map((snapshot) => snapshot?.totalFetchLatencyMs ?? null)),
            captureDelayMs: mean(snapshots.map((snapshot) => snapshot?.captureDelayMs ?? null)),
            largestFavoriteImpliedJumpPct: mean(trades.map((trade) => trade.enrichment?.quoteStability?.largestFavoriteImpliedJumpPct ?? null)),
            trendAtT120Dollars: mean(trades.map((trade) => trade.enrichment?.underlyingPathProfile?.trendAtT120Dollars ?? null)),
            finalTrendDollars: mean(trades.map((trade) => trade.enrichment?.underlyingPathProfile?.finalTrendDollars ?? null)),
        });
    }

    return rows;
}

function scoreRows(rows: FeatureRow[]): { sample: number; winRate: number; notional: number; pnl: number; roi: number } {
    const sample = rows.length;
    const wins = rows.filter((row) => row.success).length;
    const notional = rows.reduce((sum, row) => sum + row.notional, 0);
    const pnl = rows.reduce((sum, row) => sum + row.buyHoldPnl, 0);
    return {
        sample,
        winRate: sample > 0 ? wins / sample : 0,
        notional,
        pnl,
        roi: notional > 0 ? pnl / notional : 0,
    };
}

function generateRuleCombos(clauses: Clause[], maxClauses: number): Clause[][] {
    const results: Clause[][] = [];
    function dfs(start: number, combo: Clause[]): void {
        if (combo.length > 0) results.push([...combo]);
        if (combo.length === maxClauses) return;

        const usedGroups = new Set(combo.map((clause) => clause.group));

        for (let i = start; i < clauses.length; i++) {
            if (usedGroups.has(clauses[i].group)) continue;
            combo.push(clauses[i]);
            dfs(i + 1, combo);
            combo.pop();
        }
    }
    dfs(0, []);
    return results;
}

function buildClauses(bucket: string): Clause[] {
    const common: Clause[] = [
        { id: 'trend_lte_-1', group: 'trend', label: 'trendAtT120<=-1', predicate: (row) => row.trendAtT120Dollars !== null && row.trendAtT120Dollars <= -1 },
        { id: 'trend_lte_-10', group: 'trend', label: 'trendAtT120<=-10', predicate: (row) => row.trendAtT120Dollars !== null && row.trendAtT120Dollars <= -10 },
        { id: 'trend_lte_-25', group: 'trend', label: 'trendAtT120<=-25', predicate: (row) => row.trendAtT120Dollars !== null && row.trendAtT120Dollars <= -25 },
        { id: 'cl_lte_-1', group: 'cl', label: 'clMove<=-1', predicate: (row) => row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1 },
        { id: 'cl_lte_-10', group: 'cl', label: 'clMove<=-10', predicate: (row) => row.clMoveFromOpen !== null && row.clMoveFromOpen <= -10 },
        { id: 'fav_depth_lte_50', group: 'favDepth', label: 'favoriteBidDepth<=50', predicate: (row) => row.favoriteBidDepth !== null && row.favoriteBidDepth <= 50 },
        { id: 'fav_depth_lte_100', group: 'favDepth', label: 'favoriteBidDepth<=100', predicate: (row) => row.favoriteBidDepth !== null && row.favoriteBidDepth <= 100 },
        { id: 'jump_gte_16', group: 'jump', label: 'favImpliedJump>=16', predicate: (row) => row.largestFavoriteImpliedJumpPct !== null && row.largestFavoriteImpliedJumpPct >= 16 },
        { id: 'jump_gte_20', group: 'jump', label: 'favImpliedJump>=20', predicate: (row) => row.largestFavoriteImpliedJumpPct !== null && row.largestFavoriteImpliedJumpPct >= 20 },
        { id: 'latency_lte_300', group: 'latency', label: 'fetchLatency<=300', predicate: (row) => row.fetchLatencyMs !== null && row.fetchLatencyMs <= 300 },
        { id: 'capture_lte_300', group: 'capture', label: 'captureDelay<=300', predicate: (row) => row.captureDelayMs !== null && row.captureDelayMs <= 300 },
    ];

    const bucketSpecific: Record<string, Clause[]> = {
        '121-210s': [
            { id: 'abs30_gte_0_1', group: 'move30', label: '|move30|>=0.1', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 0.1 },
            { id: 'abs30_gte_0_3', group: 'move30', label: '|move30|>=0.3', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 0.3 },
        ],
        '61-120s': [
            { id: 'abs60_gte_0_3', group: 'move60', label: '|move60|>=0.3', predicate: (row) => row.absMoveLast60s !== null && row.absMoveLast60s >= 0.3 },
            { id: 'abs60_gte_1', group: 'move60', label: '|move60|>=1', predicate: (row) => row.absMoveLast60s !== null && row.absMoveLast60s >= 1 },
        ],
        '31-60s': [
            { id: 'abs30_gte_0_25', group: 'move30', label: '|move30|>=0.25', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 0.25 },
            { id: 'abs30_gte_1', group: 'move30', label: '|move30|>=1', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 1 },
            { id: 'final_trend_lte_0', group: 'finalTrend', label: 'finalTrend<=0', predicate: (row) => row.finalTrendDollars !== null && row.finalTrendDollars <= 0 },
        ],
        '0-30s': [
            { id: 'abs30_gte_1', group: 'move30', label: '|move30|>=1', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 1 },
            { id: 'abs30_gte_5', group: 'move30', label: '|move30|>=5', predicate: (row) => row.absMoveLast30s !== null && row.absMoveLast30s >= 5 },
            { id: 'final_trend_lte_0', group: 'finalTrend', label: 'finalTrend<=0', predicate: (row) => row.finalTrendDollars !== null && row.finalTrendDollars <= 0 },
        ],
    };

    return [...common, ...(bucketSpecific[bucket] ?? [])];
}

function evaluateBucket(bucket: string, rows: FeatureRow[]): RuleResult[] {
    const bucketRows = rows.filter((row) => row.bucket === bucket);
    const baseline = scoreRows(bucketRows);
    const clauses = buildClauses(bucket);
    const combos = generateRuleCombos(clauses, MAX_CLAUSES);
    const results: RuleResult[] = [];

    for (const combo of combos) {
        const filtered = bucketRows.filter((row) => combo.every((clause) => clause.predicate(row)));
        if (filtered.length < MIN_SAMPLE) continue;

        const score = scoreRows(filtered);
        results.push({
            bucket,
            labels: combo.map((clause) => clause.label),
            sample: score.sample,
            winRate: score.winRate,
            notional: score.notional,
            pnl: score.pnl,
            roi: score.roi,
            baselineSample: baseline.sample,
            baselineWinRate: baseline.winRate,
            baselineRoi: baseline.roi,
            deltaWinRate: score.winRate - baseline.winRate,
            deltaRoi: score.roi - baseline.roi,
        });
    }

    return results;
}

function printBaseline(bucket: string, rows: FeatureRow[]): void {
    const bucketRows = rows.filter((row) => row.bucket === bucket);
    const baseline = scoreRows(bucketRows);
    console.log(
        `  ${bucket.padEnd(8)} sample ${String(baseline.sample).padStart(4)} | ` +
        `win ${formatPct(baseline.winRate).padStart(6)} | roi ${formatPct(baseline.roi).padStart(8)} | ` +
        `pnl ${baseline.pnl.toFixed(2).padStart(10)}`
    );
}

function printTop(title: string, results: RuleResult[], sortKey: 'roi' | 'pnl', limit = 6): void {
    const sorted = [...results].sort((a, b) => {
        if (sortKey === 'roi') {
            if (b.roi !== a.roi) return b.roi - a.roi;
            if (b.sample !== a.sample) return b.sample - a.sample;
            return a.labels.length - b.labels.length;
        }
        if (b.pnl !== a.pnl) return b.pnl - a.pnl;
        if (b.sample !== a.sample) return b.sample - a.sample;
        return a.labels.length - b.labels.length;
    });

    console.log(`\n${title}`);
    const seen = new Set<string>();
    let printed = 0;
    for (const row of sorted) {
        const signature = [
            row.bucket,
            row.sample,
            row.winRate.toFixed(4),
            row.roi.toFixed(4),
            row.pnl.toFixed(2),
        ].join('|');
        if (seen.has(signature)) continue;
        seen.add(signature);
        console.log(
            `  ${row.bucket} | sample ${String(row.sample).padStart(4)} | win ${formatPct(row.winRate).padStart(6)} | ` +
            `roi ${formatPct(row.roi).padStart(8)} | dROI ${formatPct(row.deltaRoi).padStart(8)} | ` +
            `pnl ${row.pnl.toFixed(2).padStart(10)} | ${row.labels.join(' & ')}`
        );
        printed++;
        if (printed >= limit) break;
    }
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);
    const enrichedTrades = loadJsonl<EnrichedTrade>(ENRICHED_INPUT);
    const rows = buildFeatureRows(executions, txEvents, enrichedTrades);

    console.log(`Built ${rows.length} minority-slice BUY_UNDERDOG feature rows`);
    console.log(`Minimum sample per rule: ${MIN_SAMPLE}`);

    console.log('\nBaselines');
    for (const bucket of ['121-210s', '61-120s', '31-60s', '0-30s']) {
        printBaseline(bucket, rows);
    }

    const allResults = ['121-210s', '61-120s', '31-60s', '0-30s']
        .flatMap((bucket) => evaluateBucket(bucket, rows));

    printTop('Top Rules By ROI', allResults, 'roi', 10);
    printTop('Top Rules By PnL', allResults, 'pnl', 10);
}

main();
