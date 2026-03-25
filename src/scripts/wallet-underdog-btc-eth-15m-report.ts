/**
 * Dedicated report for the first narrowed wallet-derived strategy hypothesis.
 *
 * Purpose:
 * - compare the current best preset against honest BTC/ETH 15m subsets
 * - determine whether the first real lane is BTC/ETH 15m rather than
 *   "crypto-wide"
 * - show how much breadth and concentration remain after narrowing scope
 *
 * Usage:
 *   npx tsx src/scripts/wallet-underdog-btc-eth-15m-report.ts
 *   npx tsx src/scripts/wallet-underdog-btc-eth-15m-report.ts wallet-wallet-executions.normalized.jsonl wallet-tx-events.normalized.jsonl wallet-trades.enriched.jsonl
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
        } | null;
        underlyingPathProfile?: {
            finalTrendDollars?: number;
        } | null;
    };
}

interface FeatureRow {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    wallet: string;
    bucket: string;
    notional: number;
    buyHoldPnl: number;
    success: boolean;
    favoriteBidDepth: number | null;
    clMoveFromOpen: number | null;
    finalTrendDollars: number | null;
}

interface Score {
    sample: number;
    wins: number;
    winRate: number;
    notional: number;
    pnl: number;
    roi: number;
    uniqueMarkets: number;
    uniqueWallets: number;
    topMarketShare: number;
}

interface Cohort {
    id: string;
    description: string;
    rows: FeatureRow[];
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
            wallet: execution.wallet.toLowerCase(),
            bucket: secondsBucket(mean(trades.map((trade) => trade.tradeSecondsBeforeEnd))),
            notional: execution.totalNotional,
            buyHoldPnl: execution.buyHoldPnl,
            success: execution.buyHoldPnl > 0,
            favoriteBidDepth: mean(snapshots.map((snapshot) => snapshot?.favoriteBestBidDepth ?? null)),
            clMoveFromOpen: mean(snapshots.map((snapshot) => snapshot?.clMoveFromOpen ?? null)),
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
    const wallets = new Set<string>();

    for (const row of rows) {
        const market = row.marketSlug ?? 'unknown-market';
        marketNotional.set(market, (marketNotional.get(market) ?? 0) + row.notional);
        wallets.add(row.wallet);
    }

    const topMarket = [...marketNotional.values()].sort((a, b) => b - a)[0] ?? 0;

    return {
        sample,
        wins,
        winRate: sample > 0 ? wins / sample : 0,
        notional,
        pnl,
        roi: notional > 0 ? pnl / notional : 0,
        uniqueMarkets: marketNotional.size,
        uniqueWallets: wallets.size,
        topMarketShare: notional > 0 ? topMarket / notional : 0,
    };
}

function chosenPreset(row: FeatureRow): boolean {
    return row.bucket === '31-60s'
        && row.finalTrendDollars !== null && row.finalTrendDollars <= 0
        && row.clMoveFromOpen !== null && row.clMoveFromOpen <= -1;
}

function printCohort(cohort: Cohort, baseline?: Score): void {
    const s = score(cohort.rows);
    const vsBaselineWin = baseline ? s.winRate - baseline.winRate : null;
    const vsBaselineRoi = baseline ? s.roi - baseline.roi : null;

    console.log(`\n${cohort.id}`);
    console.log(`  ${cohort.description}`);
    console.log(
        `  sample ${s.sample} | win ${formatPct(s.winRate)} | roi ${formatPct(s.roi)} | ` +
        `pnl ${s.pnl.toFixed(2)} | notional ${s.notional.toFixed(2)} | wallets ${s.uniqueWallets} | ` +
        `mkts ${s.uniqueMarkets} | top1 ${formatPct(s.topMarketShare)}`
    );

    if (vsBaselineWin !== null && vsBaselineRoi !== null) {
        console.log(
            `  vs baseline win ${vsBaselineWin >= 0 ? '+' : ''}${(vsBaselineWin * 100).toFixed(1)} pts | ` +
            `roi ${vsBaselineRoi >= 0 ? '+' : ''}${(vsBaselineRoi * 100).toFixed(1)} pts`
        );
    }
}

function printMarketBreakdown(title: string, rows: FeatureRow[]): void {
    const byMarket = new Map<string, FeatureRow[]>();
    for (const row of rows) {
        const market = row.marketSlug ?? 'unknown-market';
        if (!byMarket.has(market)) byMarket.set(market, []);
        byMarket.get(market)!.push(row);
    }

    const ranked = [...byMarket.entries()]
        .map(([market, marketRows]) => [market, score(marketRows)] as const)
        .sort((a, b) => b[1].notional - a[1].notional);

    console.log(`\n${title}`);
    for (const [market, s] of ranked) {
        console.log(
            `  ${market} | sample ${String(s.sample).padStart(4)} | ` +
            `win ${formatPct(s.winRate).padStart(6)} | roi ${formatPct(s.roi).padStart(8)} | ` +
            `pnl ${s.pnl.toFixed(2).padStart(10)} | notional ${s.notional.toFixed(2).padStart(9)}`
        );
    }
}

function main(): void {
    const executions = loadJsonl<NormalizedWalletExecution>(EXECUTIONS_INPUT);
    const txEvents = loadJsonl<NormalizedTxEvent>(TX_INPUT);
    const enrichedTrades = loadJsonl<EnrichedTrade>(ENRICHED_INPUT);
    const rows = buildFeatureRows(executions, txEvents, enrichedTrades);

    const minorityAll = rows;
    const minorityBtcEth15m = rows.filter((row) => (row.crypto === 'btc' || row.crypto === 'eth') && row.interval === 15);
    const baseline3160All = rows.filter((row) => row.bucket === '31-60s');
    const baseline3160BtcEth15m = minorityBtcEth15m.filter((row) => row.bucket === '31-60s');
    const presetAll = rows.filter(chosenPreset);
    const presetBtcEth15m = minorityBtcEth15m.filter(chosenPreset);
    const presetBtc15m = rows.filter((row) => row.crypto === 'btc' && row.interval === 15 && chosenPreset(row));
    const presetEth15m = rows.filter((row) => row.crypto === 'eth' && row.interval === 15 && chosenPreset(row));

    const baselineAllScore = score(minorityAll);
    const baseline3160Score = score(baseline3160All);
    const baseline3160BtcEth15mScore = score(baseline3160BtcEth15m);

    console.log(`Built ${rows.length} minority-slice BUY_UNDERDOG feature rows`);
    console.log('First-hypothesis preset: 31-60s, two-sided, outside exact complement plumbing, finalTrend <= 0, clMove <= -1');

    printCohort({
        id: 'minority_all',
        description: 'All minority-slice BUY_UNDERDOG | two-sided executions',
        rows: minorityAll,
    });

    printCohort({
        id: 'minority_btc_eth_15m',
        description: 'Minority-slice BTC/ETH 15m executions before bucket or preset filtering',
        rows: minorityBtcEth15m,
    }, baselineAllScore);

    printCohort({
        id: 'baseline_31_60_all',
        description: 'All 31-60s minority-slice executions',
        rows: baseline3160All,
    }, baselineAllScore);

    printCohort({
        id: 'baseline_31_60_btc_eth_15m',
        description: 'BTC/ETH 15m 31-60s bucket baseline',
        rows: baseline3160BtcEth15m,
    }, baselineAllScore);

    printCohort({
        id: 'preset_all',
        description: 'Chosen downside-continuation preset across all cryptos/intervals',
        rows: presetAll,
    }, baseline3160Score);

    printCohort({
        id: 'preset_btc_eth_15m',
        description: 'Chosen preset narrowed to BTC/ETH 15m',
        rows: presetBtcEth15m,
    }, baseline3160BtcEth15mScore);

    printCohort({
        id: 'preset_btc_15m',
        description: 'Chosen preset narrowed to BTC 15m only',
        rows: presetBtc15m,
    }, baseline3160BtcEth15mScore);

    printCohort({
        id: 'preset_eth_15m',
        description: 'Chosen preset narrowed to ETH 15m only',
        rows: presetEth15m,
    }, baseline3160BtcEth15mScore);

    printMarketBreakdown('Preset BTC/ETH 15m By Market', presetBtcEth15m);
}

main();
