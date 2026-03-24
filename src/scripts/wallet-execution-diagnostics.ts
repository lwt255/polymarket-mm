/**
 * Execution diagnostics for enriched wallet trades.
 *
 * Purpose:
 * - explain why many promising primitives show heavy `outside_book` prints
 * - distinguish likely price improvement from worse-than-visible fills
 * - measure whether stale quotes or transaction-hash pairing explain the gap
 *
 * Usage:
 *   npx tsx src/scripts/wallet-execution-diagnostics.ts
 *   npx tsx src/scripts/wallet-execution-diagnostics.ts wallet-trades.enriched.jsonl
 */

import { readFileSync } from 'node:fs';

const INPUT = process.argv[2] || 'wallet-trades.enriched.jsonl';
const PRICE_MATCH_TOLERANCE = 0.011;

interface EnrichedTrade {
    crypto: string;
    interval: number;
    marketSlug: string | null;
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    outcome: string | null;
    price: number;
    notional: number;
    tradeSecondsBeforeEnd: number | null;
    transactionHash: string | null;
    buyResolvedWin: boolean | null;
    buyHoldToResolutionPnl: number | null;
    enrichment?: {
        matchedSnapshot?: boolean;
        nearestSnapshotDeltaMs?: number | null;
        walletActionLabel?: string;
        regimeLabels?: {
            t60State?: string;
        } | null;
        nearestSnapshotMatchedSummary?: {
            snapshotState?: string | null;
            upQuoteAgeMs?: number | null;
            downQuoteAgeMs?: number | null;
        } | null;
        priceContext?: {
            outcomeSide?: 'UP' | 'DOWN';
            bestBid?: number;
            bestAsk?: number;
            priceVsBidCents?: number;
            priceVsAskCents?: number;
            likelyExecutionStyle?: string;
        } | null;
    };
}

interface TxMeta {
    count: number;
    wallets: Set<string>;
    outcomes: Set<string>;
    sides: Set<string>;
    markets: Set<string>;
}

