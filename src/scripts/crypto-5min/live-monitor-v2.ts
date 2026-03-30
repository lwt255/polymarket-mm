/**
 * Live Monitor V2: Chainlink-powered 5-minute BTC candle monitor
 *
 * Uses the EXACT Chainlink price feed from Polymarket's RTDS WebSocket
 * to calculate fair value and compare against market pricing.
 *
 * This is the real deal — same price feed that determines resolution.
 */

import { calculateFairValue, calculateRealizedVol } from './fair-value.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const WS_URL = 'wss://ws-live-data.polymarket.com';

// ─── Chainlink WebSocket Feed ───

let chainlinkPrice = 0;
let chainlinkTimestamp = 0;
let chainlinkUpdateCount = 0;
let ws: WebSocket | null = null;
let pingTimer: NodeJS.Timeout | null = null;

function connectChainlink(): Promise<void> {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(WS_URL);

        ws.onopen = () => {
            ws!.send(JSON.stringify({
                action: 'subscribe',
                subscriptions: [{
                    topic: 'crypto_prices_chainlink',
                    type: '*',
                    filters: JSON.stringify({ symbol: 'btc/usd' }),
                }]
            }));
            pingTimer = setInterval(() => {
                if (ws?.readyState === 1) ws.send('PING');
            }, 5000);
            resolve();
        };

        ws.onmessage = (event: any) => {
            const data = event.data.toString();
            if (data === 'PONG' || data === '') return;
            try {
                const msg = JSON.parse(data);
                if (msg.topic === 'crypto_prices_chainlink' && msg.payload?.value) {
                    chainlinkPrice = msg.payload.value;
                    chainlinkTimestamp = msg.payload.timestamp;
                    chainlinkUpdateCount++;
                }
            } catch {}
        };

        ws.onerror = (e: any) => reject(e);
        ws.onclose = () => {
            if (pingTimer) clearInterval(pingTimer);
            // Auto-reconnect
            setTimeout(() => connectChainlink(), 1000);
        };
    });
}

function disconnectChainlink() {
    if (pingTimer) clearInterval(pingTimer);
    if (ws) ws.close();
}

// ─── API Helpers ───

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

async function findMarket(offset: number) {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    const ts = rounded + (offset * 300);
    const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
    return data?.[0] || null;
}

async function getBookSnapshot(tokenId: string) {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;

    const bids = (raw.bids || []).map((b: any) => ({ p: parseFloat(b.price), s: parseFloat(b.size) })).sort((a: any, b: any) => b.p - a.p);
    const asks = (raw.asks || []).map((a: any) => ({ p: parseFloat(a.price), s: parseFloat(a.size) })).sort((a: any, b: any) => a.p - b.p);

    return { bids, asks };
}

// ─── Realized Vol from Coinbase (for model input) ───

async function getRecentVol(): Promise<number> {
    try {
        const data = await fetchJSON(
            `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=300&start=${new Date(Date.now() - 3600000 * 3).toISOString()}&end=${new Date().toISOString()}`
        );
        const closes = data.reverse().map((c: any[]) => c[4]);
        return calculateRealizedVol(closes, 5);
    } catch {
        return 0.55;
    }
}

// ─── Snapshot type ───

interface Snapshot {
    time: string;
    secondsIn: number;
    chainlinkPrice: number;
    btcMove: number;
    fairValue: number;
    bestBid: number;
    bestAsk: number;
    marketMid: number;
    spread: number;
    edge: number;
    bidDepth5c: number;
    askDepth5c: number;
}

// ─── Monitor a single candle ───

