/**
 * Normalize enriched wallet trade rows into tx-level and wallet-execution events.
 *
 * Purpose:
 * - collapse multi-row transaction hashes into execution events
 * - preserve enough leg detail for downstream analysis
 * - give primitive/replicability analysis a cleaner unit than raw feed rows
 *
 * Outputs:
 * - wallet-tx-events.normalized.jsonl
 * - wallet-wallet-executions.normalized.jsonl
 *
 * Usage:
 *   npx tsx src/scripts/wallet-tx-normalizer.ts
 *   npx tsx src/scripts/wallet-tx-normalizer.ts wallet-trades.enriched.jsonl
 */

import { writeFileSync, readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';
const TX_OUTPUT = 'wallet-tx-events.normalized.jsonl';
const WALLET_OUTPUT = 'wallet-wallet-executions.normalized.jsonl';
const PRICE_MATCH_TOLERANCE = 0.011;

interface EnrichedTrade {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    marketEnd: string | null;
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    outcome: string | null;
    size: number;
    price: number;
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    transactionHash: string | null;
    buyResolvedWin: boolean | null;
    buyHoldToResolutionPnl: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
        nearestSnapshotDeltaMs?: number | null;
        nearestSnapshotMatchedSummary?: {
            upQuoteAgeMs?: number | null;
            downQuoteAgeMs?: number | null;
        } | null;
        priceContext?: {
            outcomeSide?: 'UP' | 'DOWN';
            bestBid?: number;
            bestAsk?: number;
            likelyExecutionStyle?: string;
        } | null;
    };
}

type TxStructureLabel =
    | 'single_leg'
    | 'cross_outcome_same_side'
    | 'same_outcome_opposite_side'
    | 'cross_outcome_mixed_side'
    | 'same_outcome_same_side'
    | 'complex';

interface NormalizedLeg {
    wallet: string;
    side: 'BUY' | 'SELL';
    outcome: string | null;
    trades: number;
    totalSize: number;
    totalNotional: number;
    averagePrice: number;
    executionStyles: Record<string, number>;
    outsideBookReasonCounts: Record<string, number>;
    matchedSnapshotShare: number;
    avgTradeSecondsBeforeEnd: number | null;
    avgSnapshotDeltaMs: number | null;
    avgRelevantQuoteAgeMs: number | null;
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    buyResolvedWinRate: number | null;
    buyHoldPnl: number;
}

interface NormalizedTxEvent {
    normalizationVersion: 1;
    txHash: string;
    marketSlug: string | null;
    marketEnd: string | null;
    crypto: string;
    interval: number;
    rowCount: number;
    walletCount: number;
    outcomeCount: number;
    sideCount: number;
    structureLabel: TxStructureLabel;
    matchedSnapshotShare: number;
    walletExecutions: number;
    executionStyleCounts: Record<string, number>;
    outsideBookReasonCounts: Record<string, number>;
    legs: NormalizedLeg[];
}

