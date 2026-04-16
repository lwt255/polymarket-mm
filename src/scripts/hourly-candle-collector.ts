/**
 * Hourly-candle collector — tracks `{asset}-up-or-down-{date}-{hour}(am|pm)-et` markets.
 *
 * These are 1-hour direction bets (Binance 1h candle close vs open) with a
 * 48-hour lead time. Collector snapshots book state, spot price, and
 * time-to-expiry every 5 minutes per market.
 *
 * Separate from the 5m bot collector and strike-binary collector. Slower
 * poll cadence than the 5m bot since markets have 48h of lead time.
 *
 * Usage: npx tsx src/scripts/hourly-candle-collector.ts
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const BINANCE = 'https://api.binance.com/api/v3/ticker/price';
const COINGECKO = 'https://api.coingecko.com/api/v3/simple/price';

const OUT_PATH = 'hourly-candle-data.jsonl';
const POLL_INTERVAL_MS = 5 * 60 * 1000;

const ASSETS = ['bitcoin', 'ethereum', 'solana', 'xrp', 'bnb', 'dogecoin', 'hype'] as const;

const BINANCE_SYMBOL: Record<string, string | null> = {
    bitcoin: 'BTCUSDT',
    ethereum: 'ETHUSDT',
    solana: 'SOLUSDT',
    xrp: 'XRPUSDT',
    bnb: 'BNBUSDT',
    dogecoin: 'DOGEUSDT',
    hype: null, // not listed on Binance — uses CoinGecko fallback
};

// CoinGecko IDs for assets not on Binance
const COINGECKO_ID: Record<string, string | null> = {
    hype: 'hyperliquid',
};

const log = (...args: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}]`, ...args);
};

async function fetchJSON(url: string): Promise<any> {
    try {
        // Cloudflare blocks Mozilla/5.0-style UAs on the CLOB. curl-like UA gets through.
        const resp = await fetch(url, { headers: { 'User-Agent': 'curl/8.5.0', 'Accept': '*/*' } });
        if (!resp.ok) return null;
        return await resp.json();
    } catch {
        return null;
    }
}

interface HourlyMarket {
    eventSlug: string;
    marketSlug: string;
    asset: string;
    endDate: string;
    tokenIdUp: string;
    tokenIdDown: string;
    volume: number;
    liquidity: number;
}

async function findHourlyMarkets(): Promise<HourlyMarket[]> {
    const events = await fetchJSON(`${GAMMA}/events?closed=false&active=true&limit=500&tag_id=21`);
    if (!events) return [];

    const out: HourlyMarket[] = [];
    for (const e of events) {
        const slug = (e.slug || '').toLowerCase();
        // Match `{asset}-up-or-down-{date}-{hour}(am|pm)-et` — reject
        // the daily-close variant (`{asset}-up-or-down-on-{date}`) and
        // the 5m/15m/4h microstructure markets (`{asset}-updown-*`).
        if (!slug.includes('-up-or-down-')) continue;
        if (slug.includes('-up-or-down-on-')) continue;
        if (!/am-et$|pm-et$/.test(slug)) continue;

        const asset = ASSETS.find(a => slug.startsWith(`${a}-up-or-down-`));
        if (!asset) continue;

        for (const m of (e.markets || [])) {
            if (!m.active || m.closed || m.archived) continue;
            let tokens: string[];
            try {
                tokens = JSON.parse(m.clobTokenIds || '[]');
            } catch {
                continue;
            }
            if (tokens.length !== 2) continue;
            const outcomes = JSON.parse(m.outcomes || '[]');
            const upIdx = outcomes.findIndex((o: string) => o.toLowerCase() === 'up');
            if (upIdx === -1) continue;
            out.push({
                eventSlug: e.slug,
                marketSlug: m.slug,
                asset,
                endDate: m.endDate || e.endDate,
                tokenIdUp: tokens[upIdx],
                tokenIdDown: tokens[1 - upIdx],
                volume: parseFloat(m.volumeNum || m.volume || 0),
                liquidity: parseFloat(m.liquidityNum || m.liquidity || 0),
            });
        }
    }
    return out;
}

async function getBook(tokenId: string): Promise<{ bid: number; ask: number; mid: number; spread: number } | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || [])
        .map((b: any) => parseFloat(b.price))
        .filter((p: number) => Number.isFinite(p))
        .sort((a: number, b: number) => b - a);
    const asks = (raw.asks || [])
        .map((a: any) => parseFloat(a.price))
        .filter((p: number) => Number.isFinite(p))
        .sort((a: number, b: number) => a - b);
    const bid = bids[0] ?? 0;
    const ask = asks[0] ?? 1;
    return { bid, ask, mid: (bid + ask) / 2, spread: ask - bid };
}

