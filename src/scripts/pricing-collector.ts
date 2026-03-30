/**
 * Passive Pricing Data Collector for Multi-Crypto Polymarket Markets
 *
 * Captures bid/ask snapshots for both UP and DOWN outcomes at multiple
 * points during each 5-minute market window. Does NOT trade — just observes.
 *
 * Goal: Find "irregular patterns" in how the market prices outcomes.
 * - Are certain probability levels systematically mispriced?
 * - Does the market's implied probability match actual resolution rates?
 * - Are there spread/depth patterns that predict outcomes?
 *
 * Output:
 *   - pricing-data.raw.jsonl       = broad raw market telemetry with quality flags
 *   - pricing-data.jsonl           = strategy-usable T-120 subset
 *   - pricing-data.rejected.jsonl  = malformed records only
 *
 * Usage: npx tsx src/scripts/pricing-collector.ts --duration 480
 *        (runs for 8 hours = up to ~512 raw records with the current 64/hour ceiling)
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { ChainlinkFeed } from './crypto-5min/chainlink-feed.js';
import {
    bucketFirstOneSidedTime,
    bucketFirstTradableTime,
    buildLiquidityProfile,
    getFavoriteSide,
    getUnderdogSide,
    getWindowState,
    isEmptyBookSnapshot,
    type LiquidityWindowState,
} from './pricing-data-utils.js';

const GAMMA = 'https://gamma-api.polymarket.com';

// On-chain CTF contract — the ONLY source of truth for resolution
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const ctAbi = parseAbi([
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);
const polygonClient = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'pricing-data.jsonl';
const RAW_OUTPUT_FILE = 'pricing-data.raw.jsonl';
const REJECTED_OUTPUT_FILE = 'pricing-data.rejected.jsonl';
const MIN_ACCEPTABLE_SNAPSHOTS = 8;
const TOP_LEVEL_COUNT = 3;
const EXECUTION_NOTIONALS = [10, 25, 50, 100] as const;

// All crypto/timeframe combos to monitor
const MARKET_CONFIGS = [
    { crypto: 'btc', clSymbol: 'btc/usd', interval: 5 },
    { crypto: 'eth', clSymbol: 'eth/usd', interval: 5 },
    { crypto: 'sol', clSymbol: 'sol/usd', interval: 5 },
    { crypto: 'xrp', clSymbol: 'xrp/usd', interval: 5 },
    { crypto: 'btc', clSymbol: 'btc/usd', interval: 15 },
    { crypto: 'eth', clSymbol: 'eth/usd', interval: 15 },
    { crypto: 'sol', clSymbol: 'sol/usd', interval: 15 },
    { crypto: 'xrp', clSymbol: 'xrp/usd', interval: 15 },
] as const;

const log = (...args: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}]`, ...args);
};

// --- Types ---

interface BookSnapshot {
    timestamp: number;
    targetTimestamp: number;
    targetSecondsBeforeEnd: number;
    secondsBeforeEnd: number;
    upBid: number;
    upAsk: number;
    upSpread: number;
    upBidDepth: number;
    upAskDepth: number;
    downBid: number;
    downAsk: number;
    downSpread: number;
    downBidDepth: number;
    downAskDepth: number;
    upMid: number;
    downMid: number;
    impliedUpProb: number;     // midpoint-based implied probability
    bidSumCheck: number;       // upBid + downBid (should be < 1.0)
    askSumCheck: number;       // upAsk + downAsk (should be > 1.0)
    clPrice: number;           // Chainlink BTC price at this snapshot
    clMoveFromOpen: number;    // CL price change from market open ($)
    hourUTC: number;           // hour of day (0-23) for time-of-day analysis
    bookShape: SnapshotBookShape;
    executionAtSize: SnapshotExecutionProfile;
    collectionQuality: SnapshotCollectionQuality;
    underlyingPath?: SnapshotUnderlyingPathMetrics;
}

interface SimulatedTrade {
    snapshotSecBefore: number;   // which snapshot this simulates entry at
    side: 'UP' | 'DOWN';        // which underdog side we'd buy
    entryAsk: number;           // price we'd pay (ask)
    entryCostCents: number;     // cost per share in cents (ask * 100)
    takerFeeCents: number;      // 0.1% taker fee on entry
    gasCostCents: number;       // ~100 cents ($1) fixed gas
    spreadCostCents: number;    // (ask - bid) * 100 / 2 = half-spread
    totalCostCents: number;     // entryCost + takerFee + gas + spreadCost
    won: boolean;               // did this side win?
    payoutCents: number;        // 100 if won, 0 if lost
    netPnlCents: number;        // payout - totalCost
    favoriteImpliedProb: number; // what the market thought the favorite's odds were
}

interface MarketRecord {
    slug: string;
    marketEnd: number;
    snapshots: BookSnapshot[];
    resolution: 'UP' | 'DOWN' | 'UNKNOWN';
    chainlinkOpen: number;
    chainlinkClose: number;
    chainlinkMoveDollars: number;
    openUpBid: number;         // first snapshot UP bid
    openDownBid: number;       // first snapshot DOWN bid
    finalUpBid: number;        // last snapshot UP bid
    finalDownBid: number;      // last snapshot DOWN bid
    simulatedTrades: SimulatedTrade[];  // what-if analysis at each snapshot
    volume: number;            // market trading volume (from Gamma API)
    prevResolution: string;    // previous market's resolution (streak analysis)
    hourUTC: number;           // hour of day when market ended
    collectedAt: string;
    liquidityProfile: ReturnType<typeof buildLiquidityProfile>;
    regimeLabels: RegimeLabels;
    quoteStability: QuoteStabilityProfile;
    underlyingPathProfile: UnderlyingPathProfile;
    collectionProfile: CollectionProfile;
    missedSnapshots: MissedSnapshot[];
    qualityWarnings?: string[];
    strategyWarnings?: string[];
    qualityIssues?: string[];
}

interface BookLevel {
    price: number;
    size: number;
    notional: number;
}

interface DepthBands {
    within1c: number;
    within2c: number;
    within5c: number;
}

interface SideBookShape {
    topBids: BookLevel[];
    topAsks: BookLevel[];
    bidDepthBands: DepthBands;
    askDepthBands: DepthBands;
}

interface SnapshotBookShape {
    up: SideBookShape;
    down: SideBookShape;
    underdogSide: 'UP' | 'DOWN';
    favoriteSide: 'UP' | 'DOWN';
    underdogBestAskDepth: number;
    favoriteBestBidDepth: number;
}

interface ExecutionEstimate {
    requestedNotional: number;
    filledNotional: number;
    fillRatio: number;
    filledShares: number;
    averagePrice: number | null;
    worstPrice: number | null;
    topPrice: number | null;
    slippageFromTopCents: number | null;
}

interface SnapshotExecutionSideProfile {
    buy: ExecutionEstimate;
    sell: ExecutionEstimate;
    effectiveSpreadCents: number | null;
}

interface SnapshotExecutionProfile {
    underdog: Record<string, SnapshotExecutionSideProfile>;
    favorite: Record<string, SnapshotExecutionSideProfile>;
}

interface SnapshotCollectionQuality {
    fetchStartedAt: number;
    fetchCompletedAt: number;
    totalFetchLatencyMs: number;
    captureDelayMs: number;
    upBookFetchLatencyMs: number;
    downBookFetchLatencyMs: number;
    upBookTimestamp: number | null;
    downBookTimestamp: number | null;
    upQuoteAgeMs: number | null;
    downQuoteAgeMs: number | null;
}

interface SnapshotUnderlyingPathMetrics {
    runningHigh: number;
    runningLow: number;
    runningHighMoveFromOpen: number;
    runningLowMoveFromOpen: number;
    moveLast30s: number | null;
    moveLast60s: number | null;
    moveLast120s: number | null;
    realizedVolSoFarDollars: number;
    realizedVolSoFarBps: number;
}

interface RegimeLabels {
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

interface QuoteStabilityProfile {
    quoteChangeCount: number;
    spreadChangeCount: number;
    underdogSideFlipCount: number;
    underdogAskChangeCount: number;
    favoriteBidChangeCount: number;
    largestUnderdogAskJumpCents: number;
    largestFavoriteBidJumpCents: number;
    largestFavoriteImpliedJumpPct: number;
}

interface UnderlyingPathProfile {
    snapshotHigh: number;
    snapshotLow: number;
    snapshotRangeDollars: number;
    snapshotRangeBps: number;
    realizedVolDollars: number;
    realizedVolBps: number;
    trendAtT120Dollars: number | null;
    finalTrendDollars: number;
    moveLast30sAtClose: number | null;
    moveLast60sAtClose: number | null;
    moveLast120sAtClose: number | null;
    reversedAfterT120: boolean | null;
}

interface CollectionProfile {
    scheduledSnapshots: number;
    capturedSnapshots: number;
    missedSnapshots: number;
    captureRate: number;
    averageCaptureDelayMs: number | null;
    maxCaptureDelayMs: number | null;
    averageFetchLatencyMs: number | null;
    maxFetchLatencyMs: number | null;
}

interface MissedSnapshot {
    targetSecondsBeforeEnd: number;
    targetTimestamp: number;
    reason: string;
    lateByMs: number;
    recordedAt: number;
}

// --- Helpers ---

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-collector)' },
        });
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

interface MarketWithConfig {
    market: any;
    crypto: string;
    clSymbol: string;
    interval: number;
}

async function findAllCurrentMarkets(): Promise<MarketWithConfig[]> {
    const now = Math.floor(Date.now() / 1000);
    const found: MarketWithConfig[] = [];
    const seenSlugs = new Set<string>();

    const promises = MARKET_CONFIGS.map(async (cfg) => {
        const step = cfg.interval * 60; // 300 for 5m, 900 for 15m
        const rounded = Math.floor(now / step) * step;
        const suffix = cfg.interval === 5 ? '5m' : '15m';

        for (const ts of [rounded, rounded + step]) {
            const slug = `${cfg.crypto}-updown-${suffix}-${ts}`;
            if (seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (data && data.length > 0) {
                const m = data[0];
                const endDate = new Date(m.endDate).getTime();
                if (endDate > Date.now()) {
                    found.push({ market: m, crypto: cfg.crypto, clSymbol: cfg.clSymbol, interval: cfg.interval });
                    return; // found one for this config, move on
                }
            }
        }
    });

    await Promise.all(promises);
    return found;
}

function getTokenIds(market: any): { upToken: string; downToken: string } | null {
    try {
        const tokens = JSON.parse(market.clobTokenIds || '[]');
        const outcomes = JSON.parse(market.outcomes || '[]');
        const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
        const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
        if (upIdx === -1 || downIdx === -1 || !tokens[upIdx] || !tokens[downIdx]) return null;
        return { upToken: tokens[upIdx], downToken: tokens[downIdx] };
    } catch {
        return null;
    }
}

interface FullBookInfo {
    bestBid: number;
    bestAsk: number;
    spread: number;
    bidDepth: number;
    askDepth: number;
    bids: BookLevel[];
    asks: BookLevel[];
    fetchLatencyMs: number;
    bookTimestamp: number | null;
    quoteAgeMs: number | null;
}

async function getFullBookInfo(tokenId: string): Promise<FullBookInfo> {
    const fetchStartedAt = Date.now();
    try {
        const resp = await fetch(`${CLOB}/book?token_id=${tokenId}`, {
            headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-collector)' },
        });
        const fetchCompletedAt = Date.now();
        if (!resp.ok) {
            return {
                bestBid: 0, bestAsk: 1, spread: 1, bidDepth: 0, askDepth: 0,
                bids: [], asks: [],
                fetchLatencyMs: fetchCompletedAt - fetchStartedAt,
                bookTimestamp: null,
                quoteAgeMs: null,
            };
        }

        const raw = await resp.json();
        const bookTimestamp = Number.isFinite(Number(raw.timestamp)) ? Number(raw.timestamp) : null;

        const bids = (raw.bids || [])
            .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size), notional: parseFloat(b.price) * parseFloat(b.size) }))
            .filter((b: BookLevel) => Number.isFinite(b.price) && Number.isFinite(b.size) && b.size > 0)
            .sort((a: BookLevel, b: BookLevel) => b.price - a.price);
        const asks = (raw.asks || [])
            .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size), notional: parseFloat(a.price) * parseFloat(a.size) }))
            .filter((a: BookLevel) => Number.isFinite(a.price) && Number.isFinite(a.size) && a.size > 0)
            .sort((a: BookLevel, b: BookLevel) => a.price - b.price);

        const bestBid = bids[0]?.price ?? 0;
        const bestAsk = asks[0]?.price ?? 1;
        const bidDepth = bids.reduce((sum: number, b: BookLevel) => sum + b.size, 0);
        const askDepth = asks.reduce((sum: number, a: BookLevel) => sum + a.size, 0);

        return {
            bestBid,
            bestAsk,
            spread: bestAsk - bestBid,
            bidDepth,
            askDepth,
            bids,
            asks,
            fetchLatencyMs: fetchCompletedAt - fetchStartedAt,
            bookTimestamp,
            quoteAgeMs: bookTimestamp !== null ? Math.max(0, fetchCompletedAt - bookTimestamp) : null,
        };
    } catch {
        const fetchCompletedAt = Date.now();
        return {
            bestBid: 0, bestAsk: 1, spread: 1, bidDepth: 0, askDepth: 0,
            bids: [], asks: [],
            fetchLatencyMs: fetchCompletedAt - fetchStartedAt,
            bookTimestamp: null,
            quoteAgeMs: null,
        };
    }
}

function takeTopLevels(levels: BookLevel[], count = TOP_LEVEL_COUNT): BookLevel[] {
    return levels.slice(0, count).map((level) => ({
        price: level.price,
        size: Number(level.size.toFixed(4)),
        notional: Number(level.notional.toFixed(4)),
    }));
}

function buildDepthBands(levels: BookLevel[], bestPrice: number, side: 'bid' | 'ask'): DepthBands {
    const bandDepth = (cents: number) => {
        const maxDelta = cents / 100;
        return Number(levels
            .filter((level) => side === 'bid' ? bestPrice - level.price <= maxDelta : level.price - bestPrice <= maxDelta)
            .reduce((sum, level) => sum + level.size, 0)
            .toFixed(4));
    };

    return {
        within1c: bandDepth(1),
        within2c: bandDepth(2),
        within5c: bandDepth(5),
    };
}

function buildSideBookShape(book: FullBookInfo): SideBookShape {
    return {
        topBids: takeTopLevels(book.bids),
        topAsks: takeTopLevels(book.asks),
        bidDepthBands: buildDepthBands(book.bids, book.bestBid, 'bid'),
        askDepthBands: buildDepthBands(book.asks, book.bestAsk, 'ask'),
    };
}

function estimateExecution(levels: BookLevel[], requestedNotional: number, side: 'buy' | 'sell'): ExecutionEstimate {
    if (requestedNotional <= 0 || levels.length === 0) {
        return {
            requestedNotional,
            filledNotional: 0,
            fillRatio: 0,
            filledShares: 0,
            averagePrice: null,
            worstPrice: null,
            topPrice: levels[0]?.price ?? null,
            slippageFromTopCents: null,
        };
    }

    let remainingNotional = requestedNotional;
    let filledNotional = 0;
    let filledShares = 0;
    let worstPrice: number | null = null;

    for (const level of levels) {
        if (remainingNotional <= 0) break;
        if (level.price <= 0) continue;

        const levelNotional = level.price * level.size;
        const usedNotional = Math.min(levelNotional, remainingNotional);
        const usedShares = usedNotional / level.price;

        filledNotional += usedNotional;
        filledShares += usedShares;
        remainingNotional -= usedNotional;
        worstPrice = level.price;
    }

    const averagePrice = filledShares > 0 ? filledNotional / filledShares : null;
    const topPrice = levels[0]?.price ?? null;
    const slippageFromTopCents = averagePrice !== null && topPrice !== null
        ? Number(((side === 'buy' ? averagePrice - topPrice : topPrice - averagePrice) * 100).toFixed(4))
        : null;

    return {
        requestedNotional,
        filledNotional: Number(filledNotional.toFixed(4)),
        fillRatio: requestedNotional > 0 ? Number((filledNotional / requestedNotional).toFixed(4)) : 0,
        filledShares: Number(filledShares.toFixed(4)),
        averagePrice: averagePrice !== null ? Number(averagePrice.toFixed(6)) : null,
        worstPrice,
        topPrice,
        slippageFromTopCents,
    };
}

function buildExecutionSideProfile(bids: BookLevel[], asks: BookLevel[]): Record<string, SnapshotExecutionSideProfile> {
    return Object.fromEntries(
        EXECUTION_NOTIONALS.map((notional) => {
            const buy = estimateExecution(asks, notional, 'buy');
            const sell = estimateExecution(bids, notional, 'sell');
            const effectiveSpreadCents = buy.averagePrice !== null && sell.averagePrice !== null
                ? Number(((buy.averagePrice - sell.averagePrice) * 100).toFixed(4))
                : null;
            return [String(notional), { buy, sell, effectiveSpreadCents }];
        }),
    );
}

function buildSnapshotBookShape(upBook: FullBookInfo, downBook: FullBookInfo, underdogSide: 'UP' | 'DOWN', favoriteSide: 'UP' | 'DOWN'): SnapshotBookShape {
    return {
        up: buildSideBookShape(upBook),
        down: buildSideBookShape(downBook),
        underdogSide,
        favoriteSide,
        underdogBestAskDepth: Number((underdogSide === 'UP' ? upBook.asks[0]?.size ?? 0 : downBook.asks[0]?.size ?? 0).toFixed(4)),
        favoriteBestBidDepth: Number((favoriteSide === 'UP' ? upBook.bids[0]?.size ?? 0 : downBook.bids[0]?.size ?? 0).toFixed(4)),
    };
}

function buildSnapshotExecutionProfile(upBook: FullBookInfo, downBook: FullBookInfo, underdogSide: 'UP' | 'DOWN', favoriteSide: 'UP' | 'DOWN'): SnapshotExecutionProfile {
    const underdogBids = underdogSide === 'UP' ? upBook.bids : downBook.bids;
    const underdogAsks = underdogSide === 'UP' ? upBook.asks : downBook.asks;
    const favoriteBids = favoriteSide === 'UP' ? upBook.bids : downBook.bids;
    const favoriteAsks = favoriteSide === 'UP' ? upBook.asks : downBook.asks;

    return {
        underdog: buildExecutionSideProfile(underdogBids, underdogAsks),
        favorite: buildExecutionSideProfile(favoriteBids, favoriteAsks),
    };
}

async function takeSnapshot(
    upToken: string,
    downToken: string,
    endTime: number,
    clPrice: number,
    clOpen: number,
    targetSecondsBeforeEnd: number,
    targetTimestamp: number,
): Promise<BookSnapshot> {
    const fetchStartedAt = Date.now();
    const [upBook, downBook] = await Promise.all([
        getFullBookInfo(upToken),
        getFullBookInfo(downToken),
    ]);
    const fetchCompletedAt = Date.now();

    const upMid = (upBook.bestBid + upBook.bestAsk) / 2;
    const downMid = (downBook.bestBid + downBook.bestAsk) / 2;
    const impliedUpProb = upMid / (upMid + downMid) || 0.5;
    const underdogSide = getUnderdogSide({ upMid, downMid });
    const favoriteSide = getFavoriteSide({ upMid, downMid });

    return {
        timestamp: fetchCompletedAt,
        targetTimestamp,
        targetSecondsBeforeEnd,
        secondsBeforeEnd: Math.round((endTime - fetchCompletedAt) / 1000),
        upBid: upBook.bestBid,
        upAsk: upBook.bestAsk,
        upSpread: upBook.spread,
        upBidDepth: Math.round(upBook.bidDepth),
        upAskDepth: Math.round(upBook.askDepth),
        downBid: downBook.bestBid,
        downAsk: downBook.bestAsk,
        downSpread: downBook.spread,
        downBidDepth: Math.round(downBook.bidDepth),
        downAskDepth: Math.round(downBook.askDepth),
        upMid,
        downMid,
        impliedUpProb,
        bidSumCheck: upBook.bestBid + downBook.bestBid,
        askSumCheck: upBook.bestAsk + downBook.bestAsk,
        clPrice,
        clMoveFromOpen: clPrice - clOpen,
        hourUTC: new Date(fetchCompletedAt).getUTCHours(),
        bookShape: buildSnapshotBookShape(upBook, downBook, underdogSide, favoriteSide),
        executionAtSize: buildSnapshotExecutionProfile(upBook, downBook, underdogSide, favoriteSide),
        collectionQuality: {
            fetchStartedAt,
            fetchCompletedAt,
            totalFetchLatencyMs: fetchCompletedAt - fetchStartedAt,
            captureDelayMs: fetchCompletedAt - targetTimestamp,
            upBookFetchLatencyMs: upBook.fetchLatencyMs,
            downBookFetchLatencyMs: downBook.fetchLatencyMs,
            upBookTimestamp: upBook.bookTimestamp,
            downBookTimestamp: downBook.bookTimestamp,
            upQuoteAgeMs: upBook.quoteAgeMs,
            downQuoteAgeMs: downBook.quoteAgeMs,
        },
    };
}

/**
 * Resolve market outcome using on-chain payoutNumerators (the ONLY truth).
 * Flow: Gamma API → conditionId → on-chain payoutNumerators.
 * Retries because on-chain resolution can lag market end by 30-120s.
 */