interface PrimitiveDiagnostic {
    primitive: string;
    trades: number;
    notional: number;
    outsideBookTrades: number;
    outsideBookShare: number;
    priceImprovedShare: number;
    worseThanVisibleShare: number;
    freshOutsideBookShare: number;
    staleOutsideBookShare: number;
    pairedTxShare: number;
    dualOutcomeTxShare: number;
    buyHoldRoi: number | null;
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

function relevantQuoteAgeMs(trade: EnrichedTrade): number | null {
    const side = trade.enrichment?.priceContext?.outcomeSide;
    const snap = trade.enrichment?.nearestSnapshotMatchedSummary;
    if (!snap || !side) return null;
    return side === 'UP' ? (snap.upQuoteAgeMs ?? null) : (snap.downQuoteAgeMs ?? null);
}

function quoteAgeBucket(ageMs: number | null): string {
    if (ageMs === null || !Number.isFinite(ageMs)) return 'unknown';
    if (ageMs <= 250) return '<=250ms';
    if (ageMs <= 1000) return '251ms-1s';
    if (ageMs <= 5000) return '1s-5s';
    return '>5s';
}

function snapshotDeltaBucket(deltaMs: number | null | undefined): string {
    if (deltaMs === null || deltaMs === undefined || !Number.isFinite(deltaMs)) return 'unknown';
    if (deltaMs <= 1000) return '<=1s';
    if (deltaMs <= 5000) return '1s-5s';
    if (deltaMs <= 10000) return '5s-10s';
    return '10s-20s';
}

function classifyOutsideBook(trade: EnrichedTrade): 'price_improved' | 'worse_than_visible' | 'ambiguous' | 'not_outside_book' {
    const priceContext = trade.enrichment?.priceContext;
    if (!priceContext || priceContext.likelyExecutionStyle !== 'outside_book') {
        return 'not_outside_book';
    }

    const bestBid = priceContext.bestBid ?? 0;
    const bestAsk = priceContext.bestAsk ?? 1;
    const tradePrice = trade.price;

    if (trade.side === 'BUY') {
        if (tradePrice < bestAsk - PRICE_MATCH_TOLERANCE) return 'price_improved';
        if (tradePrice > bestAsk + PRICE_MATCH_TOLERANCE) return 'worse_than_visible';
    } else {
        if (tradePrice > bestBid + PRICE_MATCH_TOLERANCE) return 'price_improved';
        if (tradePrice < bestBid - PRICE_MATCH_TOLERANCE) return 'worse_than_visible';
    }

    return 'ambiguous';
}

function buildTxMeta(trades: EnrichedTrade[]): Map<string, TxMeta> {
    const txMeta = new Map<string, TxMeta>();

    for (const trade of trades) {
        const tx = trade.transactionHash?.toLowerCase();
        if (!tx) continue;

        if (!txMeta.has(tx)) {
            txMeta.set(tx, {
                count: 0,
                wallets: new Set<string>(),
                outcomes: new Set<string>(),
                sides: new Set<string>(),
                markets: new Set<string>(),
            });
        }

        const meta = txMeta.get(tx)!;
        meta.count++;
        meta.wallets.add(trade.proxyWallet.toLowerCase());
        if (trade.outcome) meta.outcomes.add(trade.outcome.toUpperCase());
        meta.sides.add(trade.side);
        meta.markets.add(trade.marketSlug ?? 'unknown-market');
    }

    return txMeta;
}

function main(): void {
    const trades = loadJsonl<EnrichedTrade>(INPUT);
    const matchedTrades = trades.filter((trade) => trade.enrichment?.matchedSnapshot);
    const txMeta = buildTxMeta(matchedTrades);

    const styleCounts = new Map<string, number>();
    const outsideBookReasonCounts = new Map<string, number>();
    const quoteAgeCounts = new Map<string, number>();
    const deltaCounts = new Map<string, number>();

    let outsideBookTrades = 0;
    let outsideBookNotional = 0;
    let outsideBookFresh = 0;
    let outsideBookStale = 0;
    let outsideBookPairedTx = 0;
    let outsideBookDualOutcomeTx = 0;
    let outsideBookMultiWalletTx = 0;
    let outsideBookPriceImproved = 0;
    let outsideBookWorseThanVisible = 0;

    const primitiveBuckets = new Map<string, {
        trades: number;
        notional: number;
        outsideBookTrades: number;
        outsideBookPriceImproved: number;
        outsideBookWorseThanVisible: number;
        outsideBookFresh: number;
        outsideBookStale: number;
        outsideBookPairedTx: number;
        outsideBookDualOutcomeTx: number;
        buyHoldPnl: number;
        resolvedBuyTrades: number;
    }>();

    for (const trade of matchedTrades) {
        const style = trade.enrichment?.priceContext?.likelyExecutionStyle ?? 'unknown';
        styleCounts.set(style, (styleCounts.get(style) ?? 0) + 1);

        const primitive = primitiveKey(trade);
        if (!primitiveBuckets.has(primitive)) {
            primitiveBuckets.set(primitive, {
                trades: 0,
                notional: 0,
                outsideBookTrades: 0,
                outsideBookPriceImproved: 0,
                outsideBookWorseThanVisible: 0,
                outsideBookFresh: 0,
                outsideBookStale: 0,
                outsideBookPairedTx: 0,
                outsideBookDualOutcomeTx: 0,
                buyHoldPnl: 0,
                resolvedBuyTrades: 0,
            });
        }

        const primitiveBucket = primitiveBuckets.get(primitive)!;
        primitiveBucket.trades++;
        primitiveBucket.notional += trade.notional;

        if (trade.side === 'BUY' && trade.buyHoldToResolutionPnl !== null) {
            primitiveBucket.buyHoldPnl += trade.buyHoldToResolutionPnl;
            primitiveBucket.resolvedBuyTrades++;
        }

        if (style !== 'outside_book') continue;

        outsideBookTrades++;
        outsideBookNotional += trade.notional;
        primitiveBucket.outsideBookTrades++;

        const reason = classifyOutsideBook(trade);
        outsideBookReasonCounts.set(reason, (outsideBookReasonCounts.get(reason) ?? 0) + 1);
        if (reason === 'price_improved') {
            outsideBookPriceImproved++;
            primitiveBucket.outsideBookPriceImproved++;
        } else if (reason === 'worse_than_visible') {
            outsideBookWorseThanVisible++;
            primitiveBucket.outsideBookWorseThanVisible++;
        }

        const ageBucket = quoteAgeBucket(relevantQuoteAgeMs(trade));
        quoteAgeCounts.set(ageBucket, (quoteAgeCounts.get(ageBucket) ?? 0) + 1);
        if (ageBucket === '<=250ms' || ageBucket === '251ms-1s') {
            outsideBookFresh++;
            primitiveBucket.outsideBookFresh++;
        } else if (ageBucket === '1s-5s' || ageBucket === '>5s') {
            outsideBookStale++;
            primitiveBucket.outsideBookStale++;
        }

        const deltaBucket = snapshotDeltaBucket(trade.enrichment?.nearestSnapshotDeltaMs);
        deltaCounts.set(deltaBucket, (deltaCounts.get(deltaBucket) ?? 0) + 1);

        const tx = trade.transactionHash?.toLowerCase();
        const meta = tx ? txMeta.get(tx) : null;
        if (meta && meta.count > 1) {
            outsideBookPairedTx++;
            primitiveBucket.outsideBookPairedTx++;
        }
        if (meta && meta.outcomes.size > 1) {
            outsideBookDualOutcomeTx++;
            primitiveBucket.outsideBookDualOutcomeTx++;
        }
        if (meta && meta.wallets.size > 1) {
            outsideBookMultiWalletTx++;
        }
    }

    const primitiveDiagnostics: PrimitiveDiagnostic[] = [...primitiveBuckets.entries()]
        .map(([primitive, bucket]) => ({
            primitive,
            trades: bucket.trades,
            notional: bucket.notional,
            outsideBookTrades: bucket.outsideBookTrades,
            outsideBookShare: bucket.trades > 0 ? bucket.outsideBookTrades / bucket.trades : 0,
            priceImprovedShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookPriceImproved / bucket.outsideBookTrades : 0,
            worseThanVisibleShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookWorseThanVisible / bucket.outsideBookTrades : 0,
            freshOutsideBookShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookFresh / bucket.outsideBookTrades : 0,
            staleOutsideBookShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookStale / bucket.outsideBookTrades : 0,
            pairedTxShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookPairedTx / bucket.outsideBookTrades : 0,
            dualOutcomeTxShare: bucket.outsideBookTrades > 0 ? bucket.outsideBookDualOutcomeTx / bucket.outsideBookTrades : 0,
            buyHoldRoi: bucket.notional > 0 ? bucket.buyHoldPnl / bucket.notional : null,
        }))
        .filter((row) => row.trades >= 100 && row.outsideBookTrades >= 25)
        .sort((a, b) => {
            if (b.outsideBookTrades !== a.outsideBookTrades) return b.outsideBookTrades - a.outsideBookTrades;
            return b.trades - a.trades;
        });

    console.log(`Loaded ${trades.length} enriched trades from ${INPUT}`);
    console.log(`Matched trades used: ${matchedTrades.length}`);
    console.log(`Outside-book matched trades: ${outsideBookTrades} (${formatPct(matchedTrades.length > 0 ? outsideBookTrades / matchedTrades.length : 0)})`);
    console.log(`Outside-book matched notional: ${formatUsd(outsideBookNotional)}`);

    console.log('\nExecution Style Mix');
    for (const [style, count] of [...styleCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${style.padEnd(14)} ${String(count).padStart(6)} | ${formatPct(matchedTrades.length > 0 ? count / matchedTrades.length : 0)}`);
    }

    console.log('\nOutside-Book Reason Split');
    for (const [reason, count] of [...outsideBookReasonCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${reason.padEnd(20)} ${String(count).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? count / outsideBookTrades : 0)}`);
    }

    console.log('\nOutside-Book Quote Age');
    for (const [bucket, count] of [...quoteAgeCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${bucket.padEnd(10)} ${String(count).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? count / outsideBookTrades : 0)}`);
    }

    console.log('\nOutside-Book Snapshot Delta');
    for (const [bucket, count] of [...deltaCounts.entries()].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${bucket.padEnd(10)} ${String(count).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? count / outsideBookTrades : 0)}`);
    }

