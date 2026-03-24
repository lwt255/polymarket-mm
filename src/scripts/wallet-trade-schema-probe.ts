/**
 * Wallet trade schema probe for Polymarket crypto markets.
 *
 * Purpose:
 * - capture raw trade/event payloads for active crypto markets
 * - inventory identity fields before building wallet research storage
 * - confirm how much attribution is possible from the available APIs
 *
 * This script is intentionally raw-first. It does not rank wallets or infer
 * intent; it only records what the APIs actually expose.
 *
 * Usage:
 *   npx tsx src/scripts/wallet-trade-schema-probe.ts
 *   npx tsx src/scripts/wallet-trade-schema-probe.ts --max-markets 2
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getAuthenticatedClient } from '../core/clob-client.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_API = 'https://data-api.polymarket.com';
const OUTPUT_ROOT = path.resolve('state/wallet-research/schema-samples');

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

interface GammaMarket {
    condition_id?: string;
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

interface MarketWithConfig {
    market: GammaMarket;
    crypto: (typeof MARKET_CONFIGS)[number]['crypto'];
    interval: (typeof MARKET_CONFIGS)[number]['interval'];
}

interface ParsedArgs {
    maxMarkets: number;
}

interface SchemaPresence {
    field: string;
    present: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
    let maxMarkets = Number.POSITIVE_INFINITY;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--max-markets') {
            const value = Number(argv[i + 1]);
            if (Number.isFinite(value) && value > 0) {
                maxMarkets = value;
                i++;
            }
        }
    }

    return { maxMarkets };
}

async function fetchJson<T>(url: string): Promise<T> {
    const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (wallet-trade-schema-probe)' },
    });
    if (!resp.ok) {
        throw new Error(`${resp.status} ${resp.statusText}: ${url}`);
    }
    return resp.json() as Promise<T>;
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
    if (typeof value === 'string') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : 0;
    }
    return 0;
}

function sanitize(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

function collectPaths(value: unknown, prefix = '', depth = 0): string[] {
    if (value === null || value === undefined || depth > 4) return [];
    if (Array.isArray(value)) {
        if (value.length === 0) return prefix ? [prefix] : [];
        const childPrefix = prefix ? `${prefix}[]` : '[]';
        const nested = new Set<string>([childPrefix]);
        for (const item of value.slice(0, 3)) {
            for (const pathName of collectPaths(item, childPrefix, depth + 1)) {
                nested.add(pathName);
            }
        }
        return [...nested];
    }
    if (typeof value !== 'object') {
        return prefix ? [prefix] : [];
    }

    const entries = Object.entries(value as Record<string, unknown>);
    const paths = new Set<string>();
    if (prefix) paths.add(prefix);

    for (const [key, nestedValue] of entries) {
        const childPrefix = prefix ? `${prefix}.${key}` : key;
        paths.add(childPrefix);
        for (const nestedPath of collectPaths(nestedValue, childPrefix, depth + 1)) {
            paths.add(nestedPath);
        }
    }

    return [...paths];
}

function fieldPresence(record: unknown, fields: string[]): SchemaPresence[] {
    const pathSet = new Set(collectPaths(record));
    return fields.map((field) => ({ field, present: pathSet.has(field) }));
}

function parseTokenMap(market: GammaMarket): Record<string, string> {
    try {
        const outcomes = JSON.parse(market.outcomes || '[]') as string[];
        const tokenIds = JSON.parse(market.clobTokenIds || '[]') as string[];
        const result: Record<string, string> = {};

        for (let i = 0; i < outcomes.length; i++) {
            const outcome = outcomes[i]?.toUpperCase();
            const tokenId = tokenIds[i];
            if (outcome && tokenId) result[outcome] = tokenId;
        }

        return result;
    } catch {
        return {};
    }
}

async function findCurrentCryptoMarkets(): Promise<MarketWithConfig[]> {
    const now = Math.floor(Date.now() / 1000);
    const seenSlugs = new Set<string>();
    const found = await Promise.all(MARKET_CONFIGS.map(async (cfg) => {
        const step = cfg.interval * 60;
        const rounded = Math.floor(now / step) * step;
        const suffix = cfg.interval === 5 ? '5m' : '15m';
        const candidates: GammaMarket[] = [];

        for (const ts of [rounded - step, rounded, rounded + step]) {
            const slug = `${cfg.crypto}-updown-${suffix}-${ts}`;
            if (seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const data = await fetchJson<GammaMarket[]>(`${GAMMA}/markets?slug=${slug}`);
            if (!Array.isArray(data) || data.length === 0) continue;

            const market = data[0];
            const endDate = market.endDate ? new Date(market.endDate).getTime() : 0;
            if (endDate > Date.now() - step * 1000) {
                candidates.push(market);
            }
        }

        if (candidates.length === 0) return null;

        candidates.sort((a, b) => {
            const nowMs = Date.now();
            const aVolume = toNumber(a.volumeNum ?? a.volume);
            const bVolume = toNumber(b.volumeNum ?? b.volume);
            const aHasVolume = aVolume > 0 ? 1 : 0;
            const bHasVolume = bVolume > 0 ? 1 : 0;
            if (aHasVolume !== bHasVolume) return bHasVolume - aHasVolume;

            const aEnd = a.endDate ? new Date(a.endDate).getTime() : 0;
            const bEnd = b.endDate ? new Date(b.endDate).getTime() : 0;
            const aEnded = aEnd <= nowMs ? 1 : 0;
            const bEnded = bEnd <= nowMs ? 1 : 0;
            if (aEnded !== bEnded) return bEnded - aEnded;

            if (aVolume !== bVolume) return bVolume - aVolume;
            return bEnd - aEnd;
        });

        return { market: candidates[0], crypto: cfg.crypto, interval: cfg.interval };
    }));

    return found.filter((market): market is MarketWithConfig => market !== null);
}

async function capture<T>(promise: Promise<T>): Promise<{ data: T | null; error: string | null }> {
    try {
        return { data: await promise, error: null };
    } catch (error) {
        return {
            data: null,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

async function main(): Promise<void> {
    const args = parseArgs(process.argv.slice(2));
    const client = await getAuthenticatedClient();

    const runId = new Date().toISOString().replace(/[:.]/g, '-');
    const runDir = path.join(OUTPUT_ROOT, runId);
    mkdirSync(runDir, { recursive: true });

    const markets = (await findCurrentCryptoMarkets()).slice(0, args.maxMarkets);
    if (markets.length === 0) {
        console.log('No active crypto markets found.');
        return;
    }

    console.log(`Probing ${markets.length} active crypto market(s).`);

    const summary: Array<Record<string, unknown>> = [];

    for (const { market, crypto, interval } of markets) {
        const slug = market.slug ?? `${crypto}-${interval}m-unknown-slug`;
        const conditionId = market.condition_id ?? market.conditionId;
        const tokenMap = parseTokenMap(market);
        const marketKey = `${crypto}-${interval}m-${sanitize(slug)}`;

        const marketDir = path.join(runDir, marketKey);
        mkdirSync(marketDir, { recursive: true });
        writeFileSync(path.join(marketDir, 'market.json'), JSON.stringify(market, null, 2));

        if (!conditionId) {
            const marketSummary = {
                crypto,
                interval,
                slug,
                error: 'Missing condition_id on Gamma market payload',
            };
            summary.push(marketSummary);
            writeFileSync(path.join(marketDir, 'summary.json'), JSON.stringify(marketSummary, null, 2));
            continue;
        }

        console.log(`- ${crypto.toUpperCase()} ${interval}m | ${slug}`);

        const eventsPromise = capture(client.getMarketTradesEvents(conditionId));
        const marketTradesPromise = capture(client.getTradesPaginated({ market: conditionId }));
        const dataApiTradesPromise = capture(fetchJson<unknown[]>(
            `${DATA_API}/trades?market=${encodeURIComponent(conditionId)}&limit=50&takerOnly=false`,
        ));
        const tokenTradePromises = Object.entries(tokenMap).map(async ([outcome, tokenId]) => {
            const result = await capture(client.getTradesPaginated({ asset_id: tokenId }));
            return { outcome, tokenId, ...result };
        });

        const [eventsResult, marketTradesResult, dataApiTradesResult, tokenTrades] = await Promise.all([
            eventsPromise,
            marketTradesPromise,
            dataApiTradesPromise,
            Promise.all(tokenTradePromises),
        ]);

        const events = eventsResult.data ?? [];
        const marketTrades = marketTradesResult.data ?? {
            trades: [],
            next_cursor: null,
            limit: 0,
            count: 0,
        };
        const dataApiTrades = dataApiTradesResult.data ?? [];

        writeFileSync(path.join(marketDir, 'market-trade-events.json'), JSON.stringify(eventsResult, null, 2));
        writeFileSync(path.join(marketDir, 'trades-by-market.json'), JSON.stringify(marketTradesResult, null, 2));
        writeFileSync(path.join(marketDir, 'trades-by-data-api.json'), JSON.stringify(dataApiTradesResult, null, 2));
        writeFileSync(path.join(marketDir, 'trades-by-token.json'), JSON.stringify(tokenTrades, null, 2));

        const sampleEvent = events[0] ?? null;
        const sampleTrade = marketTrades.trades[0] ?? null;
        const sampleDataApiTrade = dataApiTrades[0] ?? null;
        const sampleTokenTrade = tokenTrades.find((item) => (item.data?.trades.length ?? 0) > 0)?.data?.trades[0] ?? null;

        const eventFields = sampleEvent ? collectPaths(sampleEvent).sort() : [];
        const tradeFields = sampleTrade ? collectPaths(sampleTrade).sort() : [];
        const dataApiTradeFields = sampleDataApiTrade ? collectPaths(sampleDataApiTrade).sort() : [];
        const tokenTradeFields = sampleTokenTrade ? collectPaths(sampleTokenTrade).sort() : [];

        const eventIdentityFields = sampleEvent
            ? fieldPresence(sampleEvent, [
                'user.address',
                'user.username',
                'transaction_hash',
                'market.condition_id',
                'market.asset_id',
                'outcome',
                'timestamp',
            ])
            : [];

        const tradeIdentityFields = sampleTrade
            ? fieldPresence(sampleTrade, [
                'owner',
                'maker_address',
                'maker_orders[]',
                'maker_orders[].owner',
                'maker_orders[].maker_address',
                'maker_orders[].order_id',
                'trader_side',
                'transaction_hash',
                'market',
                'asset_id',
                'match_time',
            ])
            : [];

        const dataApiIdentityFields = sampleDataApiTrade
            ? fieldPresence(sampleDataApiTrade, [
                'proxyWallet',
                'name',
                'pseudonym',
                'transactionHash',
                'conditionId',
                'asset',
                'outcome',
                'side',
                'timestamp',
            ])
            : [];

        const marketSummary = {
            crypto,
            interval,
            slug,
            question: market.question ?? null,
            conditionId,
            eventsError: eventsResult.error,
            marketTradesError: marketTradesResult.error,
            dataApiTradesError: dataApiTradesResult.error,
            tokenMap,
            eventsCount: events.length,
            marketTradeCount: marketTrades.trades.length,
            marketTradeCountReported: marketTrades.count,
            marketTradeNextCursor: marketTrades.next_cursor,
            dataApiTradeCount: dataApiTrades.length,
            tokenTradeCounts: tokenTrades.map((item) => ({
                outcome: item.outcome,
                tokenId: item.tokenId,
                error: item.error,
                count: item.data?.trades.length ?? 0,
                reportedCount: item.data?.count ?? 0,
                nextCursor: item.data?.next_cursor ?? null,
            })),
            sampleEventFields: eventFields,
            sampleTradeFields: tradeFields,
            sampleDataApiTradeFields: dataApiTradeFields,
            sampleTokenTradeFields: tokenTradeFields,
            eventIdentityFields,
            tradeIdentityFields,
            dataApiIdentityFields,
        };

        summary.push(marketSummary);
        writeFileSync(path.join(marketDir, 'summary.json'), JSON.stringify(marketSummary, null, 2));
    }

    const runSummary = {
        runId,
        generatedAt: new Date().toISOString(),
        marketsProbed: summary.length,
        summary,
    };

    writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(runSummary, null, 2));

    console.log(`Schema samples written to ${runDir}`);
}

main().catch((error) => {
    console.error('Schema probe failed:', error);
    process.exitCode = 1;
});