async function resolveOutcome(slug: string, retries = 30): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    // Step 1: Get conditionId and outcome labels from Gamma API
    let conditionId: `0x${string}` | null = null;
    let outcomes: string[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (data?.[0]) {
                conditionId = data[0].conditionId as `0x${string}`;
                outcomes = JSON.parse(data[0].outcomes || '[]');
                break;
            }
        } catch { /* retry */ }
        await sleep(2000);
    }

    if (!conditionId || outcomes.length === 0) {
        log(`  WARN: Could not fetch conditionId for ${slug} — resolution UNKNOWN`);
        return 'UNKNOWN';
    }

    // Step 2: Poll on-chain payoutNumerators until resolved
    for (let i = 0; i < retries; i++) {
        try {
            const den = await polygonClient.readContract({
                address: CT_ADDRESS, abi: ctAbi,
                functionName: 'payoutDenominator', args: [conditionId],
            });

            if (Number(den) > 0) {
                // Market is resolved on-chain — read the winner
                for (let oi = 0; oi < outcomes.length; oi++) {
                    const pn = await polygonClient.readContract({
                        address: CT_ADDRESS, abi: ctAbi,
                        functionName: 'payoutNumerators', args: [conditionId, BigInt(oi)],
                    });
                    if (pn > 0n) {
                        const winner = outcomes[oi].toUpperCase() as 'UP' | 'DOWN';
                        if (i > 0) log(`  On-chain resolved after ${i + 1} polls: ${winner}`);
                        return winner;
                    }
                }
                // Denominator > 0 but no numerator > 0 — shouldn't happen for binary
                log(`  WARN: payoutDenominator > 0 but no winning outcome for ${slug}`);
                return 'UNKNOWN';
            }
        } catch (err: any) {
            // payoutDenominator can revert if condition doesn't exist yet
            if (i === 0) log(`  On-chain not yet resolved, polling... (${err.message?.slice(0, 60) || 'rpc error'})`);
        }
        if (i < retries - 1) await sleep(4000); // 4s between polls, up to ~2 min total
    }

    log(`  WARN: On-chain resolution not available after ${retries} polls for ${slug}`);
    return 'UNKNOWN';
}

