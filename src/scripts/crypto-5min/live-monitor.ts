/**
 * Live Monitor: Watch a 5-minute BTC candle in real-time
 *
 * Polls both BTC spot price and Polymarket order book every 5 seconds
 * to see how the market prices evolve relative to our fair value model.
 *
 * This is the core research tool: we need to see WHERE mispricings occur
 * during the lifecycle of a 5-minute candle.
 */

import { calculateFairValue, calculateRealizedVol } from './fair-value.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const COINBASE = 'https://api.exchange.coinbase.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

async function getBTCPrice(): Promise<number> {
    // Use Coinbase Exchange ticker (real-time) not retail spot (cached)
    const data = await fetchJSON('https://api.exchange.coinbase.com/products/BTC-USD/ticker');
    if (data?.price) return parseFloat(data.price);
    // Fallback
    const spot = await fetchJSON('https://api.coinbase.com/v2/prices/BTC-USD/spot');
    return parseFloat(spot.data.amount);
}

async function getRecentVol(): Promise<number> {
    try {
        const data = await fetchJSON(`${COINBASE}/products/BTC-USD/candles?granularity=300&start=${new Date(Date.now() - 3600000 * 3).toISOString()}&end=${new Date().toISOString()}`);
        const closes = data.reverse().map((c: any[]) => c[4]);
        return calculateRealizedVol(closes, 5);
    } catch {
        return 0.50;
    }
}

/**
 * Also poll Kraken for cross-reference (Chainlink often uses multiple feeds)
 */
async function getKrakenBTCPrice(): Promise<number> {
    try {
        const data = await fetchJSON('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
        return parseFloat(data.result?.XXBTZUSD?.c?.[0] || '0');
    } catch {
        return 0;
    }
}

async function findCurrentMarket() {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    // Try current and next window
    for (const ts of [rounded, rounded + 300]) {
        const slug = `btc-updown-5m-${ts}`;
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data && data.length > 0) {
            const m = data[0];
            if (!m.closed && m.active) return m;
        }
    }
    return null;
}

async function getOrderBook(tokenId: string) {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, bidDepth: 0, askDepth: 0 };

    const bids = (raw.bids || []).map((b: any) => ({ p: parseFloat(b.price), s: parseFloat(b.size) })).sort((a: any, b: any) => b.p - a.p);
    const asks = (raw.asks || []).map((a: any) => ({ p: parseFloat(a.price), s: parseFloat(a.size) })).sort((a: any, b: any) => a.p - b.p);

    // Depth within 5 cents of touch
    const bestBid = bids[0]?.p ?? 0;
    const bestAsk = asks[0]?.p ?? 1;
    const bidDepth = bids.filter((b: any) => b.p >= bestBid - 0.05).reduce((sum: number, b: any) => sum + b.s, 0);
    const askDepth = asks.filter((a: any) => a.p <= bestAsk + 0.05).reduce((sum: number, a: any) => sum + a.s, 0);

    return { bestBid, bestAsk, bidDepth, askDepth };
}