    console.log('\nOutside-Book Pairing Signals');
    console.log(`  paired_tx          ${String(outsideBookPairedTx).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? outsideBookPairedTx / outsideBookTrades : 0)}`);
    console.log(`  dual_outcome_tx    ${String(outsideBookDualOutcomeTx).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? outsideBookDualOutcomeTx / outsideBookTrades : 0)}`);
    console.log(`  multi_wallet_tx    ${String(outsideBookMultiWalletTx).padStart(6)} | ${formatPct(outsideBookTrades > 0 ? outsideBookMultiWalletTx / outsideBookTrades : 0)}`);

    console.log('\nTop Primitive Diagnostics');
    for (const row of primitiveDiagnostics.slice(0, 12)) {
        console.log(
            `  ${row.primitive.padEnd(36)} | trades ${String(row.trades).padStart(5)} | ` +
            `out_book ${String(row.outsideBookTrades).padStart(5)} (${formatPct(row.outsideBookShare).padStart(6)}) | ` +
            `improved ${formatPct(row.priceImprovedShare).padStart(6)} | worse ${formatPct(row.worseThanVisibleShare).padStart(6)} | ` +
            `fresh ${formatPct(row.freshOutsideBookShare).padStart(6)} | paired ${formatPct(row.pairedTxShare).padStart(6)} | ` +
            `dual ${formatPct(row.dualOutcomeTxShare).padStart(6)} | roi ${row.buyHoldRoi === null ? 'N/A'.padStart(8) : formatPct(row.buyHoldRoi).padStart(8)}`
        );
    }