// --- Simulated Trade Analysis ---

const TAKER_FEE_RATE = 0.001;  // 0.1%
const GAS_COST_CENTS = 100;     // ~$1 per tx on Polygon

function simulateTrades(snapshots: BookSnapshot[], resolution: 'UP' | 'DOWN' | 'UNKNOWN'): SimulatedTrade[] {
    if (resolution === 'UNKNOWN') return [];

    return snapshots.flatMap((snap) => {
        if (isEmptyBookSnapshot(snap)) return [];

        // Identify the underdog (lower-priced side)
        const upIsUnderdog = snap.upMid < snap.downMid;
        const side: 'UP' | 'DOWN' = upIsUnderdog ? 'UP' : 'DOWN';
        const entryAsk = upIsUnderdog ? snap.upAsk : snap.downAsk;
        const entryBid = upIsUnderdog ? snap.upBid : snap.downBid;
        const favoriteImpliedProb = upIsUnderdog ? snap.downMid : snap.upMid;

        if (entryAsk <= 0 || entryAsk >= 1) return [];

        const entryCostCents = entryAsk * 100;
        const takerFeeCents = entryCostCents * TAKER_FEE_RATE;
        const spreadCostCents = ((entryAsk - entryBid) * 100) / 2;
        const totalCostCents = entryCostCents + takerFeeCents + GAS_COST_CENTS + spreadCostCents;

        const won = side === resolution;
        const payoutCents = won ? 100 : 0;
        const netPnlCents = payoutCents - totalCostCents;

        return [{
            snapshotSecBefore: snap.secondsBeforeEnd,
            side,
            entryAsk,
            entryCostCents,
            takerFeeCents,
            gasCostCents: GAS_COST_CENTS,
            spreadCostCents,
            totalCostCents,
            won,
            payoutCents,
            netPnlCents,
            favoriteImpliedProb,
        }];
    });
}