async function monitorCandle(candleNum: number, vol: number): Promise<{ snapshots: Snapshot[]; outcome: string; volume: number; question: string }> {
    // Find current candle: try offset 0 first, then 1 (upcoming)
    let market = await findMarket(0);

    // If the market we found has already ended, get the next one
    if (market) {
        const end = new Date(market.endDate);
        if (end.getTime() < Date.now() - 5000) {
            market = await findMarket(1);
        }
    }
    if (!market) market = await findMarket(1);
    if (!market) return { snapshots: [], outcome: '?', volume: 0, question: 'NOT FOUND' };

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const eventStart = new Date(market.eventStartTime);
    const endDate = new Date(market.endDate);

    console.log(`\n  Candle ${candleNum}: ${market.question}`);
    console.log(`  Window: ${eventStart.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`);

    // Wait for candle to actually start
    const msUntilStart = eventStart.getTime() - Date.now();
    if (msUntilStart > 0 && msUntilStart < 310000) {
        console.log(`  Waiting ${(msUntilStart / 1000).toFixed(0)}s for event start...`);
        await new Promise(r => setTimeout(r, msUntilStart + 500));
    }

    // Capture the opening price from Chainlink at candle start
    const openPrice = chainlinkPrice;
    console.log(`  Chainlink open price: $${openPrice.toFixed(2)}`);

    const snapshots: Snapshot[] = [];
    const POLL_MS = 2000; // Poll every 2 seconds for finer resolution

    while (true) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;
        if (secondsLeft < -3) break;

        const secondsIn = 300 - secondsLeft;
        const btcMove = chainlinkPrice - openPrice;
        const minLeft = Math.max(0.01, secondsLeft / 60);

        // Fair value from N(d2)
        const fv = calculateFairValue({
            spotPrice: chainlinkPrice,
            strikePrice: openPrice,
            timeToExpiryMin: minLeft,
            annualizedVol: vol,
        });

        // Order book
        const book = await getBookSnapshot(upToken);
        const bestBid = book?.bids[0]?.p ?? 0;
        const bestAsk = book?.asks[0]?.p ?? 1;
        const marketMid = (bestBid + bestAsk) / 2;
        const spread = bestAsk - bestBid;
        const edge = fv.fairPrice - marketMid;

        // Depth within 5c of touch
        const bidDepth5c = book?.bids.filter((b: any) => b.p >= bestBid - 0.05).reduce((s: number, b: any) => s + b.s, 0) ?? 0;
        const askDepth5c = book?.asks.filter((a: any) => a.p <= bestAsk + 0.05).reduce((s: number, a: any) => s + a.s, 0) ?? 0;

        const snap: Snapshot = {
            time: new Date().toLocaleTimeString(),
            secondsIn,
            chainlinkPrice: chainlinkPrice,
            btcMove,
            fairValue: fv.fairPrice,
            bestBid,
            bestAsk,
            marketMid,
            spread,
            edge,
            bidDepth5c,
            askDepth5c,
        };
        snapshots.push(snap);

        // Log every ~6 seconds (every 3rd poll)
        if (snapshots.length % 3 === 1 || secondsLeft < 5) {
            const moveStr = (btcMove >= 0 ? '+' : '') + btcMove.toFixed(1);
            const edgeStr = (edge >= 0 ? '+' : '') + (edge * 100).toFixed(1);
            const dir = fv.fairPrice > 0.6 ? 'UP' : fv.fairPrice < 0.4 ? 'DN' : '--';
            console.log(
                `    ${Math.round(secondsIn).toString().padStart(3)}s | ` +
                `CL:$${chainlinkPrice.toFixed(0)} ${moveStr.padStart(6)} | ` +
                `Fair:${(fv.fairPrice * 100).toFixed(1).padStart(5)}% | ` +
                `Mkt:${(marketMid * 100).toFixed(1).padStart(5)}% | ` +
                `Edge:${edgeStr.padStart(6)}% | ` +
                `Sprd:${(spread * 100).toFixed(1)}c | ` +
                `${dir}`
            );
        }

        await new Promise(r => setTimeout(r, POLL_MS));
    }

    // Wait for resolution
    await new Promise(r => setTimeout(r, 8000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const finalPrices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    const outcome = finalPrices[0] >= 0.95 ? 'UP' : finalPrices[1] >= 0.95 ? 'DOWN' : '?';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Also check by looking at the last Chainlink price vs open
    const impliedOutcome = chainlinkPrice >= openPrice ? 'UP' : 'DOWN';

    console.log(`    --- RESULT: ${outcome} (Chainlink implied: ${impliedOutcome}) | Volume: $${volume.toFixed(0)} ---`);

    return { snapshots, outcome: outcome !== '?' ? outcome : impliedOutcome, volume, question: market.question };
}

// ─── Main ───

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '5');
    console.log(`=== Live Monitor V2: ${NUM_CANDLES} candles with Chainlink feed ===\n`);

    // Connect to Chainlink
    console.log('Connecting to Chainlink RTDS...');
    await connectChainlink();

    // Wait for first price
    let waited = 0;
    while (chainlinkPrice === 0 && waited < 10000) {
        await new Promise(r => setTimeout(r, 200));
        waited += 200;
    }
    console.log(`Chainlink BTC/USD: $${chainlinkPrice.toFixed(2)} (${chainlinkUpdateCount} updates received)`);

    // Get realized vol
    const vol = await getRecentVol();
    console.log(`Realized vol (3h): ${(vol * 100).toFixed(1)}% annualized`);
    console.log(`Implied 5-min 1SD move: $${(chainlinkPrice * vol * Math.sqrt(5 / (365.25 * 24 * 60))).toFixed(2)}`);

    const allResults: Array<{ snapshots: Snapshot[]; outcome: string; volume: number; question: string }> = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        // Wait until we're within the first 10 seconds of a 5-min boundary
        while (true) {
            const now = Date.now();
            const secIntoRound = (now % 300000) / 1000;
            if (secIntoRound < 10) break; // We're near the start of a candle
            const waitMs = (300 - secIntoRound) * 1000 + 1000; // Wait for next boundary + 1s
            console.log(`\nWaiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, Math.min(waitMs, 300000)));
        }

        const result = await monitorCandle(i + 1, vol);
        allResults.push(result);
    }

    // ─── AGGREGATE ANALYSIS ───
    console.log('\n' + '='.repeat(75));
    console.log('AGGREGATE ANALYSIS');
    console.log('='.repeat(75));

    const validResults = allResults.filter(r => r.snapshots.length > 0);
    const allSnaps = validResults.flatMap(r => r.snapshots);

    console.log(`\nCandles: ${validResults.length}`);
    const ups = validResults.filter(r => r.outcome === 'UP').length;
    const downs = validResults.filter(r => r.outcome === 'DOWN').length;
    console.log(`Outcomes: ${ups} UP / ${downs} DOWN`);
    console.log(`Total volume: $${validResults.reduce((s, r) => s + r.volume, 0).toLocaleString()}`);

    // Edge by time bucket
    console.log('\n--- Edge by Time (seconds into candle) ---');
    const buckets = [
        [0, 30, 'First 30s'],
        [30, 60, '30-60s'],
        [60, 120, '1-2 min'],
        [120, 180, '2-3 min'],
        [180, 240, '3-4 min'],
        [240, 270, '4-4.5 min'],
        [270, 300, 'Last 30s'],
    ];
    for (const [low, high, label] of buckets) {
        const inBucket = allSnaps.filter(s => s.secondsIn >= (low as number) && s.secondsIn < (high as number));
        if (inBucket.length === 0) continue;
        const avgAbsEdge = inBucket.reduce((s, snap) => s + Math.abs(snap.edge), 0) / inBucket.length;
        const avgEdge = inBucket.reduce((s, snap) => s + snap.edge, 0) / inBucket.length;
        const avgSpread = inBucket.reduce((s, snap) => s + snap.spread, 0) / inBucket.length;
        const edgeVsSpread = avgAbsEdge / avgSpread;
        const bar = '#'.repeat(Math.min(50, Math.round(avgAbsEdge * 200)));
        console.log(
            `  ${(label as string).padEnd(12)} | ` +
            `|Edge|: ${(avgAbsEdge * 100).toFixed(2).padStart(6)}% | ` +
            `Avg Edge: ${(avgEdge * 100).toFixed(2).padStart(6)}% | ` +
            `Spread: ${(avgSpread * 100).toFixed(2).padStart(5)}c | ` +
            `Edge/Spread: ${edgeVsSpread.toFixed(1).padStart(5)}x | ${bar}`
        );
    }

    // Direction accuracy: when fair value > 0.5, did it resolve UP?
    console.log('\n--- Fair Value Directional Accuracy ---');
    for (const result of validResults) {
        const midSnaps = result.snapshots.filter(s => s.secondsIn >= 30 && s.secondsIn <= 240);
        if (midSnaps.length === 0) continue;
        const avgFV = midSnaps.reduce((s, snap) => s + snap.fairValue, 0) / midSnaps.length;
        const fvCall = avgFV > 0.5 ? 'UP' : 'DOWN';
        const correct = fvCall === result.outcome;
        console.log(
            `  ${result.question.slice(0, 50).padEnd(50)} | ` +
            `AvgFV: ${(avgFV * 100).toFixed(1).padStart(5)}% | ` +
            `Call: ${fvCall.padEnd(4)} | ` +
            `Actual: ${result.outcome.padEnd(4)} | ` +
            `${correct ? 'CORRECT' : 'WRONG  '}`
        );
    }

    const fvCorrect = validResults.filter(r => {
        const midSnaps = r.snapshots.filter(s => s.secondsIn >= 30 && s.secondsIn <= 240);
        if (midSnaps.length === 0) return false;
        const avgFV = midSnaps.reduce((s, snap) => s + snap.fairValue, 0) / midSnaps.length;
        return (avgFV > 0.5 ? 'UP' : 'DOWN') === r.outcome;
    }).length;
    console.log(`\n  Accuracy: ${fvCorrect}/${validResults.length} (${((fvCorrect / validResults.length) * 100).toFixed(0)}%)`);

    // ─── Simulated P&L ───
    console.log('\n--- Simulated Maker Strategy P&L ---');
    console.log('Rules: Post limit order at fair value when |edge| > 3%. $100 per trade. 0% maker fee.');
    console.log('Assume fill if market mid crosses our price within the candle.\n');

    let totalPnL = 0;
    let totalTrades = 0;
    let wins = 0;

    for (const result of validResults) {
        const midSnaps = result.snapshots.filter(s => s.secondsIn >= 15 && s.secondsIn <= 270);

        for (const snap of midSnaps) {
            if (Math.abs(snap.edge) < 0.03) continue;

            totalTrades++;
            const buyUp = snap.edge > 0; // Our fair > market → buy Up
            const entryPrice = snap.fairValue; // We post at fair value
            const resolvedUp = result.outcome === 'UP';

            let pnl: number;
            if (buyUp && resolvedUp) {
                pnl = (1 - entryPrice) * 100; // Win: paid entryPrice, get $1
            } else if (buyUp && !resolvedUp) {
                pnl = -entryPrice * 100; // Loss: paid entryPrice, get $0
            } else if (!buyUp && !resolvedUp) {
                pnl = entryPrice * 100; // Win: sold at entryPrice, worth $0
            } else {
                pnl = -(1 - entryPrice) * 100; // Loss: sold at entryPrice, worth $1
            }

            totalPnL += pnl;
            if (pnl > 0) wins++;
        }
    }

    console.log(`  Total trades: ${totalTrades}`);
    console.log(`  Win rate: ${wins}/${totalTrades} (${totalTrades > 0 ? ((wins / totalTrades) * 100).toFixed(1) : 0}%)`);
    console.log(`  Total P&L: $${totalPnL.toFixed(2)}`);
    console.log(`  Avg P&L/trade: $${totalTrades > 0 ? (totalPnL / totalTrades).toFixed(2) : 0}`);
    console.log(`  Per candle: $${validResults.length > 0 ? (totalPnL / validResults.length).toFixed(2) : 0}`);

    // Edge distribution histogram
    console.log('\n--- Edge Distribution (all snapshots) ---');
    const edgeBuckets = [-20, -10, -5, -3, -1, 0, 1, 3, 5, 10, 20];
    for (let i = 0; i < edgeBuckets.length - 1; i++) {
        const lo = edgeBuckets[i] / 100;
        const hi = edgeBuckets[i + 1] / 100;
        const count = allSnaps.filter(s => s.edge >= lo && s.edge < hi).length;
        const pct = (count / allSnaps.length * 100).toFixed(1);
        const bar = '#'.repeat(Math.round(count / allSnaps.length * 100));
        console.log(`  ${edgeBuckets[i].toString().padStart(4)}% to ${edgeBuckets[i + 1].toString().padStart(3)}% | ${count.toString().padStart(4)} (${pct.padStart(5)}%) | ${bar}`);
    }

    disconnectChainlink();
}

main().catch(err => {
    console.error(err);
    disconnectChainlink();
    process.exit(1);
});
