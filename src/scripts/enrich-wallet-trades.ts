/**
 * Enrich raw wallet trades with collector market-state context.
 *
 * Purpose:
 * - join public wallet trade prints to pricing collector records by market slug
 * - attach nearest observed snapshot context when the trade falls inside the
 *   collector's late-window observation range
 * - preserve strict separation between observed data and inferred labels
 *
 * Input:
 * - wallet-trades.raw.jsonl
 * - pricing-data.raw.jsonl
 *
 * Output:
 * - wallet-trades.enriched.jsonl
 *
 * Usage:
 *   npx tsx src/scripts/enrich-wallet-trades.ts
 *   npx tsx src/scripts/enrich-wallet-trades.ts wallet-trades.raw.jsonl pricing-data.raw.jsonl
 */

import { readFileSync, writeFileSync } from 'node:fs';
import {
    bucketFirstOneSidedTime,
    bucketFirstTradableTime,
    getFavoriteSide,
    getLiquidityProfile,
    getSnapshotState,
    getUnderdogSide,
    getWindowState,
    type LiquidityProfile,
    type LiquidityWindowState,
    type PricingSnapshot,
} from './pricing-data-utils.js';

const WALLET_INPUT = process.argv[2] || 'wallet-trades.raw.jsonl';
const PRICING_INPUT = process.argv[3] || 'pricing-data.raw.jsonl';
const OUTPUT = 'wallet-trades.enriched.jsonl';

const SNAPSHOT_MATCH_TOLERANCE_MS = 20_000;
const PRICE_MATCH_TOLERANCE = 0.011;

interface WalletTradeRecord {
    collectedAt: string;
    source: string;
    crypto: string;
    interval: number;
    marketId: string | null;
    conditionId: string;
    marketSlug: string | null;
    marketTitle: string | null;
    marketEnd: string | null;
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    asset: string;
    outcome: string | null;
    outcomeIndex: number | null;
    size: number;
    price: number;
    notional: number;
    timestamp: number;
    tradeIsoTime: string;
    transactionHash: string | null;
    name: string | null;
    pseudonym: string | null;
    bio: string | null;
    profileImage: string | null;
    profileImageOptimized: string | null;
    raw: Record<string, unknown>;
}

interface EnrichedPricingSnapshot extends PricingSnapshot {
    timestamp: number;
    targetTimestamp?: number;
    targetSecondsBeforeEnd?: number;
    upSpread?: number;
    downSpread?: number;
    clPrice?: number;
    clMoveFromOpen?: number;
    hourUTC?: number;
    bookShape?: {
        underdogSide?: 'UP' | 'DOWN';
        favoriteSide?: 'UP' | 'DOWN';
        underdogBestAskDepth?: number;
        favoriteBestBidDepth?: number;
    };
    executionAtSize?: Record<string, unknown>;
    collectionQuality?: {
        totalFetchLatencyMs?: number;
        captureDelayMs?: number;
        upQuoteAgeMs?: number | null;
        downQuoteAgeMs?: number | null;
    };
    underlyingPath?: {
        moveLast30s?: number | null;
        moveLast60s?: number | null;
        moveLast120s?: number | null;
        realizedVolSoFarDollars?: number;
        realizedVolSoFarBps?: number;
    };
}

interface PricingRecord {
    slug: string;
    marketEnd: number;
    collectedAt?: string;
    resolution?: string;
    snapshots: EnrichedPricingSnapshot[];
    liquidityProfile?: LiquidityProfile;
    regimeLabels?: DerivedRegimeLabels;
    quoteStability?: Record<string, unknown>;
    underlyingPathProfile?: Record<string, unknown>;
    collectionProfile?: Record<string, unknown>;
}

interface DerivedRegimeLabels {
    t120State: LiquidityWindowState;
    t90State: LiquidityWindowState;
    t60State: LiquidityWindowState;
    firstTradableBucket: string;
    firstOneSidedBucket: string;
    collapseBeforeT120: boolean;
    collapseBeforeT60: boolean;
    tradableByT120: boolean;
    tradableByT90: boolean;
    tradableByT60: boolean;
}