function assessRecordQuality(record: MarketRecord): {
    rejected: boolean;
    strategyUsable: boolean;
    issues: string[];
    warnings: string[];
    strategyWarnings: string[];
} {
    const issues: string[] = [];
    const warnings: string[] = [];
    const strategyWarnings: string[] = [];
    const { emptyBookSnapshots, tradableSnapshots, earliestTradableSecondsBeforeEnd, hasTradableT120 } = record.liquidityProfile;

    if (record.snapshots.length < MIN_ACCEPTABLE_SNAPSHOTS) {
        warnings.push(`only ${record.snapshots.length} snapshots captured (strong coverage target ${MIN_ACCEPTABLE_SNAPSHOTS})`);
    }

    const hasNonFiniteSnapshotValues = record.snapshots.some((snap) =>
        ![
            snap.secondsBeforeEnd,
            snap.upBid,
            snap.upAsk,
            snap.upSpread,
            snap.upBidDepth,
            snap.upAskDepth,
            snap.downBid,
            snap.downAsk,
            snap.downSpread,
            snap.downBidDepth,
            snap.downAskDepth,
            snap.upMid,
            snap.downMid,
            snap.impliedUpProb,
            snap.bidSumCheck,
            snap.askSumCheck,
            snap.clPrice,
            snap.clMoveFromOpen,
            snap.hourUTC,
        ].every(Number.isFinite),
    );
    if (hasNonFiniteSnapshotValues) {
        issues.push('non-finite snapshot values detected');
    }

    if (emptyBookSnapshots === record.snapshots.length) {
        warnings.push(`all ${record.snapshots.length} snapshots had empty books`);
    } else if (emptyBookSnapshots > 0) {
        warnings.push(`${emptyBookSnapshots}/${record.snapshots.length} snapshots had empty books`);
    }

    if (tradableSnapshots === 0 || record.simulatedTrades.length === 0) {
        warnings.push('no tradable snapshots were available for simulation');
    }

    if (!hasTradableT120) {
        strategyWarnings.push('no tradable T-120 snapshot');
    }
    if (tradableSnapshots < 3) {
        strategyWarnings.push(`only ${tradableSnapshots} tradable snapshot${tradableSnapshots === 1 ? '' : 's'}`);
    }
    if (earliestTradableSecondsBeforeEnd !== null && earliestTradableSecondsBeforeEnd < 110) {
        strategyWarnings.push(`first tradable quote appeared at T-${earliestTradableSecondsBeforeEnd}s`);
    }

    return {
        rejected: issues.length > 0,
        strategyUsable: issues.length === 0 && hasTradableT120,
        issues,
        warnings,
        strategyWarnings,
    };
}