    const bestTwoSidedUnderdog = primitiveDiagnostics
        .filter((row) => row.primitive.startsWith('BUY_UNDERDOG | two-sided'))
        .sort((a, b) => {
            if ((b.buyHoldRoi ?? -Infinity) !== (a.buyHoldRoi ?? -Infinity)) {
                return (b.buyHoldRoi ?? -Infinity) - (a.buyHoldRoi ?? -Infinity);
            }
            return b.trades - a.trades;
        })[0];

    console.log('\nInterpretation Helpers');
    console.log(`  price_improved_outside_book: ${formatPct(outsideBookTrades > 0 ? outsideBookPriceImproved / outsideBookTrades : 0)}`);
    console.log(`  worse_than_visible_outside_book: ${formatPct(outsideBookTrades > 0 ? outsideBookWorseThanVisible / outsideBookTrades : 0)}`);
    console.log(`  fresh_quote_outside_book: ${formatPct(outsideBookTrades > 0 ? outsideBookFresh / outsideBookTrades : 0)}`);
    console.log(`  stale_quote_outside_book: ${formatPct(outsideBookTrades > 0 ? outsideBookStale / outsideBookTrades : 0)}`);
    if (bestTwoSidedUnderdog) {
        console.log(
            `  best two-sided underdog diagnostic: ${bestTwoSidedUnderdog.primitive} | ` +
            `improved ${formatPct(bestTwoSidedUnderdog.priceImprovedShare)} | ` +
            `worse ${formatPct(bestTwoSidedUnderdog.worseThanVisibleShare)} | ` +
            `paired ${formatPct(bestTwoSidedUnderdog.pairedTxShare)}`
        );
    }
}

main();