async function main() {
    console.log('=== Live 5-Minute BTC Market Monitor ===\n');

    // Get baseline vol
    const vol = await getRecentVol();
    console.log(`Realized vol (3h, 5m intervals): ${(vol * 100).toFixed(1)}% annualized`);

    // Get initial BTC price
    const btcStart = await getBTCPrice();
    console.log(`BTC starting price: $${btcStart.toLocaleString()}`);

    // Find current active market
    let market = await findCurrentMarket();
    if (!market) {
        console.log('\nNo active market found. Waiting for next candle...');
        // Wait and retry
        await new Promise(r => setTimeout(r, 10000));
        market = await findCurrentMarket();
    }

    if (!market) {
        console.log('Still no active market. Markets might not be running right now.');
        console.log('Searching for the most recent market to show its final state...');

        const now = Math.floor(Date.now() / 1000);
        const rounded = Math.floor(now / 300) * 300;
        for (let i = 0; i <= 5; i++) {
            const ts = rounded - (i * 300);
            const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
            if (data && data.length > 0) {
                market = data[0];
                console.log(`\nFound recent market: ${market.question}`);
                console.log(`Closed: ${market.closed} | Prices: ${market.outcomePrices}`);
                break;
            }
        }
        if (!market) return;
    }

    console.log(`\nMonitoring: ${market.question}`);
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const eventStart = market.eventStartTime ? new Date(market.eventStartTime) : null;
    const endDate = new Date(market.endDate);
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];

    if (eventStart) {
        console.log(`Candle window: ${eventStart.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`);
    }
    console.log(`\nPolling every 5 seconds...\n`);

    // Track candle open price
    let candleOpenPrice: number | null = null;
    const snapshots: any[] = [];

    const header = 'Time     | BTC Price  | Move    | Fair  | Mkt Up | Mkt Dn | Spread | Edge   | BidDep  | AskDep';
    console.log(header);
    console.log('-'.repeat(header.length));

    // Poll loop
    const POLL_INTERVAL = 5000;
    const MAX_POLLS = 80; // 80 * 5s = 400s = ~6.5 min (covers full candle + buffer)

    for (let i = 0; i < MAX_POLLS; i++) {
        try {
            const [btcPrice, upBook, downBook] = await Promise.all([
                getBTCPrice(),
                getOrderBook(upToken),
                getOrderBook(downToken),
            ]);

            const now = new Date();

            // Set candle open on first poll during the event window
            if (!candleOpenPrice && eventStart && now >= eventStart) {
                candleOpenPrice = btcPrice;
            }
            if (!candleOpenPrice) {
                candleOpenPrice = btcStart;
            }

            // Time remaining
            const minLeft = Math.max(0, (endDate.getTime() - now.getTime()) / 60000);

            // Fair value
            const fv = calculateFairValue({
                spotPrice: btcPrice,
                strikePrice: candleOpenPrice,
                timeToExpiryMin: minLeft,
                annualizedVol: vol,
            });

            // Market prices
            const marketUp = (upBook.bestBid + upBook.bestAsk) / 2;
            const marketDown = (downBook.bestBid + downBook.bestAsk) / 2;
            const spread = upBook.bestAsk - upBook.bestBid;
            const edge = fv.fairPrice - marketUp;

            const btcMove = btcPrice - candleOpenPrice;
            const moveStr = (btcMove >= 0 ? '+' : '') + btcMove.toFixed(1);

            const snapshot = {
                time: now.toLocaleTimeString(),
                btcPrice,
                btcMove,
                fairValue: fv.fairPrice,
                marketUp,
                marketDown,
                spread,
                edge,
                bidDepth: upBook.bidDepth,
                askDepth: upBook.askDepth,
                minLeft,
            };
            snapshots.push(snapshot);

            console.log(
                `${now.toLocaleTimeString().padEnd(9)}| ` +
                `$${btcPrice.toFixed(0).padStart(7)}  | ` +
                `${moveStr.padStart(7)} | ` +
                `${(fv.fairPrice * 100).toFixed(1).padStart(5)}%| ` +
                `${(marketUp * 100).toFixed(1).padStart(5)}% | ` +
                `${(marketDown * 100).toFixed(1).padStart(5)}% | ` +
                `${(spread * 100).toFixed(1).padStart(5)}c | ` +
                `${(edge * 100).toFixed(1).padStart(5)}% | ` +
                `$${upBook.bidDepth.toFixed(0).padStart(6)} | ` +
                `$${upBook.askDepth.toFixed(0).padStart(6)}`
            );

            // Check if market ended
            if (minLeft <= 0) {
                console.log('\n--- Market expired ---');
                break;
            }

            // Check if market was closed (resolution)
            const refreshed = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
            if (refreshed && refreshed[0]?.closed) {
                const finalPrices = JSON.parse(refreshed[0].outcomePrices || '[]').map(Number);
                const result = finalPrices[0] >= 0.95 ? 'UP' : 'DOWN';
                console.log(`\n--- RESOLVED: ${result} | Final volume: $${parseFloat(refreshed[0].volume).toFixed(0)} ---`);
                break;
            }

            await new Promise(r => setTimeout(r, POLL_INTERVAL));
        } catch (err) {
            console.log(`  [Error: ${(err as Error).message}]`);
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
        }
    }

    // Summary
    if (snapshots.length > 0) {
        console.log('\n=== Session Summary ===');
        const edges = snapshots.map(s => Math.abs(s.edge));
        const avgEdge = edges.reduce((a, b) => a + b, 0) / edges.length;
        const maxEdge = Math.max(...edges);
        const spreads = snapshots.map(s => s.spread);
        const avgSpread = spreads.reduce((a, b) => a + b, 0) / spreads.length;

        console.log(`Snapshots: ${snapshots.length}`);
        console.log(`Avg |edge| (fair vs market): ${(avgEdge * 100).toFixed(2)}%`);
        console.log(`Max |edge|: ${(maxEdge * 100).toFixed(2)}%`);
        console.log(`Avg spread: ${(avgSpread * 100).toFixed(2)}c`);
        console.log(`Edge > spread: ${snapshots.filter(s => Math.abs(s.edge) > s.spread).length}/${snapshots.length} snapshots`);

        // Was our fair value right?
        const lastSnapshot = snapshots[snapshots.length - 1];
        const wasUp = lastSnapshot.btcMove >= 0;
        const ourCall = lastSnapshot.fairValue > 0.5 ? 'UP' : 'DOWN';
        console.log(`\nBTC moved: ${lastSnapshot.btcMove >= 0 ? '+' : ''}$${lastSnapshot.btcMove.toFixed(2)} → ${wasUp ? 'UP' : 'DOWN'}`);
        console.log(`Our fair value at end: ${(lastSnapshot.fairValue * 100).toFixed(1)}% → Called: ${ourCall}`);
        console.log(`Correct: ${(wasUp && ourCall === 'UP') || (!wasUp && ourCall === 'DOWN') ? 'YES' : 'NO'}`);
    }
}

main().catch(console.error);