function annotateSnapshotsWithUnderlyingMetrics(snapshots: BookSnapshot[], chainlinkOpen: number): void {
    let runningHigh = Number.NEGATIVE_INFINITY;
    let runningLow = Number.POSITIVE_INFINITY;
    let realizedVolSoFarDollars = 0;
    let realizedVolSoFarBps = 0;

    const findPriorMove = (idx: number, targetSeconds: number): number | null => {
        const current = snapshots[idx];
        let bestMatch: BookSnapshot | null = null;
        let bestDistance = Number.POSITIVE_INFINITY;

        for (let i = idx - 1; i >= 0; i--) {
            const candidate = snapshots[i];
            const delta = candidate.secondsBeforeEnd - current.secondsBeforeEnd;
            if (delta < 0) continue;

            const distance = Math.abs(delta - targetSeconds);
            if (distance < bestDistance) {
                bestMatch = candidate;
                bestDistance = distance;
            }
        }

        return bestMatch ? Number((current.clPrice - bestMatch.clPrice).toFixed(6)) : null;
    };

    for (let i = 0; i < snapshots.length; i++) {
        const snap = snapshots[i];
        runningHigh = Math.max(runningHigh, snap.clPrice);
        runningLow = Math.min(runningLow, snap.clPrice);

        if (i > 0) {
            const prev = snapshots[i - 1];
            const delta = snap.clPrice - prev.clPrice;
            realizedVolSoFarDollars += delta * delta;
            if (prev.clPrice > 0) {
                const deltaBps = (delta / prev.clPrice) * 10000;
                realizedVolSoFarBps += deltaBps * deltaBps;
            }
        }

        snap.underlyingPath = {
            runningHigh,
            runningLow,
            runningHighMoveFromOpen: Number((runningHigh - chainlinkOpen).toFixed(6)),
            runningLowMoveFromOpen: Number((runningLow - chainlinkOpen).toFixed(6)),
            moveLast30s: findPriorMove(i, 30),
            moveLast60s: findPriorMove(i, 60),
            moveLast120s: findPriorMove(i, 120),
            realizedVolSoFarDollars: Number(Math.sqrt(realizedVolSoFarDollars).toFixed(6)),
            realizedVolSoFarBps: Number(Math.sqrt(realizedVolSoFarBps).toFixed(4)),
        };
    }
}

function buildQuoteStabilityProfile(snapshots: BookSnapshot[]): QuoteStabilityProfile {
    let quoteChangeCount = 0;
    let spreadChangeCount = 0;
    let underdogSideFlipCount = 0;
    let underdogAskChangeCount = 0;
    let favoriteBidChangeCount = 0;
    let largestUnderdogAskJumpCents = 0;
    let largestFavoriteBidJumpCents = 0;
    let largestFavoriteImpliedJumpPct = 0;

    for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1];
        const curr = snapshots[i];

        if (
            prev.upBid !== curr.upBid
            || prev.upAsk !== curr.upAsk
            || prev.downBid !== curr.downBid
            || prev.downAsk !== curr.downAsk
        ) {
            quoteChangeCount++;
        }

        if (prev.upSpread !== curr.upSpread || prev.downSpread !== curr.downSpread) {
            spreadChangeCount++;
        }

        const prevUnderdog = getUnderdogSide(prev);
        const currUnderdog = getUnderdogSide(curr);
        if (prevUnderdog !== currUnderdog) {
            underdogSideFlipCount++;
        }

        const prevUnderdogAsk = prevUnderdog === 'UP' ? prev.upAsk : prev.downAsk;
        const currUnderdogAsk = currUnderdog === 'UP' ? curr.upAsk : curr.downAsk;
        if (prevUnderdogAsk !== currUnderdogAsk) {
            underdogAskChangeCount++;
            largestUnderdogAskJumpCents = Math.max(largestUnderdogAskJumpCents, Math.abs(currUnderdogAsk - prevUnderdogAsk) * 100);
        }

        const prevFavorite = getFavoriteSide(prev);
        const currFavorite = getFavoriteSide(curr);
        const prevFavoriteBid = prevFavorite === 'UP' ? prev.upBid : prev.downBid;
        const currFavoriteBid = currFavorite === 'UP' ? curr.upBid : curr.downBid;
        if (prevFavoriteBid !== currFavoriteBid) {
            favoriteBidChangeCount++;
            largestFavoriteBidJumpCents = Math.max(largestFavoriteBidJumpCents, Math.abs(currFavoriteBid - prevFavoriteBid) * 100);
        }

        const prevFavoriteImplied = prevUnderdog === 'UP' ? prev.downMid : prev.upMid;
        const currFavoriteImplied = currUnderdog === 'UP' ? curr.downMid : curr.upMid;
        largestFavoriteImpliedJumpPct = Math.max(largestFavoriteImpliedJumpPct, Math.abs(currFavoriteImplied - prevFavoriteImplied) * 100);
    }

    return {
        quoteChangeCount,
        spreadChangeCount,
        underdogSideFlipCount,
        underdogAskChangeCount,
        favoriteBidChangeCount,
        largestUnderdogAskJumpCents: Number(largestUnderdogAskJumpCents.toFixed(4)),
        largestFavoriteBidJumpCents: Number(largestFavoriteBidJumpCents.toFixed(4)),
        largestFavoriteImpliedJumpPct: Number(largestFavoriteImpliedJumpPct.toFixed(4)),
    };
}

function buildUnderlyingPathProfile(snapshots: BookSnapshot[], chainlinkOpen: number): UnderlyingPathProfile {
    const prices = snapshots.map((snap) => snap.clPrice);
    const snapshotHigh = prices.length > 0 ? Math.max(...prices) : chainlinkOpen;
    const snapshotLow = prices.length > 0 ? Math.min(...prices) : chainlinkOpen;
    const latest = snapshots[snapshots.length - 1];
    const t120 = snapshots.find((snap) => snap.secondsBeforeEnd >= 110 && snap.secondsBeforeEnd <= 130);

    let realizedVolSquaresDollars = 0;
    let realizedVolSquaresBps = 0;
    for (let i = 1; i < snapshots.length; i++) {
        const prev = snapshots[i - 1];
        const curr = snapshots[i];
        const delta = curr.clPrice - prev.clPrice;
        realizedVolSquaresDollars += delta * delta;
        if (prev.clPrice > 0) {
            const deltaBps = (delta / prev.clPrice) * 10000;
            realizedVolSquaresBps += deltaBps * deltaBps;
        }
    }

    const finalTrendDollars = latest ? latest.clPrice - chainlinkOpen : 0;
    const trendAtT120Dollars = t120 ? t120.clPrice - chainlinkOpen : null;
    const reversedAfterT120 = trendAtT120Dollars === null
        ? null
        : (trendAtT120Dollars > 0 && finalTrendDollars < 0) || (trendAtT120Dollars < 0 && finalTrendDollars > 0);

    return {
        snapshotHigh: Number(snapshotHigh.toFixed(6)),
        snapshotLow: Number(snapshotLow.toFixed(6)),
        snapshotRangeDollars: Number((snapshotHigh - snapshotLow).toFixed(6)),
        snapshotRangeBps: chainlinkOpen > 0 ? Number((((snapshotHigh - snapshotLow) / chainlinkOpen) * 10000).toFixed(4)) : 0,
        realizedVolDollars: Number(Math.sqrt(realizedVolSquaresDollars).toFixed(6)),
        realizedVolBps: Number(Math.sqrt(realizedVolSquaresBps).toFixed(4)),
        trendAtT120Dollars: trendAtT120Dollars !== null ? Number(trendAtT120Dollars.toFixed(6)) : null,
        finalTrendDollars: Number(finalTrendDollars.toFixed(6)),
        moveLast30sAtClose: latest?.underlyingPath?.moveLast30s ?? null,
        moveLast60sAtClose: latest?.underlyingPath?.moveLast60s ?? null,
        moveLast120sAtClose: latest?.underlyingPath?.moveLast120s ?? null,
        reversedAfterT120,
    };
}

