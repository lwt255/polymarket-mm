/**
 * Explore live 5-minute crypto binary options on Polymarket
 *
 * Fetches active markets, their order books, and calculates fair values
 * to identify mispricing opportunities.
 */

import { calculateFairValue, calculateRealizedVol, calculateTakerFee } from './fair-value.js';

interface PolyMarket {
    id: string;
    question: string;
    conditionId: string;
    slug: string;
    outcomes: string;
    clobTokenIds: string;
    outcomePrices: string;
    volume: string;
    endDate: string;
    startDate: string;
    eventStartTime?: string;
    bestBid?: number;
    bestAsk?: number;
    lastTradePrice?: number;
    active: boolean;
    closed: boolean;
}

interface OrderBook {
    bids: Array<{ price: string; size: string }>;
    asks: Array<{ price: string; size: string }>;
}

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${url}`);
    return resp.json();
}

/**
 * Find active 5-minute crypto markets
 */
async function findActive5MinMarkets(): Promise<PolyMarket[]> {
    // Search for BTC up/down 5m markets
    const markets = await fetchJSON(
        `${GAMMA_API}/markets?closed=false&limit=50&order=createdAt&ascending=false`
    );

    // Filter for 5-minute crypto binary markets
    const crypto5min = markets.filter((m: any) => {
        const q = (m.question || '').toLowerCase();
        return (
            (q.includes('up or down') || q.includes('up/down')) &&
            (q.includes('5m') || q.includes('5 min') || q.includes(':')) &&
            (q.includes('bitcoin') || q.includes('btc') || q.includes('ethereum') || q.includes('eth'))
        );
    });

    return crypto5min;
}

/**
 * Fetch order book for a token
 */
async function fetchOrderBook(tokenId: string): Promise<OrderBook> {
    const book = await fetchJSON(`${CLOB_API}/book?token_id=${tokenId}`);
    return {
        bids: book.bids || [],
        asks: book.asks || [],
    };
}

/**
 * Fetch current BTC price from a public API
 */
async function fetchBTCPrice(): Promise<number> {
    // Try Coinbase first (no geo-restrictions)
    try {
        const data = await fetchJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot');
        return parseFloat(data.data.amount);
    } catch {
        // Fallback to CoinGecko
        const data = await fetchJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd');
        return data.bitcoin.usd;
    }
}

/**
 * Fetch recent 5-min BTC candles for vol calculation
 * Uses Coinbase (no geo-restrictions) or Kraken as fallback
 */
async function fetchRecentBTCCandles(intervalMin: number = 5, limit: number = 60): Promise<number[]> {
    try {
        // Coinbase Pro / Exchange API - granularity in seconds
        const granularity = intervalMin * 60;
        const end = new Date().toISOString();
        const start = new Date(Date.now() - limit * granularity * 1000).toISOString();
        const data = await fetchJSON(
            `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=${granularity}&start=${start}&end=${end}`
        );
        // Coinbase returns [timestamp, low, high, open, close, volume] newest first
        return data.reverse().map((candle: any[]) => candle[4]); // close prices
    } catch {
        // Fallback: Kraken OHLC
        const interval = intervalMin;
        const data = await fetchJSON(
            `https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=${interval}`
        );
        const pairs = Object.keys(data.result).filter(k => k !== 'last');
        const candles = data.result[pairs[0]];
        return candles.slice(-limit).map((c: any[]) => parseFloat(c[4])); // close prices
    }
}

/**
 * Parse the strike/open price from the market question or event data
 * For "Up or Down" markets, the strike is the BTC price at eventStartTime
 */
function parseEventTiming(market: PolyMarket): { startTime: Date; endTime: Date; minutesLeft: number } | null {
    const endTime = new Date(market.endDate);
    const startTime = market.eventStartTime ? new Date(market.eventStartTime) : new Date(market.startDate);
    const now = new Date();
    const minutesLeft = (endTime.getTime() - now.getTime()) / (1000 * 60);

    if (minutesLeft < 0) return null;

    return { startTime, endTime, minutesLeft };
}

async function main() {
    console.log('=== Polymarket 5-Minute Crypto Market Explorer ===\n');

    // Fetch BTC price and recent candles in parallel
    const [btcPrice, recentPrices] = await Promise.all([
        fetchBTCPrice(),
        fetchRecentBTCCandles(5, 60),
    ]);

    const realizedVol = calculateRealizedVol(recentPrices, 5);

    console.log(`Current BTC Price: $${btcPrice.toLocaleString()}`);
    console.log(`5-Min Realized Vol (5h lookback): ${(realizedVol * 100).toFixed(1)}% annualized`);
    console.log(`Implied 5-min move (1 SD): $${(btcPrice * realizedVol * Math.sqrt(5 / (365.25 * 24 * 60))).toFixed(2)}`);
    console.log('');

    // Find active markets
    console.log('Searching for active 5-minute crypto markets...\n');

    let markets: PolyMarket[];
    try {
        markets = await findActive5MinMarkets();
    } catch (err) {
        console.log('Direct search returned no results. Trying broader search...');
        // Try fetching from the series endpoint
        const series = await fetchJSON(`${GAMMA_API}/events?closed=false&tag=Crypto&limit=20`);
        markets = [];
        for (const event of series) {
            if (event.markets) {
                for (const m of event.markets) {
                    const q = (m.question || '').toLowerCase();
                    if (q.includes('up or down') && (q.includes('5m') || q.includes('5 min') || q.includes(':') && q.includes('et'))) {
                        markets.push(m);
                    }
                }
            }
        }
    }

    console.log(`Found ${markets.length} active 5-min crypto markets\n`);

    if (markets.length === 0) {
        console.log('No active 5-min markets found. Trying to fetch by slug pattern...');

        // Try direct slug-based lookup
        const now = Math.floor(Date.now() / 1000);
        const roundedTo5Min = Math.floor(now / 300) * 300;

        for (let offset = 0; offset <= 3; offset++) {
            const ts = roundedTo5Min + (offset * 300);
            const slug = `btc-updown-5m-${ts}`;
            try {
                const market = await fetchJSON(`${GAMMA_API}/markets?slug=${slug}`);
                if (market && market.length > 0) {
                    markets.push(...market);
                }
            } catch {}
        }

        // Also try with different slug formats
        try {
            const searchResults = await fetchJSON(
                `${GAMMA_API}/markets?closed=false&limit=10&order=createdAt&ascending=false&tag=Crypto`
            );
            for (const m of searchResults) {
                const q = (m.question || '').toLowerCase();
                if (q.includes('bitcoin') && (q.includes('up or down') || q.includes('up/down'))) {
                    markets.push(m);
                }
            }
        } catch {}

        console.log(`After expanded search: ${markets.length} markets found\n`);
    }

    // Analyze each market
    for (const market of markets.slice(0, 10)) {
        console.log(`--- ${market.question} ---`);

        const timing = parseEventTiming(market);
        if (!timing) {
            console.log('  [EXPIRED]\n');
            continue;
        }

        console.log(`  Time left: ${timing.minutesLeft.toFixed(2)} minutes`);
        console.log(`  Event window: ${timing.startTime.toLocaleTimeString()} - ${timing.endTime.toLocaleTimeString()}`);

        // Parse token IDs and prices
        let tokenIds: string[] = [];
        let outcomePrices: number[] = [];
        try {
            tokenIds = JSON.parse(market.clobTokenIds || '[]');
            outcomePrices = JSON.parse(market.outcomePrices || '[]').map(Number);
        } catch {}

        if (outcomePrices.length >= 2) {
            console.log(`  Market prices: Up=${(outcomePrices[0] * 100).toFixed(1)}% | Down=${(outcomePrices[1] * 100).toFixed(1)}%`);
        }

        // Fetch order book for the "Up" token
        if (tokenIds.length >= 1) {
            try {
                const book = await fetchOrderBook(tokenIds[0]);
                const bestBid = book.bids.length > 0 ? parseFloat(book.bids[book.bids.length - 1].price) : 0;
                const bestAsk = book.asks.length > 0 ? parseFloat(book.asks[0].price) : 1;
                const spread = bestAsk - bestBid;
                const midpoint = (bestBid + bestAsk) / 2;

                console.log(`  Order book (Up): Best Bid=${bestBid.toFixed(2)} | Best Ask=${bestAsk.toFixed(2)} | Spread=${(spread * 100).toFixed(1)}%`);
                console.log(`  Book depth: ${book.bids.length} bid levels, ${book.asks.length} ask levels`);

                // Calculate fair value
                // For "up or down", strike = BTC price at candle open
                // We approximate: if market is at 50/50, strike ≈ current price
                // Better: strike = current price adjusted by market's implied probability
                const impliedStrike = btcPrice; // Approximation - need actual candle open

                const fv = calculateFairValue({
                    spotPrice: btcPrice,
                    strikePrice: impliedStrike,
                    timeToExpiryMin: timing.minutesLeft,
                    annualizedVol: realizedVol,
                });

                const takerFee = calculateTakerFee(midpoint);

                console.log(`  Fair value (N(d2)): ${(fv.fairPrice * 100).toFixed(2)}% (assuming strike ≈ spot)`);
                console.log(`  Market midpoint: ${(midpoint * 100).toFixed(2)}%`);
                console.log(`  Mispricing: ${((fv.fairPrice - midpoint) * 100).toFixed(2)}%`);
                console.log(`  Taker fee at midpoint: ${(takerFee * 100).toFixed(2)}%`);
                console.log(`  Net edge (after taker fee): ${(Math.abs(fv.fairPrice - midpoint) * 100 - takerFee * 100).toFixed(2)}%`);
            } catch (err) {
                console.log(`  [Could not fetch order book: ${(err as Error).message}]`);
            }
        }

        console.log('');
    }

    // Show the fee curve
    console.log('\n=== Taker Fee Curve (Crypto Markets) ===');
    console.log('Price  | Taker Fee | Net cost to buy+sell');
    for (let p = 0.05; p <= 0.95; p += 0.05) {
        const fee = calculateTakerFee(p);
        console.log(`  ${(p * 100).toFixed(0).padStart(3)}%  |  ${(fee * 100).toFixed(2)}%   | ${(fee * 200).toFixed(2)}% round-trip`);
    }

    console.log('\n=== Strategy Implications ===');
    console.log('1. MAKER orders = 0% fee (100% rebate). Always prefer limit orders.');
    console.log('2. At 50/50 odds, taker fee is 2.5% — kills latency arb.');
    console.log('3. At extreme odds (<15% or >85%), taker fee drops below 1.3%.');
    console.log('4. Edge must exceed spread + taker fee to profit as taker.');
    console.log('5. As maker, edge only needs to exceed spread to profit.');
}

main().catch(console.error);