interface SnapshotJoinResult {
    nearestSnapshot: EnrichedPricingSnapshot | null;
    nearestSnapshotDeltaMs: number | null;
    insideObservedWindow: boolean;
    matchedWithinTolerance: boolean;
    observedWindowMinSecondsBeforeEnd: number | null;
    observedWindowMaxSecondsBeforeEnd: number | null;
}

interface PriceContext {
    outcomeSide: 'UP' | 'DOWN';
    bestBid: number;
    bestAsk: number;
    midpoint: number;
    priceVsBidCents: number;
    priceVsAskCents: number;
    priceVsMidCents: number;
    likelyExecutionStyle: 'near_ask' | 'near_bid' | 'inside_spread' | 'outside_book' | 'unknown';
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

function normalizeOutcome(outcome: string | null): 'UP' | 'DOWN' | null {
    if (!outcome) return null;
    const upper = outcome.toUpperCase();
    if (upper === 'UP') return 'UP';
    if (upper === 'DOWN') return 'DOWN';
    return null;
}

function deriveRegimeLabels(record: PricingRecord): DerivedRegimeLabels {
    if (record.regimeLabels) {
        return record.regimeLabels;
    }

    const profile = getLiquidityProfile(record);
    return {
        t120State: getWindowState(record.snapshots, 110, 130),
        t90State: getWindowState(record.snapshots, 80, 100),
        t60State: getWindowState(record.snapshots, 50, 70),
        firstTradableBucket: bucketFirstTradableTime(profile.earliestTradableSecondsBeforeEnd),
        firstOneSidedBucket: bucketFirstOneSidedTime(profile.earliestOneSidedSecondsBeforeEnd),
        collapseBeforeT120: profile.earliestOneSidedSecondsBeforeEnd !== null && profile.earliestOneSidedSecondsBeforeEnd >= 110,
        collapseBeforeT60: profile.earliestOneSidedSecondsBeforeEnd !== null && profile.earliestOneSidedSecondsBeforeEnd >= 50,
        tradableByT120: profile.hasTradableT120,
        tradableByT90: profile.tradableSnapshotSeconds.some((sec) => sec >= 80 && sec <= 100),
        tradableByT60: profile.hasTradableT60,
    };
}

function buildSnapshotJoin(record: PricingRecord, tradeTimestampMs: number, tradeSecondsBeforeEnd: number): SnapshotJoinResult {
    if (!record.snapshots || record.snapshots.length === 0) {
        return {
            nearestSnapshot: null,
            nearestSnapshotDeltaMs: null,
            insideObservedWindow: false,
            matchedWithinTolerance: false,
            observedWindowMinSecondsBeforeEnd: null,
            observedWindowMaxSecondsBeforeEnd: null,
        };
    }

    const observedSeconds = record.snapshots.map((snapshot) => snapshot.secondsBeforeEnd);
    const observedWindowMinSecondsBeforeEnd = Math.min(...observedSeconds);
    const observedWindowMaxSecondsBeforeEnd = Math.max(...observedSeconds);
    const insideObservedWindow =
        tradeSecondsBeforeEnd >= observedWindowMinSecondsBeforeEnd
        && tradeSecondsBeforeEnd <= observedWindowMaxSecondsBeforeEnd;

    let nearestSnapshot: EnrichedPricingSnapshot | null = null;
    let nearestSnapshotDeltaMs: number | null = null;

    for (const snapshot of record.snapshots) {
        const deltaMs = Math.abs(snapshot.timestamp - tradeTimestampMs);
        if (nearestSnapshotDeltaMs === null || deltaMs < nearestSnapshotDeltaMs) {
            nearestSnapshot = snapshot;
            nearestSnapshotDeltaMs = deltaMs;
        }
    }

    return {
        nearestSnapshot,
        nearestSnapshotDeltaMs,
        insideObservedWindow,
        matchedWithinTolerance: insideObservedWindow && nearestSnapshotDeltaMs !== null && nearestSnapshotDeltaMs <= SNAPSHOT_MATCH_TOLERANCE_MS,
        observedWindowMinSecondsBeforeEnd,
        observedWindowMaxSecondsBeforeEnd,
    };
}

function buildPriceContext(outcome: 'UP' | 'DOWN' | null, tradeSide: 'BUY' | 'SELL', tradePrice: number, snapshot: EnrichedPricingSnapshot | null): PriceContext | null {
    if (!snapshot || !outcome) return null;

    const bestBid = outcome === 'UP' ? snapshot.upBid : snapshot.downBid;
    const bestAsk = outcome === 'UP' ? snapshot.upAsk : snapshot.downAsk;
    const midpoint = outcome === 'UP' ? snapshot.upMid : snapshot.downMid;
    const priceVsBidCents = Number(((tradePrice - bestBid) * 100).toFixed(4));
    const priceVsAskCents = Number(((tradePrice - bestAsk) * 100).toFixed(4));
    const priceVsMidCents = Number(((tradePrice - midpoint) * 100).toFixed(4));

    let likelyExecutionStyle: PriceContext['likelyExecutionStyle'] = 'unknown';
    if (tradeSide === 'BUY') {
        if (Math.abs(tradePrice - bestAsk) <= PRICE_MATCH_TOLERANCE) likelyExecutionStyle = 'near_ask';
        else if (tradePrice >= bestBid - PRICE_MATCH_TOLERANCE && tradePrice <= bestAsk + PRICE_MATCH_TOLERANCE) likelyExecutionStyle = 'inside_spread';
        else likelyExecutionStyle = 'outside_book';
    } else {
        if (Math.abs(tradePrice - bestBid) <= PRICE_MATCH_TOLERANCE) likelyExecutionStyle = 'near_bid';
        else if (tradePrice >= bestBid - PRICE_MATCH_TOLERANCE && tradePrice <= bestAsk + PRICE_MATCH_TOLERANCE) likelyExecutionStyle = 'inside_spread';
        else likelyExecutionStyle = 'outside_book';
    }

    return {
        outcomeSide: outcome,
        bestBid,
        bestAsk,
        midpoint,
        priceVsBidCents,
        priceVsAskCents,
        priceVsMidCents,
        likelyExecutionStyle,
    };
}

function buildBehaviorLabels(outcome: 'UP' | 'DOWN' | null, trade: WalletTradeRecord, snapshot: EnrichedPricingSnapshot | null): {
    tradeOutcomeRole: 'underdog' | 'favorite' | 'unknown';
    walletActionLabel: string;
} {
    if (!snapshot || !outcome) {
        return {
            tradeOutcomeRole: 'unknown',
            walletActionLabel: `${trade.side}_UNKNOWN`,
        };
    }

    const underdog = getUnderdogSide(snapshot);
    const favorite = getFavoriteSide(snapshot);
    const tradeOutcomeRole = outcome === underdog ? 'underdog' : outcome === favorite ? 'favorite' : 'unknown';

    return {
        tradeOutcomeRole,
        walletActionLabel: `${trade.side}_${tradeOutcomeRole.toUpperCase()}`,
    };
}

function summarizeSnapshot(snapshot: EnrichedPricingSnapshot | null): Record<string, unknown> | null {
    if (!snapshot) return null;

    return {
        timestamp: snapshot.timestamp,
        secondsBeforeEnd: snapshot.secondsBeforeEnd,
        targetSecondsBeforeEnd: snapshot.targetSecondsBeforeEnd ?? null,
        upBid: snapshot.upBid,
        upAsk: snapshot.upAsk,
        downBid: snapshot.downBid,
        downAsk: snapshot.downAsk,
        upMid: snapshot.upMid,
        downMid: snapshot.downMid,
        clPrice: snapshot.clPrice ?? null,
        clMoveFromOpen: snapshot.clMoveFromOpen ?? null,
        snapshotState: getSnapshotState(snapshot),
        underdogSide: getUnderdogSide(snapshot),
        favoriteSide: getFavoriteSide(snapshot),
        underdogBestAskDepth: snapshot.bookShape?.underdogBestAskDepth ?? null,
        favoriteBestBidDepth: snapshot.bookShape?.favoriteBestBidDepth ?? null,
        totalFetchLatencyMs: snapshot.collectionQuality?.totalFetchLatencyMs ?? null,
        captureDelayMs: snapshot.collectionQuality?.captureDelayMs ?? null,
        upQuoteAgeMs: snapshot.collectionQuality?.upQuoteAgeMs ?? null,
        downQuoteAgeMs: snapshot.collectionQuality?.downQuoteAgeMs ?? null,
        moveLast30s: snapshot.underlyingPath?.moveLast30s ?? null,
        moveLast60s: snapshot.underlyingPath?.moveLast60s ?? null,
        moveLast120s: snapshot.underlyingPath?.moveLast120s ?? null,
    };
}

function enrichTrade(trade: WalletTradeRecord, pricingRecord: PricingRecord | undefined): Record<string, unknown> {
    const tradeTimestampMs = trade.timestamp * 1000;
    const marketEndMs = trade.marketEnd ? new Date(trade.marketEnd).getTime() : null;
    const tradeSecondsBeforeEnd = marketEndMs !== null ? Number(((marketEndMs - tradeTimestampMs) / 1000).toFixed(3)) : null;
    const normalizedOutcome = normalizeOutcome(trade.outcome);
    const resolvedOutcome = pricingRecord ? normalizeOutcome(pricingRecord.resolution ?? null) : null;
    const outcomeMatchesResolution = normalizedOutcome !== null && resolvedOutcome !== null
        ? normalizedOutcome === resolvedOutcome
        : null;
    const buyHoldToResolutionPnl = trade.side === 'BUY' && normalizedOutcome !== null && resolvedOutcome !== null
        ? Number((trade.size * (outcomeMatchesResolution ? (1 - trade.price) : -trade.price)).toFixed(6))
        : null;
    const buyResolvedWin = trade.side === 'BUY' && outcomeMatchesResolution !== null
        ? outcomeMatchesResolution
        : null;

    if (!pricingRecord || tradeSecondsBeforeEnd === null) {
        return {
            ...trade,
            enrichmentVersion: 1,
            pricingRecordFound: Boolean(pricingRecord),
            resolvedOutcome,
            outcomeMatchesResolution,
            buyResolvedWin,
            buyHoldToResolutionPnl,
            tradeSecondsBeforeEnd,
            enrichment: {
                matchedPricingRecord: Boolean(pricingRecord),
                matchedSnapshot: false,
                reason: pricingRecord ? 'missing_market_end' : 'missing_pricing_record',
            },
        };
    }

    const liquidityProfile = getLiquidityProfile(pricingRecord);
    const regimeLabels = deriveRegimeLabels(pricingRecord);
    const snapshotJoin = buildSnapshotJoin(pricingRecord, tradeTimestampMs, tradeSecondsBeforeEnd);
    const priceContext = buildPriceContext(normalizedOutcome, trade.side, trade.price, snapshotJoin.matchedWithinTolerance ? snapshotJoin.nearestSnapshot : null);
    const behaviorLabels = buildBehaviorLabels(normalizedOutcome, trade, snapshotJoin.matchedWithinTolerance ? snapshotJoin.nearestSnapshot : null);

    return {
        ...trade,
        enrichmentVersion: 1,
        pricingRecordFound: true,
        resolvedOutcome,
        outcomeMatchesResolution,
        buyResolvedWin,
        buyHoldToResolutionPnl,
        tradeSecondsBeforeEnd,
        enrichment: {
            matchedPricingRecord: true,
            pricingRecordCollectedAt: pricingRecord.collectedAt ?? null,
            pricingMarketEnd: pricingRecord.marketEnd,
            pricingResolution: pricingRecord.resolution ?? null,
            observedWindowMinSecondsBeforeEnd: snapshotJoin.observedWindowMinSecondsBeforeEnd,
            observedWindowMaxSecondsBeforeEnd: snapshotJoin.observedWindowMaxSecondsBeforeEnd,
            insideObservedWindow: snapshotJoin.insideObservedWindow,
            matchedSnapshot: snapshotJoin.matchedWithinTolerance,
            nearestSnapshotDeltaMs: snapshotJoin.nearestSnapshotDeltaMs,
            nearestSnapshot: summarizeSnapshot(snapshotJoin.nearestSnapshot),
            nearestSnapshotMatched: snapshotJoin.matchedWithinTolerance,
            nearestSnapshotMatchedSummary: summarizeSnapshot(snapshotJoin.matchedWithinTolerance ? snapshotJoin.nearestSnapshot : null),
            liquidityProfile: {
                tradableRatio: liquidityProfile.tradableRatio,
                twoSidedRatio: liquidityProfile.twoSidedRatio,
                oneSidedRatio: liquidityProfile.oneSidedRatio,
                stateTransitionCount: liquidityProfile.stateTransitionCount,
                oneSidedReopenCount: liquidityProfile.oneSidedReopenCount,
                earliestTradableSecondsBeforeEnd: liquidityProfile.earliestTradableSecondsBeforeEnd,
                earliestOneSidedSecondsBeforeEnd: liquidityProfile.earliestOneSidedSecondsBeforeEnd,
                hasTradableT120: liquidityProfile.hasTradableT120,
                hasTwoSidedT120: liquidityProfile.hasTwoSidedT120,
                hasTwoSidedT90: liquidityProfile.hasTwoSidedT90,
                hasTwoSidedT60: liquidityProfile.hasTwoSidedT60,
                hasOneSidedT120: liquidityProfile.hasOneSidedT120,
                hasOneSidedT90: liquidityProfile.hasOneSidedT90,
                hasOneSidedT60: liquidityProfile.hasOneSidedT60,
            },
            regimeLabels,
            quoteStability: pricingRecord.quoteStability ?? null,
            underlyingPathProfile: pricingRecord.underlyingPathProfile ?? null,
            collectionProfile: pricingRecord.collectionProfile ?? null,
            tradeOutcomeRole: behaviorLabels.tradeOutcomeRole,
            walletActionLabel: behaviorLabels.walletActionLabel,
            priceContext,
        },
    };
}

function main(): void {
    const walletTrades = loadJsonl<WalletTradeRecord>(WALLET_INPUT);
    const pricingRecords = loadJsonl<PricingRecord>(PRICING_INPUT);

    const pricingBySlug = new Map<string, PricingRecord>();
    for (const record of pricingRecords) {
        pricingBySlug.set(record.slug, record);
    }

    let matchedPricingRecord = 0;
    let matchedSnapshot = 0;
    let insideObservedWindow = 0;
    let missingPricingRecord = 0;

    const outputLines = walletTrades.map((trade) => {
        const pricingRecord = trade.marketSlug ? pricingBySlug.get(trade.marketSlug) : undefined;
        const enriched = enrichTrade(trade, pricingRecord);
        const enrichment = enriched.enrichment as Record<string, unknown> | undefined;

        if (pricingRecord) matchedPricingRecord++;
        else missingPricingRecord++;

        if (enrichment?.insideObservedWindow) insideObservedWindow++;
        if (enrichment?.matchedSnapshot) matchedSnapshot++;

        return JSON.stringify(enriched);
    });

    writeFileSync(OUTPUT, outputLines.join('\n') + '\n');

    console.log(`Wallet trades loaded: ${walletTrades.length}`);
    console.log(`Pricing records loaded: ${pricingRecords.length}`);
    console.log(`Matched pricing records: ${matchedPricingRecord}`);
    console.log(`Missing pricing records: ${missingPricingRecord}`);
    console.log(`Inside observed pricing window: ${insideObservedWindow}`);
    console.log(`Matched nearest snapshot within tolerance: ${matchedSnapshot}`);
    console.log(`Wrote ${walletTrades.length} enriched trades to ${OUTPUT}`);
}

main();