function buildCollectionProfile(snapshots: BookSnapshot[], missedSnapshots: MissedSnapshot[], scheduledSnapshots: number): CollectionProfile {
    const captureDelays = snapshots.map((snap) => snap.collectionQuality.captureDelayMs);
    const fetchLatencies = snapshots.map((snap) => snap.collectionQuality.totalFetchLatencyMs);

    const avg = (values: number[]) => values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
    const max = (values: number[]) => values.length > 0 ? Math.max(...values) : null;

    return {
        scheduledSnapshots,
        capturedSnapshots: snapshots.length,
        missedSnapshots: missedSnapshots.length,
        captureRate: scheduledSnapshots > 0 ? Number((snapshots.length / scheduledSnapshots).toFixed(4)) : 0,
        averageCaptureDelayMs: avg(captureDelays) !== null ? Number(avg(captureDelays)!.toFixed(2)) : null,
        maxCaptureDelayMs: max(captureDelays),
        averageFetchLatencyMs: avg(fetchLatencies) !== null ? Number(avg(fetchLatencies)!.toFixed(2)) : null,
        maxFetchLatencyMs: max(fetchLatencies),
    };
}

function buildRegimeLabels(snapshots: BookSnapshot[], liquidityProfile: ReturnType<typeof buildLiquidityProfile>): RegimeLabels {
    return {
        t120State: getWindowState(snapshots, 110, 130),
        t90State: getWindowState(snapshots, 80, 100),
        t60State: getWindowState(snapshots, 50, 70),
        firstTradableBucket: bucketFirstTradableTime(liquidityProfile.earliestTradableSecondsBeforeEnd),
        firstOneSidedBucket: bucketFirstOneSidedTime(liquidityProfile.earliestOneSidedSecondsBeforeEnd),
        collapseBeforeT120: liquidityProfile.earliestOneSidedSecondsBeforeEnd !== null && liquidityProfile.earliestOneSidedSecondsBeforeEnd >= 110,
        collapseBeforeT60: liquidityProfile.earliestOneSidedSecondsBeforeEnd !== null && liquidityProfile.earliestOneSidedSecondsBeforeEnd >= 50,
        tradableByT120: liquidityProfile.hasTradableT120,
        tradableByT90: liquidityProfile.tradableSnapshotSeconds.some((sec) => sec >= 80 && sec <= 100),
        tradableByT60: liquidityProfile.hasTradableT60,
    };
}

// --- Main ---

async function collectOneMarket(chainlink: ChainlinkFeed, prevResolution: string, marketInfo?: MarketWithConfig): Promise<MarketRecord | null> {
    let market: any;
    let clSymbol = 'btc/usd';

    if (marketInfo) {
        market = marketInfo.market;
        clSymbol = marketInfo.clSymbol;
    } else {
        // Legacy: find BTC 5m market
        const all = await findAllCurrentMarkets();
        const btc5m = all.find(m => m.crypto === 'btc' && m.interval === 5);
        if (!btc5m) {
            log('No market found, waiting...');
            return null;
        }
        market = btc5m.market;
        clSymbol = btc5m.clSymbol;
    }

    const tokens = getTokenIds(market);
    if (!tokens) {
        log('Could not parse token IDs');
        return null;
    }

    const endTime = new Date(market.endDate).getTime();
    const slug = market.slug;
    const timeLeft = Math.round((endTime - Date.now()) / 1000);

    log(`\n=== ${slug} | ${timeLeft}s remaining ===`);

    const chainlinkOpen = chainlink.getPrice(clSymbol);
    const snapshots: BookSnapshot[] = [];
    const missedSnapshots: MissedSnapshot[] = [];

    // Take snapshots at key intervals before market end
    // Snapshot schedule: as early as possible, then every 30s, plus final at T-10s
    const snapshotTimesBeforeEnd = [240, 210, 180, 150, 120, 105, 90, 75, 60, 50, 45, 40, 35, 30, 25, 20, 15, 12, 10, 8, 5];

    for (const secBefore of snapshotTimesBeforeEnd) {
        const targetTime = endTime - secBefore * 1000;
        const waitMs = targetTime - Date.now();

        // Skip snapshots we're already well past (>5s late)
        if (waitMs < -5000) {
            missedSnapshots.push({
                targetSecondsBeforeEnd: secBefore,
                targetTimestamp: targetTime,
                reason: 'started_more_than_5s_late',
                lateByMs: Math.abs(waitMs),
                recordedAt: Date.now(),
            });
            continue;
        }

        if (waitMs > 0) {
            await sleep(waitMs);
        }

        // Stop if market is about to end
        if (Date.now() > endTime - 5000) {
            missedSnapshots.push({
                targetSecondsBeforeEnd: secBefore,
                targetTimestamp: targetTime,
                reason: 'market_about_to_end',
                lateByMs: Math.max(0, Date.now() - targetTime),
                recordedAt: Date.now(),
            });
            break;
        }

        try {
            const snap = await takeSnapshot(tokens.upToken, tokens.downToken, endTime, chainlink.getPrice(clSymbol), chainlinkOpen, secBefore, targetTime);
            snapshots.push(snap);

            if (isEmptyBookSnapshot(snap)) {
                log(`  T-${snap.secondsBeforeEnd}s: EMPTY BOOK on both sides`);
            } else {
                const upPct = (snap.upBid * 100).toFixed(0);
                const downPct = (snap.downBid * 100).toFixed(0);
                log(`  T-${snap.secondsBeforeEnd}s: UP=${upPct}¢ DOWN=${downPct}¢ | spread: ${(snap.upSpread * 100).toFixed(0)}¢/${(snap.downSpread * 100).toFixed(0)}¢ | implied UP: ${(snap.impliedUpProb * 100).toFixed(1)}%`);
            }
        } catch (err: any) {
            missedSnapshots.push({
                targetSecondsBeforeEnd: secBefore,
                targetTimestamp: targetTime,
                reason: `snapshot_error:${err.message}`,
                lateByMs: Math.max(0, Date.now() - targetTime),
                recordedAt: Date.now(),
            });
            log(`  Snapshot error at T-${secBefore}s: ${err.message}`);
        }
    }

    // If we captured nothing at all, there is no telemetry to save.
    if (snapshots.length === 0) {
        log('  No snapshots captured, skipping market');
        return null;
    }

    annotateSnapshotsWithUnderlyingMetrics(snapshots, chainlinkOpen);

    // Wait for market to end
    const msUntilEnd = endTime - Date.now();
    if (msUntilEnd > 0) {
        log(`  Waiting ${(msUntilEnd / 1000).toFixed(0)}s for market to end...`);
        await sleep(msUntilEnd + 3000); // +3s to ensure market is done
    } else {
        await sleep(3000);
    }

    // Capture Chainlink close price right after market ends
    const chainlinkClose = chainlink.getPrice(clSymbol);

    // Chainlink resolution (for reference/logging)
    const clResolution: 'UP' | 'DOWN' | 'UNKNOWN' =
        (chainlinkOpen > 0 && chainlinkClose > 0)
            ? (chainlinkClose >= chainlinkOpen ? 'UP' : 'DOWN')
            : 'UNKNOWN';

    // On-chain resolution via CTF payoutNumerators — the ONLY source of truth.
    // Wait 30s after market end for UMA oracle to post resolution on-chain,
    // then poll up to ~2 min. CL is kept for logging/comparison only.
    await sleep(30000);
    const onChainResolution = await resolveOutcome(slug);

    // On-chain is the only truth. CL is for logging/comparison only.
    const resolution = onChainResolution;

    if (onChainResolution !== 'UNKNOWN' && onChainResolution !== clResolution && clResolution !== 'UNKNOWN') {
        log(`  NOTE: OnChain=${onChainResolution} CL=${clResolution} — using on-chain (actual payouts)`);
    }

    log(`  Resolution: ${resolution} (on-chain) | CL: ${clResolution} | $${chainlinkOpen.toFixed(2)} → $${chainlinkClose.toFixed(2)} (${chainlinkClose >= chainlinkOpen ? '+' : ''}$${(chainlinkClose - chainlinkOpen).toFixed(2)})`);

    // Simulate underdog trades at each snapshot
    const simulatedTrades = simulateTrades(snapshots, resolution);
    if (simulatedTrades.length > 0) {
        const t120 = simulatedTrades.find(t => t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130);
        const t60 = simulatedTrades.find(t => t.snapshotSecBefore >= 55 && t.snapshotSecBefore <= 65);
        const t30 = simulatedTrades.find(t => t.snapshotSecBefore >= 25 && t.snapshotSecBefore <= 35);
        const fmt = (t: SimulatedTrade | undefined) => {
            if (!t) return 'N/A';
            return `buy ${t.side} @${(t.entryAsk * 100).toFixed(0)}¢ → ${t.won ? 'WIN' : 'LOSS'} ${t.netPnlCents >= 0 ? '+' : ''}${t.netPnlCents.toFixed(1)}¢ (fav=${(t.favoriteImpliedProb * 100).toFixed(0)}%)`;
        };
        log(`  Sim trades: T-120s: ${fmt(t120)} | T-60s: ${fmt(t60)} | T-30s: ${fmt(t30)}`);
    }

    const volume = parseFloat(market.volume || '0');
    const liquidityProfile = buildLiquidityProfile(snapshots);

    return {
        slug,
        marketEnd: endTime,
        snapshots,
        resolution,
        chainlinkOpen,
        chainlinkClose,
        chainlinkMoveDollars: chainlinkClose - chainlinkOpen,
        openUpBid: snapshots[0].upBid,
        openDownBid: snapshots[0].downBid,
        finalUpBid: snapshots[snapshots.length - 1].upBid,
        finalDownBid: snapshots[snapshots.length - 1].downBid,
        simulatedTrades,
        volume,
        prevResolution,
        hourUTC: new Date().getUTCHours(),
        collectedAt: new Date().toISOString(),
        liquidityProfile,
        regimeLabels: buildRegimeLabels(snapshots, liquidityProfile),
        quoteStability: buildQuoteStabilityProfile(snapshots),
        underlyingPathProfile: buildUnderlyingPathProfile(snapshots, chainlinkOpen),
        collectionProfile: buildCollectionProfile(snapshots, missedSnapshots, snapshotTimesBeforeEnd.length),
        missedSnapshots,
    };
}