interface NormalizedWalletExecution {
    normalizationVersion: 1;
    txHash: string;
    marketSlug: string | null;
    marketEnd: string | null;
    crypto: string;
    interval: number;
    wallet: string;
    txStructureLabel: TxStructureLabel;
    txRowCount: number;
    txWalletCount: number;
    txOutcomeCount: number;
    txSideCount: number;
    counterpartyCount: number;
    hasComplementaryTxOutcomes: boolean;
    hasMixedTxSides: boolean;
    walletLegCount: number;
    sides: string[];
    outcomes: string[];
    dominantActionLabel: string | null;
    dominantPrimitiveKey: string | null;
    executionStyles: Record<string, number>;
    outsideBookReasonCounts: Record<string, number>;
    matchedSnapshotShare: number;
    avgTradeSecondsBeforeEnd: number | null;
    avgSnapshotDeltaMs: number | null;
    avgRelevantQuoteAgeMs: number | null;
    totalNotional: number;
    buyHoldPnl: number;
    buyResolvedWinRate: number | null;
    legs: NormalizedLeg[];
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
    return Number((nums.reduce((sum, value) => sum + value, 0) / nums.length).toFixed(3));
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

function classifyTxStructure(rows: EnrichedTrade[]): TxStructureLabel {
    if (rows.length === 1) return 'single_leg';

    const outcomeCount = new Set(rows.map((row) => String(row.outcome ?? '').toUpperCase())).size;
    const sideCount = new Set(rows.map((row) => row.side)).size;

    if (outcomeCount === 2 && sideCount === 1) return 'cross_outcome_same_side';
    if (outcomeCount === 1 && sideCount === 2) return 'same_outcome_opposite_side';
    if (outcomeCount === 2 && sideCount === 2) return 'cross_outcome_mixed_side';
    if (outcomeCount === 1 && sideCount === 1) return 'same_outcome_same_side';
    return 'complex';
}

function relevantQuoteAgeMs(trade: EnrichedTrade): number | null {
    const side = trade.enrichment?.priceContext?.outcomeSide;
    const snap = trade.enrichment?.nearestSnapshotMatchedSummary;
    if (!side || !snap) return null;
    return side === 'UP' ? (snap.upQuoteAgeMs ?? null) : (snap.downQuoteAgeMs ?? null);
}

function classifyOutsideBook(trade: EnrichedTrade): 'price_improved' | 'worse_than_visible' | 'ambiguous' | 'not_outside_book' {
    const priceContext = trade.enrichment?.priceContext;
    if (!priceContext || priceContext.likelyExecutionStyle !== 'outside_book') {
        return 'not_outside_book';
    }

    const bestBid = priceContext.bestBid ?? 0;
    const bestAsk = priceContext.bestAsk ?? 1;
    if (trade.side === 'BUY') {
        if (trade.price < bestAsk - PRICE_MATCH_TOLERANCE) return 'price_improved';
        if (trade.price > bestAsk + PRICE_MATCH_TOLERANCE) return 'worse_than_visible';
    } else {
        if (trade.price > bestBid + PRICE_MATCH_TOLERANCE) return 'price_improved';
        if (trade.price < bestBid - PRICE_MATCH_TOLERANCE) return 'worse_than_visible';
    }

    return 'ambiguous';
}

function incrementCount(map: Map<string, number>, key: string): void {
    map.set(key, (map.get(key) ?? 0) + 1);
}

function buildNormalizedLeg(rows: EnrichedTrade[], wallet: string, side: 'BUY' | 'SELL', outcome: string | null): NormalizedLeg {
    const executionStyles = new Map<string, number>();
    const outsideBookReasonCounts = new Map<string, number>();
    const actionCounts = new Map<string, number>();
    const primitiveCounts = new Map<string, number>();
    let matchedSnapshots = 0;
    let buyWins = 0;
    let resolvedBuys = 0;
    let buyHoldPnl = 0;

    for (const row of rows) {
        incrementCount(executionStyles, row.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown');
        incrementCount(outsideBookReasonCounts, classifyOutsideBook(row));
        incrementCount(actionCounts, row.enrichment?.walletActionLabel ?? 'UNKNOWN');
        incrementCount(primitiveCounts, primitiveKey(row));
        if (row.enrichment?.matchedSnapshot) matchedSnapshots++;
        if (row.side === 'BUY' && row.buyResolvedWin !== null && row.buyHoldToResolutionPnl !== null) {
            resolvedBuys++;
            if (row.buyResolvedWin) buyWins++;
            buyHoldPnl += row.buyHoldToResolutionPnl;
        }
    }

    const dominantActionLabel = [...actionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const dominantPrimitiveKey = [...primitiveCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

    return {
        wallet,
        side,
        outcome,
        trades: rows.length,
        totalSize: Number(rows.reduce((sum, row) => sum + row.size, 0).toFixed(6)),
        totalNotional: Number(rows.reduce((sum, row) => sum + row.notional, 0).toFixed(6)),
        averagePrice: Number((rows.reduce((sum, row) => sum + row.price * row.size, 0) / Math.max(rows.reduce((sum, row) => sum + row.size, 0), 1e-9)).toFixed(6)),
        executionStyles: Object.fromEntries(executionStyles.entries()),
        outsideBookReasonCounts: Object.fromEntries([...outsideBookReasonCounts.entries()].filter(([, count]) => count > 0)),
        matchedSnapshotShare: Number((matchedSnapshots / rows.length).toFixed(4)),
        avgTradeSecondsBeforeEnd: mean(rows.map((row) => row.tradeSecondsBeforeEnd)),
        avgSnapshotDeltaMs: mean(rows.map((row) => row.enrichment?.nearestSnapshotDeltaMs ?? null)),
        avgRelevantQuoteAgeMs: mean(rows.map((row) => relevantQuoteAgeMs(row))),
        dominantActionLabel,
        dominantPrimitiveKey,
        buyResolvedWinRate: resolvedBuys > 0 ? Number((buyWins / resolvedBuys).toFixed(4)) : null,
        buyHoldPnl: Number(buyHoldPnl.toFixed(6)),
    };
}

function main(): void {
    const trades = loadJsonl<EnrichedTrade>(INPUT).filter((trade) => trade.enrichment?.matchedSnapshot && trade.transactionHash);
    const byTx = new Map<string, EnrichedTrade[]>();

    for (const trade of trades) {
        const txHash = trade.transactionHash!.toLowerCase();
        if (!byTx.has(txHash)) byTx.set(txHash, []);
        byTx.get(txHash)!.push(trade);
    }

    const txEvents: NormalizedTxEvent[] = [];
    const walletExecutions: NormalizedWalletExecution[] = [];
    const structureCounts = new Map<string, number>();

    for (const [txHash, rows] of byTx.entries()) {
        const ordered = [...rows].sort((a, b) => {
            const walletCmp = a.proxyWallet.localeCompare(b.proxyWallet);
            if (walletCmp !== 0) return walletCmp;
            const sideCmp = a.side.localeCompare(b.side);
            if (sideCmp !== 0) return sideCmp;
            return String(a.outcome ?? '').localeCompare(String(b.outcome ?? ''));
        });

        const structureLabel = classifyTxStructure(ordered);
        incrementCount(structureCounts, structureLabel);

        const wallets = new Set(ordered.map((row) => row.proxyWallet.toLowerCase()));
        const outcomes = new Set(ordered.map((row) => String(row.outcome ?? '').toUpperCase()));
        const sides = new Set(ordered.map((row) => row.side));
        const executionStyleCounts = new Map<string, number>();
        const outsideBookReasonCounts = new Map<string, number>();
        let matchedSnapshots = 0;

        for (const row of ordered) {
            incrementCount(executionStyleCounts, row.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown');
            incrementCount(outsideBookReasonCounts, classifyOutsideBook(row));
            if (row.enrichment?.matchedSnapshot) matchedSnapshots++;
        }

        const byWalletExecution = new Map<string, EnrichedTrade[]>();
        const byLeg = new Map<string, EnrichedTrade[]>();
        for (const row of ordered) {
            const walletKey = `${row.proxyWallet.toLowerCase()}||${row.marketSlug ?? 'unknown-market'}`;
            if (!byWalletExecution.has(walletKey)) byWalletExecution.set(walletKey, []);
            byWalletExecution.get(walletKey)!.push(row);

            const legKey = `${row.proxyWallet.toLowerCase()}||${row.side}||${row.outcome ?? 'UNKNOWN'}`;
            if (!byLeg.has(legKey)) byLeg.set(legKey, []);
            byLeg.get(legKey)!.push(row);
        }

        const legs = [...byLeg.entries()].map(([key, legRows]) => {
            const [wallet, side, outcome] = key.split('||');
            return buildNormalizedLeg(legRows, wallet, side as 'BUY' | 'SELL', outcome === 'UNKNOWN' ? null : outcome);
        });

        txEvents.push({
            normalizationVersion: 1,
            txHash,
            marketSlug: ordered[0]?.marketSlug ?? null,
            marketEnd: ordered[0]?.marketEnd ?? null,
            crypto: ordered[0]?.crypto ?? 'unknown',
            interval: ordered[0]?.interval ?? 0,
            rowCount: ordered.length,
            walletCount: wallets.size,
            outcomeCount: outcomes.size,
            sideCount: sides.size,
            structureLabel,
            matchedSnapshotShare: Number((matchedSnapshots / ordered.length).toFixed(4)),
            walletExecutions: byWalletExecution.size,
            executionStyleCounts: Object.fromEntries(executionStyleCounts.entries()),
            outsideBookReasonCounts: Object.fromEntries([...outsideBookReasonCounts.entries()].filter(([, count]) => count > 0)),
            legs,
        });

        for (const executionRows of byWalletExecution.values()) {
            const first = executionRows[0]!;
            const sidesForWallet = [...new Set(executionRows.map((row) => row.side))].sort();
            const outcomesForWallet = [...new Set(executionRows.map((row) => String(row.outcome ?? '').toUpperCase()))].sort();
            const walletLegs = legs.filter((leg) => leg.wallet === first.proxyWallet.toLowerCase());
            const executionStyles = new Map<string, number>();
            const outsideReasons = new Map<string, number>();
            const primitiveCounts = new Map<string, number>();
            const actionCounts = new Map<string, number>();
            let matchedWalletSnapshots = 0;
            let buyWins = 0;
            let resolvedBuys = 0;
            let buyHoldPnl = 0;

            for (const row of executionRows) {
                incrementCount(executionStyles, row.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown');
                incrementCount(outsideReasons, classifyOutsideBook(row));
                incrementCount(primitiveCounts, primitiveKey(row));
                incrementCount(actionCounts, row.enrichment?.walletActionLabel ?? 'UNKNOWN');
                if (row.enrichment?.matchedSnapshot) matchedWalletSnapshots++;
                if (row.side === 'BUY' && row.buyResolvedWin !== null && row.buyHoldToResolutionPnl !== null) {
                    resolvedBuys++;
                    if (row.buyResolvedWin) buyWins++;
                    buyHoldPnl += row.buyHoldToResolutionPnl;
                }
            }

            const dominantPrimitiveKey = [...primitiveCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
            const dominantActionLabel = [...actionCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

            walletExecutions.push({
                normalizationVersion: 1,
                txHash,
                marketSlug: first.marketSlug ?? null,
                marketEnd: first.marketEnd ?? null,
                crypto: first.crypto,
                interval: first.interval,
                wallet: first.proxyWallet.toLowerCase(),
                txStructureLabel: structureLabel,
                txRowCount: ordered.length,
                txWalletCount: wallets.size,
                txOutcomeCount: outcomes.size,
                txSideCount: sides.size,
                counterpartyCount: Math.max(wallets.size - 1, 0),
                hasComplementaryTxOutcomes: outcomes.size > 1,
                hasMixedTxSides: sides.size > 1,
                walletLegCount: walletLegs.length,
                sides: sidesForWallet,
                outcomes: outcomesForWallet,
                dominantActionLabel,
                dominantPrimitiveKey,
                executionStyles: Object.fromEntries(executionStyles.entries()),
                outsideBookReasonCounts: Object.fromEntries([...outsideReasons.entries()].filter(([, count]) => count > 0)),
                matchedSnapshotShare: Number((matchedWalletSnapshots / executionRows.length).toFixed(4)),
                avgTradeSecondsBeforeEnd: mean(executionRows.map((row) => row.tradeSecondsBeforeEnd)),
                avgSnapshotDeltaMs: mean(executionRows.map((row) => row.enrichment?.nearestSnapshotDeltaMs ?? null)),
                avgRelevantQuoteAgeMs: mean(executionRows.map((row) => relevantQuoteAgeMs(row))),
                totalNotional: Number(executionRows.reduce((sum, row) => sum + row.notional, 0).toFixed(6)),
                buyHoldPnl: Number(buyHoldPnl.toFixed(6)),
                buyResolvedWinRate: resolvedBuys > 0 ? Number((buyWins / resolvedBuys).toFixed(4)) : null,
                legs: walletLegs,
            });
        }
    }

    writeFileSync(TX_OUTPUT, txEvents.map((event) => JSON.stringify(event)).join('\n') + '\n');
    writeFileSync(WALLET_OUTPUT, walletExecutions.map((event) => JSON.stringify(event)).join('\n') + '\n');

    console.log(`Matched enriched trades loaded: ${trades.length}`);
    console.log(`Normalized tx events written: ${txEvents.length} -> ${TX_OUTPUT}`);
    console.log(`Normalized wallet executions written: ${walletExecutions.length} -> ${WALLET_OUTPUT}`);
    console.log('\nTop tx structure counts');
    for (const [label, count] of [...structureCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${label.padEnd(26)} ${String(count).padStart(6)}`);
    }
}

main();
