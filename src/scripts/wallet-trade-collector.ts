/**
 * Raw wallet trade collector for Polymarket crypto markets.
 *
 * Purpose:
 * - collect public market-level trade prints from the Data API
 * - preserve raw payloads for later enrichment and wallet-behavior analysis
 * - stay strictly raw-first and avoid strategy inference at collection time
 *
 * Sources:
 * - Gamma market metadata for recent/current crypto windows
 * - Data API /trades for public market trade activity
 *
 * Output:
 * - wallet-trades.raw.jsonl
 * - state/wallet-trade-collector-state.json
 *
 * Usage:
 *   npx tsx src/scripts/wallet-trade-collector.ts --once
 *   npx tsx src/scripts/wallet-trade-collector.ts --duration 240
 *   npx tsx src/scripts/wallet-trade-collector.ts --continuous --poll-ms 30000
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const OUTPUT_FILE = 'wallet-trades.raw.jsonl';
const STATE_FILE = path.resolve('state/wallet-trade-collector-state.json');
const MAX_RECENT_KEYS_PER_MARKET = 5000;
const DEFAULT_POLL_MS = 30_000;
const DEFAULT_DURATION_MIN = 60;
const DEFAULT_PAGE_LIMIT = 500;
const DEFAULT_MAX_PAGES = 10;

const MARKET_CONFIGS = [
    { crypto: 'btc', interval: 5 },
    { crypto: 'eth', interval: 5 },
    { crypto: 'sol', interval: 5 },
    { crypto: 'xrp', interval: 5 },
    { crypto: 'btc', interval: 15 },
    { crypto: 'eth', interval: 15 },
    { crypto: 'sol', interval: 15 },
    { crypto: 'xrp', interval: 15 },
] as const;

type CryptoSymbol = (typeof MARKET_CONFIGS)[number]['crypto'];
type Interval = (typeof MARKET_CONFIGS)[number]['interval'];

interface GammaMarket {
    id?: string;
    conditionId?: string;
    slug?: string;
    question?: string;
    endDate?: string;
    eventStartTime?: string;
    outcomes?: string;
    clobTokenIds?: string;
    volume?: string | number;
    volumeNum?: number;
}

interface DataApiTrade {
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    asset: string;
    conditionId: string;
    size: number;
    price: number;
    timestamp: number;
    title?: string;
    slug?: string;
    icon?: string;
    eventSlug?: string;
    outcome?: string;
    outcomeIndex?: number;
    name?: string;
    pseudonym?: string;
    bio?: string;
    profileImage?: string;
    profileImageOptimized?: string;
    transactionHash?: string;
}

interface MarketWithConfig {
    market: GammaMarket;
    crypto: CryptoSymbol;
    interval: Interval;
}

interface CollectorArgs {
    durationMs: number;
    continuous: boolean;
    once: boolean;
    pollMs: number;
    pageLimit: number;
    maxPages: number;
}

interface MarketCollectorState {
    maxTimestamp: number;
    recentKeys: Array<{ key: string; timestamp: number }>;
}

interface CollectorState {
    version: number;
    updatedAt: string;
    markets: Record<string, MarketCollectorState>;
}

interface WalletTradeRecord {
    collectedAt: string;
    source: 'data-api/trades';
    crypto: CryptoSymbol;
    interval: Interval;
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
    raw: DataApiTrade;
}

function log(...args: unknown[]): void {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}]`, ...args);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function parseArgs(argv: string[]): CollectorArgs {
    let durationMs = DEFAULT_DURATION_MIN * 60_000;
    let continuous = false;
    let once = false;
    let pollMs = DEFAULT_POLL_MS;
    let pageLimit = DEFAULT_PAGE_LIMIT;
    let maxPages = DEFAULT_MAX_PAGES;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--duration') {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value >= 0) {
                durationMs = value * 60_000;
                i++;
            }
        } else if (arg === '--poll-ms') {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value > 0) {
                pollMs = value;
                i++;
            }
        } else if (arg === '--page-limit') {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value > 0) {
                pageLimit = Math.min(10_000, Math.floor(value));
                i++;
            }
        } else if (arg === '--max-pages') {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value > 0) {
                maxPages = Math.floor(value);
                i++;
            }
        } else if (arg === '--continuous') {
            continuous = true;
        } else if (arg === '--once') {
            once = true;
        }
    }

    if (once) durationMs = 0;

    return {
        durationMs,
        continuous,
        once,
        pollMs,
        pageLimit,
        maxPages,
    };
}

async function fetchJson<T>(url: string): Promise<T> {
    const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (wallet-trade-collector)' },
    });
    if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}: ${url}`);
    }
    return resp.json() as Promise<T>;
}

function parseTokenMap(market: GammaMarket): Record<string, string> {
    try {
        const outcomes = JSON.parse(market.outcomes || '[]') as string[];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
        const result: Record<string, string> = {};

        for (let i = 0; i < outcomes.length; i++) {
            const outcome = outcomes[i]?.toUpperCase();
            const tokenId = tokenIds[i];
            if (outcome && tokenId) result[tokenId] = outcome;
        }

        return result;
    } catch {
        return {};
    }
}

function loadState(): CollectorState {
    if (!existsSync(STATE_FILE)) {
        return {
            version: 1,
            updatedAt: new Date(0).toISOString(),
            markets: {},
        };
    }

    try {
        const raw = readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw) as Partial<CollectorState>;
        return {
            version: parsed.version ?? 1,
            updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
            markets: parsed.markets ?? {},
        };
    } catch {
        return {
            version: 1,
            updatedAt: new Date(0).toISOString(),
            markets: {},
        };
    }
}

function saveState(state: CollectorState): void {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    state.updatedAt = new Date().toISOString();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function getTradeKey(trade: DataApiTrade): string {
    return [
        trade.conditionId,
        trade.asset,
        trade.proxyWallet.toLowerCase(),
        trade.side,
        trade.timestamp,
        trade.price,
        trade.size,
        trade.transactionHash ?? 'no-tx',
    ].join('|');
}

function getMarketState(state: CollectorState, conditionId: string): MarketCollectorState {
    if (!state.markets[conditionId]) {
        state.markets[conditionId] = {
            maxTimestamp: 0,
            recentKeys: [],
        };
    }
    return state.markets[conditionId];
}

function rememberTrade(state: CollectorState, conditionId: string, key: string, timestamp: number): void {
    const marketState = getMarketState(state, conditionId);
    marketState.maxTimestamp = Math.max(marketState.maxTimestamp, timestamp);
    marketState.recentKeys.push({ key, timestamp });
    if (marketState.recentKeys.length > MAX_RECENT_KEYS_PER_MARKET) {
        marketState.recentKeys = marketState.recentKeys
            .sort((a, b) => a.timestamp - b.timestamp)
            .slice(-MAX_RECENT_KEYS_PER_MARKET);
    }
}

function hasSeenTrade(state: CollectorState, conditionId: string, key: string): boolean {
    const marketState = getMarketState(state, conditionId);
    return marketState.recentKeys.some((entry) => entry.key === key);
}

async function findTrackedMarkets(): Promise<MarketWithConfig[]> {
    const now = Math.floor(Date.now() / 1000);
    const seenSlugs = new Set<string>();
    const found = await Promise.all(MARKET_CONFIGS.map(async (cfg) => {
        const step = cfg.interval * 60;
        const rounded = Math.floor(now / step) * step;
        const candidates: GammaMarket[] = [];

        for (const ts of [rounded - step, rounded, rounded + step]) {
            const slug = `${cfg.crypto}-updown-${cfg.interval === 5 ? '5m' : '15m'}-${ts}`;
            if (seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const data = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?slug=${slug}`);
            if (!Array.isArray(data) || data.length === 0) continue;

            const market = data[0];
            const endMs = market.endDate ? new Date(market.endDate).getTime() : 0;
            if (endMs > Date.now() - step * 1000) {
                candidates.push(market);
            }
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            const nowMs = Date.now();
            const aVolume = toNumber(a.volumeNum ?? a.volume);
            const bVolume = toNumber(b.volumeNum ?? b.volume);
            const aEnded = (a.endDate ? new Date(a.endDate).getTime() : 0) <= nowMs ? 1 : 0;
            const bEnded = (b.endDate ? new Date(b.endDate).getTime() : 0) <= nowMs ? 1 : 0;

            if (aEnded !== bEnded) return bEnded - aEnded;
            if (aVolume !== bVolume) return bVolume - aVolume;

            const aEnd = a.endDate ? new Date(a.endDate).getTime() : 0;
            const bEnd = b.endDate ? new Date(b.endDate).getTime() : 0;
            return bEnd - aEnd;
        });

        return { market: candidates[0], crypto: cfg.crypto, interval: cfg.interval };
    }));

    return found.filter((entry): entry is MarketWithConfig => entry !== null);
}

async function fetchMarketTrades(conditionId: string, pageLimit: number, maxPages: number): Promise<DataApiTrade[]> {
    const trades: DataApiTrade[] = [];

    for (let page = 0; page < maxPages; page++) {
        const offset = page * pageLimit;
        const url = `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}&limit=${pageLimit}&offset=${offset}&takerOnly=false`;
        let pageData: DataApiTrade[];
        try {
            pageData = await fetchJson<DataApiTrade[]>(url);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (page > 0 && message.startsWith('400 Bad Request')) {
                break;
            }
            throw error;
        }

        if (!Array.isArray(pageData) || pageData.length === 0) break;
        trades.push(...pageData);
        if (pageData.length < pageLimit) break;
    }

    return trades;
}

function toWalletTradeRecord(
    trade: DataApiTrade,
    market: GammaMarket,
    crypto: CryptoSymbol,
    interval: Interval,
): WalletTradeRecord {
    const collectedAt = new Date().toISOString();
    const timestampMs = trade.timestamp * 1000;

    return {
        collectedAt,
        source: 'data-api/trades',
        crypto,
        interval,
        marketId: market.id ?? null,
        conditionId: trade.conditionId,
        marketSlug: trade.slug ?? market.slug ?? null,
        marketTitle: trade.title ?? market.question ?? null,
        marketEnd: market.endDate ?? null,
        proxyWallet: trade.proxyWallet,
        side: trade.side,
        asset: trade.asset,
        outcome: trade.outcome ?? null,
        outcomeIndex: typeof trade.outcomeIndex === 'number' ? trade.outcomeIndex : null,
        size: trade.size,
        price: trade.price,
        notional: Number((trade.size * trade.price).toFixed(6)),
        timestamp: trade.timestamp,
        tradeIsoTime: Number.isFinite(timestampMs) ? new Date(timestampMs).toISOString() : new Date(0).toISOString(),
        transactionHash: trade.transactionHash ?? null,
        name: trade.name ?? null,
        pseudonym: trade.pseudonym ?? null,
        bio: trade.bio ?? null,
        profileImage: trade.profileImage ?? null,
        profileImageOptimized: trade.profileImageOptimized ?? null,
        raw: trade,
    };
}

async function collectOnce(args: CollectorArgs, state: CollectorState): Promise<{ newTrades: number; marketCount: number }> {
    const markets = await findTrackedMarkets();
    let newTrades = 0;

    if (markets.length === 0) {
        log('No tracked markets found.');
        return { newTrades, marketCount: 0 };
    }

    for (const { market, crypto, interval } of markets) {
        const conditionId = market.conditionId;
        if (!conditionId) {
            log(`Skipping ${market.slug ?? `${crypto}-${interval}m`} with no conditionId`);
            continue;
        }

        const trades = await fetchMarketTrades(conditionId, args.pageLimit, args.maxPages);
        const tokenMap = parseTokenMap(market);
        let marketNewTrades = 0;
        let marketSeenTrades = 0;

        for (const trade of trades) {
            const key = getTradeKey(trade);
            if (hasSeenTrade(state, conditionId, key)) {
                marketSeenTrades++;
                continue;
            }

            // Add raw market token context if it wasn't populated in the trade payload.
            if (!trade.outcome && tokenMap[trade.asset]) {
                trade.outcome = tokenMap[trade.asset];
            }

            const record = toWalletTradeRecord(trade, market, crypto, interval);
            appendFileSync(OUTPUT_FILE, JSON.stringify(record) + '\n');
            rememberTrade(state, conditionId, key, trade.timestamp);
            marketNewTrades++;
            newTrades++;
        }

        const volume = toNumber(market.volumeNum ?? market.volume).toFixed(2);
        log(`${crypto.toUpperCase()} ${interval}m | ${market.slug} | fetched ${trades.length} | new ${marketNewTrades} | seen ${marketSeenTrades} | volume ${volume}`);
    }

    saveState(state);
    return { newTrades, marketCount: markets.length };
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const state = loadState();
    const startTime = Date.now();
    const endTime = startTime + args.durationMs;

    log(`Wallet trade collector starting`);
    log(`Output: ${OUTPUT_FILE}`);
    log(`State: ${STATE_FILE}`);
    log(`Mode: ${args.once ? 'once' : args.continuous ? 'continuous' : `duration ${Math.round(args.durationMs / 60_000)} min`}`);
    log(`Polling: ${args.pollMs}ms | Page limit: ${args.pageLimit} | Max pages: ${args.maxPages}`);

    let totalNewTrades = 0;
    let loops = 0;

    do {
        try {
            loops++;
            const result = await collectOnce(args, state);
            totalNewTrades += result.newTrades;
            log(`Loop ${loops}: ${result.newTrades} new trades across ${result.marketCount} tracked markets (${totalNewTrades} total new)`);
        } catch (error) {
            log(`Collector loop error: ${error instanceof Error ? error.message : String(error)}`);
        }

        if (args.once) break;
        if (!args.continuous && Date.now() >= endTime) break;
        await sleep(args.pollMs);
    } while (true);

    log(`Collector complete: ${totalNewTrades} new trades appended to ${OUTPUT_FILE}`);
}

main().catch((error) => {
    console.error('Wallet trade collector failed:', error);
    process.exitCode = 1;
});