async function getSpotPrices(): Promise<Record<string, number | null>> {
    const out: Record<string, number | null> = {};
    await Promise.all(ASSETS.map(async asset => {
        const sym = BINANCE_SYMBOL[asset];
        if (sym) {
            const raw = await fetchJSON(`${BINANCE}?symbol=${sym}`);
            out[asset] = raw?.price ? parseFloat(raw.price) : null;
        } else {
            const cgId = COINGECKO_ID[asset];
            if (!cgId) { out[asset] = null; return; }
            const raw = await fetchJSON(`${COINGECKO}?ids=${cgId}&vs_currencies=usd`);
            out[asset] = raw?.[cgId]?.usd ?? null;
        }
    }));
    return out;
}

const BOOK_BATCH_SIZE = 10;
const BOOK_BATCH_DELAY_MS = 250;

async function fetchBooksBatched(tokenIds: string[]): Promise<Array<{ bid: number; ask: number; mid: number; spread: number } | null>> {
    const results: Array<{ bid: number; ask: number; mid: number; spread: number } | null> = new Array(tokenIds.length).fill(null);
    for (let start = 0; start < tokenIds.length; start += BOOK_BATCH_SIZE) {
        const batch = tokenIds.slice(start, start + BOOK_BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(id => getBook(id)));
        for (let i = 0; i < batchResults.length; i++) results[start + i] = batchResults[i];
        if (start + BOOK_BATCH_SIZE < tokenIds.length) {
            await new Promise(r => setTimeout(r, BOOK_BATCH_DELAY_MS));
        }
    }
    return results;
}

async function collectSnapshot(markets: HourlyMarket[], spots: Record<string, number | null>): Promise<number> {
    const { createWriteStream } = await import('node:fs');
    const stream = createWriteStream(OUT_PATH, { flags: 'a' });
    const now = new Date();
    const nowMs = now.getTime();
    let written = 0;

    // Fetch UP and DOWN books for each market (interleaved: up0, down0, up1, down1, ...)
    const tokenIds: string[] = [];
    for (const m of markets) {
        tokenIds.push(m.tokenIdUp);
        tokenIds.push(m.tokenIdDown);
    }
    const flatBooks = await fetchBooksBatched(tokenIds);
    const books = markets.map((_, i) => ({ up: flatBooks[i * 2], down: flatBooks[i * 2 + 1] }));

    for (let i = 0; i < markets.length; i++) {
        const m = markets[i];
        const { up, down } = books[i];
        if (!up || !down) continue;
        const endMs = new Date(m.endDate).getTime();
        const hoursToExpiry = (endMs - nowMs) / 3600000;
        if (hoursToExpiry < 0) continue;
        const spot = spots[m.asset];
        const record = {
            timestamp: now.toISOString(),
            asset: m.asset,
            eventSlug: m.eventSlug,
            marketSlug: m.marketSlug,
            endDate: m.endDate,
            hoursToExpiry,
            spot,
            upBid: up.bid, upAsk: up.ask, upMid: up.mid, upSpread: up.spread,
            downBid: down.bid, downAsk: down.ask, downMid: down.mid, downSpread: down.spread,
            volume: m.volume,
            liquidity: m.liquidity,
        };
        stream.write(JSON.stringify(record) + '\n');
        written++;
    }
    stream.end();
    return written;
}

async function main() {
    log('Hourly-Candle Collector starting');
    log(`Poll interval: ${POLL_INTERVAL_MS / 60000}min  Assets: ${ASSETS.join(',')}  Output: ${OUT_PATH}`);

    while (true) {
        const tStart = Date.now();
        try {
            const markets = await findHourlyMarkets();
            const spots = await getSpotPrices();
            const written = await collectSnapshot(markets, spots);
            const assetsSeen = new Set(markets.map(m => m.asset));
            log(`snapshot: ${markets.length} markets (${[...assetsSeen].join(',')}) → ${written} rows | spot: ${Object.entries(spots).filter(([, v]) => v).map(([k, v]) => `${k}=${v}`).join(' ')}`);
        } catch (err: any) {
            log(`snapshot failed: ${err.message}`);
        }
        const elapsed = Date.now() - tStart;
        const wait = Math.max(0, POLL_INTERVAL_MS - elapsed);
        await new Promise(r => setTimeout(r, wait));
    }
}

main().catch(err => {
    log('fatal:', err);
    process.exit(1);
});