// --- Running Stats ---

interface RunningStats {
    markets: number;
    simWins: number;
    simLosses: number;
    simPnlCents: number;
    // By entry time bucket
    byEntry: Record<string, { wins: number; losses: number; pnlCents: number }>;
    // By favorite confidence bucket
    byConfidence: Record<string, { wins: number; losses: number; pnlCents: number }>;
}

function updateStats(stats: RunningStats, trades: SimulatedTrade[]) {
    stats.markets++;

    for (const t of trades) {
        // Bucket by entry time
        const timeBucket = `T-${t.snapshotSecBefore}s`;
        if (!stats.byEntry[timeBucket]) stats.byEntry[timeBucket] = { wins: 0, losses: 0, pnlCents: 0 };
        stats.byEntry[timeBucket].pnlCents += t.netPnlCents;
        if (t.won) { stats.byEntry[timeBucket].wins++; } else { stats.byEntry[timeBucket].losses++; }

        // Bucket by favorite confidence (the mispricing zone analysis)
        const confPct = Math.round(t.favoriteImpliedProb * 100);
        const confBucket = confPct >= 80 ? '80-100%' : confPct >= 60 ? '60-80%' : confPct >= 50 ? '50-60%' : '<50%';
        if (!stats.byConfidence[confBucket]) stats.byConfidence[confBucket] = { wins: 0, losses: 0, pnlCents: 0 };
        stats.byConfidence[confBucket].pnlCents += t.netPnlCents;
        if (t.won) { stats.byConfidence[confBucket].wins++; } else { stats.byConfidence[confBucket].losses++; }

        // Overall (use T-120s as the canonical entry)
        if (t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130) {
            if (t.won) stats.simWins++; else stats.simLosses++;
            stats.simPnlCents += t.netPnlCents;
        }
    }
}

function printStats(stats: RunningStats) {
    const total = stats.simWins + stats.simLosses;
    const winRate = total > 0 ? (stats.simWins / total * 100).toFixed(1) : '0';
    log(`\n--- Running Summary (${stats.markets} markets) ---`);
    log(`  T-120s underdog: ${stats.simWins}W/${stats.simLosses}L (${winRate}% win) | PnL: ${stats.simPnlCents >= 0 ? '+' : ''}${stats.simPnlCents.toFixed(0)}¢`);

    log(`  By entry time:`);
    for (const [bucket, data] of Object.entries(stats.byEntry).sort()) {
        const n = data.wins + data.losses;
        const wr = n > 0 ? (data.wins / n * 100).toFixed(0) : '0';
        log(`    ${bucket}: ${data.wins}W/${data.losses}L (${wr}%) PnL: ${data.pnlCents >= 0 ? '+' : ''}${data.pnlCents.toFixed(0)}¢`);
    }

    log(`  By favorite confidence (mispricing zones):`);
    for (const [bucket, data] of Object.entries(stats.byConfidence).sort()) {
        const n = data.wins + data.losses;
        const wr = n > 0 ? (data.wins / n * 100).toFixed(0) : '0';
        log(`    Fav ${bucket}: ${data.wins}W/${data.losses}L (${wr}%) PnL: ${data.pnlCents >= 0 ? '+' : ''}${data.pnlCents.toFixed(0)}¢`);
    }
    log(`---`);
}

