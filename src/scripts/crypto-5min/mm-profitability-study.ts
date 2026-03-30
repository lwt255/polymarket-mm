/**
 * MM Profitability Study
 *
 * The incumbent MM runs 1c spreads and deploys $100K+ per candle.
 * They clearly make money. HOW?
 *
 * This study observes:
 * 1. How often does the midpoint cross the MM's bid/ask levels?
 *    (Each cross = a fill for the MM, adverse selection risk)
 * 2. What's the MM's implied P&L if they maintain constant quotes?
 * 3. Does the MM adjust quotes dynamically? How fast?
 * 4. What's the fill rate at different price levels?
 * 5. Does the MM pull quotes before resolution?
 *
 * Also tests the hypothesis: "It's about capturing the TAKER FEE rebate"
 * Polymarket gives 100% maker rebate. But what if there's a VOLUME bonus
 * or the rebate is calculated on a higher base than we think?
 *
 * Monitors book changes at high frequency to detect MM behavior patterns.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

interface BookState {
    timestamp: number;
    secondsLeft: number;
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
    bestBid: number;
    bestAsk: number;
    spread: number;
    bidDepthUSD: number;
    askDepthUSD: number;
    totalDepthUSD: number;
}

async function getBookState(tokenId: string, endTime: number): Promise<BookState> {
    const now = Date.now();
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return {
        timestamp: now, secondsLeft: (endTime - now) / 1000,
        bids: [], asks: [], bestBid: 0, bestAsk: 1, spread: 1,
        bidDepthUSD: 0, askDepthUSD: 0, totalDepthUSD: 0
    };

    const bids = (raw.bids || []).map((b: any) => ({
        price: parseFloat(b.price),
        size: parseFloat(b.size)
    })).sort((a: any, b: any) => b.price - a.price);

    const asks = (raw.asks || []).map((a: any) => ({
        price: parseFloat(a.price),
        size: parseFloat(a.size)
    })).sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const bidDepthUSD = bids.reduce((s: number, b: any) => s + b.size * b.price, 0);
    const askDepthUSD = asks.reduce((s: number, a: any) => s + a.size * a.price, 0);

    return {
        timestamp: now,
        secondsLeft: (endTime - now) / 1000,
        bids, asks, bestBid, bestAsk,
        spread: bestAsk - bestBid,
        bidDepthUSD, askDepthUSD,
        totalDepthUSD: bidDepthUSD + askDepthUSD,
    };
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0) {
            const m = data[0];
            if (new Date(m.endDate).getTime() > Date.now()) return m;
        }
    }
    return null;
}

interface CandleAnalysis {
    index: number;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    states: BookState[];
    // MM behavior
    spreadChanges: number;      // How many times did the spread change?
    quoteAdjustments: number;   // How many times did best bid/ask move?
    avgSpread: number;
    minSpread: number;
    maxSpread: number;
    // Fill estimation
    bidCrosses: number;         // Times midpoint crossed below previous best bid
    askCrosses: number;         // Times midpoint crossed above previous best ask
    estimatedMMFills: number;
    // Depth behavior
    avgDepth: number;
    depthAtEnd: number;         // Did MM pull quotes before resolution?
    depthDropTime: number;      // When did depth start dropping (seconds left)
}

async function monitorCandle(candleIndex: number): Promise<CandleAnalysis | null> {
    const market = await findCurrentMarket();
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    const endTime = endDate.getTime();
    console.log(`\n  Candle ${candleIndex}: ${market.question}`);

    const states: BookState[] = [];
    const POLL_INTERVAL = 1000; // 1 second for detecting changes

    while (true) {
        const secondsLeft = (endTime - Date.now()) / 1000;
        if (secondsLeft < -5) break;

        const state = await getBookState(upToken, endTime);
        states.push(state);

        // Log every 30 seconds + final 10 seconds
        if (states.length % 30 === 1 || secondsLeft < 10) {
            const top3Bids = state.bids.slice(0, 3).map(b => `${b.price.toFixed(3)}x${b.size.toFixed(0)}`).join(' ');
            const top3Asks = state.asks.slice(0, 3).map(a => `${a.price.toFixed(3)}x${a.size.toFixed(0)}`).join(' ');
            console.log(
                `    ${secondsLeft.toFixed(0).padStart(4)}s | ` +
                `Spread: ${(state.spread * 100).toFixed(1)}c | ` +
                `Depth: $${state.totalDepthUSD.toFixed(0)} | ` +
                `Bids: [${top3Bids}] | Asks: [${top3Asks}]`
            );
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 6000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    if (outcome === 'UNKNOWN' && states.length > 0) {
        const lastMid = (states[states.length - 1].bestBid + states[states.length - 1].bestAsk) / 2;
        outcome = lastMid > 0.5 ? 'UP' : 'DOWN';
    }

    console.log(`    >>> Resolved: ${outcome} | Vol: $${volume.toFixed(0)}`);

    // Analyze MM behavior
    let spreadChanges = 0;
    let quoteAdjustments = 0;
    let bidCrosses = 0;
    let askCrosses = 0;

    for (let i = 1; i < states.length; i++) {
        const prev = states[i - 1];
        const curr = states[i];

        if (Math.abs(curr.spread - prev.spread) > 0.0005) spreadChanges++;
        if (Math.abs(curr.bestBid - prev.bestBid) > 0.0005 || Math.abs(curr.bestAsk - prev.bestAsk) > 0.0005) {
            quoteAdjustments++;
        }

        // Detect fills: if bid moved down or ask moved up, someone traded through
        const prevMid = (prev.bestBid + prev.bestAsk) / 2;
        const currMid = (curr.bestBid + curr.bestAsk) / 2;
        if (currMid < prev.bestBid) bidCrosses++;
        if (currMid > prev.bestAsk) askCrosses++;
    }

    const liveStates = states.filter(s => s.secondsLeft > 5 && s.totalDepthUSD > 100);
    const avgSpread = liveStates.reduce((s, st) => s + st.spread, 0) / (liveStates.length || 1);
    const avgDepth = liveStates.reduce((s, st) => s + st.totalDepthUSD, 0) / (liveStates.length || 1);

    // When does depth start dropping?
    let depthDropTime = 0;
    const peakDepth = Math.max(...liveStates.map(s => s.totalDepthUSD));
    for (const s of [...liveStates].reverse()) {
        if (s.totalDepthUSD < peakDepth * 0.5) {
            depthDropTime = s.secondsLeft;
            break;
        }
    }

    const depthAtEnd = states.filter(s => s.secondsLeft > 0 && s.secondsLeft < 3)[0]?.totalDepthUSD || 0;

    return {
        index: candleIndex,
        outcome,
        volume,
        states,
        spreadChanges,
        quoteAdjustments,
        avgSpread,
        minSpread: Math.min(...liveStates.map(s => s.spread)),
        maxSpread: Math.max(...liveStates.map(s => s.spread)),
        bidCrosses,
        askCrosses,
        estimatedMMFills: bidCrosses + askCrosses,
        avgDepth,
        depthAtEnd,
        depthDropTime,
    };
}

function analyzeResults(results: CandleAnalysis[]) {
    console.log('\n' + '='.repeat(80));
    console.log('MM BEHAVIOR ANALYSIS');
    console.log('='.repeat(80));

    for (const r of results) {
        console.log(
            `\n  Candle ${r.index} (${r.outcome}, $${r.volume.toFixed(0)}):` +
            `\n    Spread: avg ${(r.avgSpread * 100).toFixed(1)}c, min ${(r.minSpread * 100).toFixed(1)}c, max ${(r.maxSpread * 100).toFixed(1)}c` +
            `\n    Quote adjustments: ${r.quoteAdjustments} (${(r.quoteAdjustments / Math.max(1, r.states.length) * 100).toFixed(0)}% of polls)` +
            `\n    Spread changes: ${r.spreadChanges}` +
            `\n    Estimated MM fills: ${r.estimatedMMFills} (${r.bidCrosses} bid, ${r.askCrosses} ask)` +
            `\n    Avg depth: $${r.avgDepth.toFixed(0)} | At end: $${r.depthAtEnd.toFixed(0)} | Drop at: ${r.depthDropTime.toFixed(0)}s left`
        );
    }

    // Aggregate stats
    console.log('\n--- Aggregate ---');
    const totalAdj = results.reduce((s, r) => s + r.quoteAdjustments, 0);
    const totalPolls = results.reduce((s, r) => s + r.states.length, 0);
    const totalFills = results.reduce((s, r) => s + r.estimatedMMFills, 0);
    const totalBidCrosses = results.reduce((s, r) => s + r.bidCrosses, 0);
    const totalAskCrosses = results.reduce((s, r) => s + r.askCrosses, 0);

    console.log(`  Quote adjustment rate: ${totalAdj}/${totalPolls} polls (${(totalAdj / totalPolls * 100).toFixed(0)}%)`);
    console.log(`  Estimated fills/candle: ${(totalFills / results.length).toFixed(1)} (${(totalBidCrosses / results.length).toFixed(1)} bid + ${(totalAskCrosses / results.length).toFixed(1)} ask)`);

    // Simulate MM P&L with constant 1c spread
    console.log('\n--- Simulated MM P&L (1c spread, constant quotes) ---');

    let mmPnL = 0;
    let mmTrades = 0;
    let mmWins = 0;

    for (const r of results) {
        const liveStates = r.states.filter(s => s.secondsLeft > 5);
        if (liveStates.length < 2) continue;

        for (let i = 1; i < liveStates.length; i++) {
            const prev = liveStates[i - 1];
            const curr = liveStates[i];

            const prevMid = (prev.bestBid + prev.bestAsk) / 2;
            const currMid = (curr.bestBid + curr.bestAsk) / 2;

            // MM has bid at prevBid and ask at prevAsk
            // If current mid drops below prev bid → bid filled → MM bought
            if (currMid < prev.bestBid) {
                mmTrades++;
                // MM bought at prev.bestBid, resolves at 1 (UP) or 0 (DOWN)
                if (r.outcome === 'UP') {
                    mmPnL += (1 - prev.bestBid) * 100;
                    mmWins++;
                } else {
                    mmPnL -= prev.bestBid * 100;
                }
            }
            // If current mid rises above prev ask → ask filled → MM sold
            if (currMid > prev.bestAsk) {
                mmTrades++;
                // MM sold at prev.bestAsk, resolves at 1 (UP) or 0 (DOWN)
                if (r.outcome === 'DOWN') {
                    mmPnL += prev.bestAsk * 100;
                    mmWins++;
                } else {
                    mmPnL -= (1 - prev.bestAsk) * 100;
                }
            }
        }
    }

    console.log(`  Trades: ${mmTrades} | Wins: ${mmWins}/${mmTrades} (${mmTrades > 0 ? ((mmWins / mmTrades) * 100).toFixed(0) : 0}%)`);
    console.log(`  P&L: $${mmPnL.toFixed(2)} | Per candle: $${(mmPnL / results.length).toFixed(2)}`);

    // What if MM hedges on Coinbase? (delta-neutral)
    console.log('\n--- What if MM hedges BTC exposure on CEX? ---');
    console.log('  If the MM buys Up token, they short BTC proportionally on Coinbase.');
    console.log('  This converts directional risk into pure spread capture.');
    console.log('  Cost: ~0.05% taker fee on Coinbase per hedge.');
    console.log('  With 1c spread on $100K volume = $1,000 gross spread revenue.');
    console.log('  Hedging cost: ~$50 per candle on Coinbase.');
    console.log('  Net: ~$950/candle if fully hedged. But this assumes 100% fill rate...');

    // Volume-based analysis
    console.log('\n--- Volume vs Spread Revenue ---');
    for (const r of results) {
        const spreadRevenue = r.volume * r.avgSpread; // Rough: volume * avg spread
        const hedgeCost = r.volume * 0.001; // ~0.1% round-trip on CEX
        console.log(
            `  Candle ${r.index}: Vol $${r.volume.toFixed(0)} * spread ${(r.avgSpread * 100).toFixed(1)}c ` +
            `= ~$${spreadRevenue.toFixed(0)} gross | ` +
            `Hedge cost: ~$${hedgeCost.toFixed(0)} | ` +
            `Net: ~$${(spreadRevenue - hedgeCost).toFixed(0)}`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '6');
    console.log(`=== MM Profitability Study: ${NUM_CANDLES} candles ===\n`);

    const results: CandleAnalysis[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(i + 1);
        if (result) results.push(result);
    }

    if (results.length > 0) {
        analyzeResults(results);
    }
}

main().catch(console.error);