async function main() {
    const args = process.argv.slice(2);
    const durIdx = args.indexOf('--duration');
    const continuous = args.includes('--continuous');
    const durationMinutes = continuous ? Infinity : (durIdx !== -1 ? parseInt(args[durIdx + 1] || '60') : 60);
    const endTime = continuous ? Infinity : Date.now() + durationMinutes * 60 * 1000;

    log(`=== Pricing Data Collector (Multi-Crypto) ===`);
    log(`Mode: ${continuous ? 'CONTINUOUS (runs until stopped)' : `${durationMinutes} minutes`}`);
    log(`Watching: ${MARKET_CONFIGS.map(c => `${c.crypto.toUpperCase()}-${c.interval}m`).join(', ')}`);
    log(`Output (strategy-grade): ${OUTPUT_FILE}`);
    log(`Output (raw valid): ${RAW_OUTPUT_FILE}`);
    log(`Output (rejected): ${REJECTED_OUTPUT_FILE}`);
    log(`Simulated trades: enabled (taker fee: ${TAKER_FEE_RATE * 100}%, gas: ${GAS_COST_CENTS}¢)`);

    // Connect to Chainlink for ALL crypto feeds
    const chainlink = new ChainlinkFeed(); // subscribes to all by default
    await chainlink.connect();

    // Wait for at least BTC price
    let waitCount = 0;
    while (chainlink.getPrice('btc/usd') === 0 && waitCount < 30) {
        await sleep(1000);
        waitCount++;
    }
    if (chainlink.getPrice('btc/usd') === 0) {
        log('ERROR: Could not get Chainlink BTC price after 30s');
        process.exit(1);
    }
    // Wait a bit more for other feeds to connect
    await sleep(3000);
    const prices = chainlink.getAllPrices();
    log(`Chainlink prices: ${Object.entries(prices).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(' | ')}`);

    const { appendFileSync } = await import('node:fs');
    let rawMarketsCollected = 0;
    let strategyMarketsCollected = 0;
    let rejectedMarkets = 0;
    const collectedSlugs = new Set<string>(); // dedup across all markets
    // Track previous resolution PER CRYPTO (not global — each crypto has its own prev chain)
    const prevResolutions: Record<string, string> = {};  // e.g. { 'btc': 'UP', 'eth': 'DOWN' }

    const stats: RunningStats = {
        markets: 0, simWins: 0, simLosses: 0, simPnlCents: 0,
        byEntry: {}, byConfidence: {},
    };

    // Print summary every N markets
    const SUMMARY_INTERVAL = 20; // more markets now, so bump the interval

    while (Date.now() < endTime || continuous) {
        try {
            // Find ALL active markets across cryptos and timeframes
            const activeMarkets = await findAllCurrentMarkets();

            if (activeMarkets.length === 0) {
                log('No markets found, waiting...');
            } else {
                // Find the soonest-ending market group (5m markets end before 15m)
                // Group by end time and process the soonest group together
                const byEndTime = new Map<number, MarketWithConfig[]>();
                for (const m of activeMarkets) {
                    const endMs = new Date(m.market.endDate).getTime();
                    // Round to nearest 10s to group markets ending at ~same time
                    const bucket = Math.round(endMs / 10000) * 10000;
                    if (!byEndTime.has(bucket)) byEndTime.set(bucket, []);
                    byEndTime.get(bucket)!.push(m);
                }

                // Process the soonest-ending batch
                const soonestEnd = Math.min(...byEndTime.keys());
                const batch = byEndTime.get(soonestEnd) || [];

                // Dedup batch by slug before parallel collection (prevents race condition)
                const seenInBatch = new Set<string>();
                const dedupedBatch = batch.filter(m => {
                    if (seenInBatch.has(m.market.slug)) return false;
                    seenInBatch.add(m.market.slug);
                    return true;
                });

                log(`\n--- Batch: ${dedupedBatch.length} markets ending at ${new Date(soonestEnd).toISOString().slice(11, 19)} ---`);

                // Collect all markets in this batch in parallel
                const results = await Promise.all(
                    dedupedBatch.map(async (mInfo) => {
                        if (collectedSlugs.has(mInfo.market.slug)) return null;
                        try {
                            // Get per-crypto prev resolution
                            const cryptoSlug = mInfo.market.slug.split('-')[0]; // 'btc', 'eth', etc.
                            const prevRes = prevResolutions[cryptoSlug] || 'UNKNOWN';
                            return await collectOneMarket(chainlink, prevRes, mInfo);
                        } catch (err: any) {
                            log(`ERROR collecting ${mInfo.market.slug}: ${err.message}`);
                            return null;
                        }
                    })
                );

                // Save results
                for (const record of results) {
                    if (record && record.snapshots.length > 0 && !collectedSlugs.has(record.slug)) {
                        const quality = assessRecordQuality(record);
                        const cryptoSlug = record.slug.split('-')[0];
                        record.prevResolution = prevResolutions[cryptoSlug] || 'UNKNOWN';
                        if (quality.warnings.length > 0) {
                            record.qualityWarnings = quality.warnings;
                            log(`  DATA WARNING ${record.slug}: ${quality.warnings.join('; ')}`);
                        }
                        if (quality.strategyWarnings.length > 0) {
                            record.strategyWarnings = quality.strategyWarnings;
                            log(`  STRATEGY WARNING ${record.slug}: ${quality.strategyWarnings.join('; ')}`);
                        }
                        if (quality.issues.length > 0) {
                            record.qualityIssues = quality.issues;
                        }

                        collectedSlugs.add(record.slug);
                        prevResolutions[cryptoSlug] = record.resolution;

                        if (quality.rejected) {
                            rejectedMarkets++;
                            appendFileSync(REJECTED_OUTPUT_FILE, JSON.stringify({ ...record, rejectedAt: new Date().toISOString() }) + '\n');
                            log(`  REJECTED ${record.slug}: ${quality.issues.join('; ')}`);
                            continue;
                        }

                        appendFileSync(RAW_OUTPUT_FILE, JSON.stringify(record) + '\n');
                        rawMarketsCollected++;

                        if (quality.strategyUsable) {
                            appendFileSync(OUTPUT_FILE, JSON.stringify(record) + '\n');
                            strategyMarketsCollected++;
                            log(`  Saved ${record.slug} (${strategyMarketsCollected} strategy-grade, ${rawMarketsCollected} raw, ${rejectedMarkets} rejected)`);
                            updateStats(stats, record.simulatedTrades);

                            if (strategyMarketsCollected % SUMMARY_INTERVAL === 0) {
                                printStats(stats);
                            }
                        } else {
                            log(`  RAW ONLY ${record.slug}: ${quality.strategyWarnings.join('; ')}`);
                        }
                    }
                }
            }
        } catch (err: any) {
            log(`ERROR in collection loop: ${err.message}`);
            await sleep(15000);
        }
    }

    // Final summary
    printStats(stats);
    chainlink.disconnect();
    log(`\n=== Collection Complete ===`);
    log(`Markets collected: ${strategyMarketsCollected} strategy-grade, ${rawMarketsCollected} raw, ${rejectedMarkets} rejected`);
    log(`Strategy file: ${OUTPUT_FILE}`);
    log(`Raw file: ${RAW_OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
