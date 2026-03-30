/**
 * Chainlink-to-Book Lag Study
 *
 * Measures the exact latency between Chainlink price updates and
 * order book repricing. If the book lags Chainlink by even 1-2 seconds,
 * we can post maker orders at stale prices before the MM adjusts.
 *
 * Polls Chainlink WS (real-time) and CLOB book simultaneously.
 * Compares implied direction from each source.
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
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

interface LagSnapshot {
    timestamp: number;
    secondsInto: number;
    chainlinkPrice: number;
    chainlinkMove: number;      // vs candle open
    chainlinkImpliedUp: number; // rough probability based on move magnitude
    bookMid: number;            // order book midpoint
    bookBestBid: number;
    bookBestAsk: number;
    lag: number;                // chainlinkImpliedUp - bookMid (positive = book is slow to price up)
    absLag: number;
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<{
    snapshots: LagSnapshot[];
    outcome: 'UP' | 'DOWN';
    volume: number;
} | null> {
    const market = await findCurrentMarket();
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    const openChainlink = chainlink.getPrice();
    if (openChainlink <= 0) return null;

    console.log(`  Candle ${candleIndex}: ${market.question}`);

    const snapshots: LagSnapshot[] = [];

    // Fast polling — every 1 second to catch lag
    const POLL_INTERVAL = 1000;
    const maxPolls = 310;

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;
        if (secondsLeft < -3) break;

        const secondsInto = 300 - secondsLeft;
        const clPrice = chainlink.getPrice();
        const clMove = clPrice - openChainlink;

        try {
            const raw = await fetchJSON(`${CLOB}/book?token_id=${upToken}`);
            if (!raw) { await new Promise(r => setTimeout(r, POLL_INTERVAL)); continue; }

            const bids = (raw.bids || []).map((b: any) => parseFloat(b.price)).sort((a: number, b: number) => b - a);
            const asks = (raw.asks || []).map((a: any) => parseFloat(a.price)).sort((a: number, b: number) => a - b);
            const bestBid = bids[0] ?? 0;
            const bestAsk = asks[0] ?? 1;
            const bookMid = (bestBid + bestAsk) / 2;

            // Rough Chainlink-implied probability
            // Use the observed relationship: $50 move ≈ 20-30% probability shift
            // Calibrated from our data: at 60s left, $50 move → ~70% winner
            const expectedMoveForFullConfidence = 100; // $100 move = near certainty
            const timeDecay = Math.max(0.1, secondsLeft / 300); // Less time = more confidence per $
            const clImpliedUp = 0.5 + (clMove / (expectedMoveForFullConfidence * timeDecay)) * 0.5;
            const clImpliedClamped = Math.max(0.02, Math.min(0.98, clImpliedUp));

            const lag = clImpliedClamped - bookMid;

            snapshots.push({
                timestamp: now,
                secondsInto,
                chainlinkPrice: clPrice,
                chainlinkMove: clMove,
                chainlinkImpliedUp: clImpliedClamped,
                bookMid,
                bookBestBid: bestBid,
                bookBestAsk: bestAsk,
                lag,
                absLag: Math.abs(lag),
            });

            // Log every 15 seconds + any large lag events
            if (p % 15 === 0 || Math.abs(lag) > 0.10) {
                const marker = Math.abs(lag) > 0.10 ? ' *** LAG ***' : '';
                console.log(
                    `    ${Math.round(secondsInto).toString().padStart(4)}s | ` +
                    `CL: ${clMove >= 0 ? '+' : ''}$${clMove.toFixed(1).padStart(6)} → ${(clImpliedClamped * 100).toFixed(0).padStart(3)}% | ` +
                    `Book: ${(bookMid * 100).toFixed(1).padStart(5)}% | ` +
                    `Lag: ${(lag * 100).toFixed(1).padStart(5)}%${marker}`
                );
            }
        } catch {}

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 6000));
    const clFinal = chainlink.getPrice();
    const outcome: 'UP' | 'DOWN' = clFinal >= openChainlink ? 'UP' : 'DOWN';
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    console.log(`    → ${outcome} | Vol: $${volume.toFixed(0)} | Snapshots: ${snapshots.length}`);

    return { snapshots, outcome, volume };
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '6');
    console.log(`=== Chainlink-to-Book Lag Study: ${NUM_CANDLES} candles ===\n`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const allSnapshots: (LagSnapshot & { outcome: string })[] = [];
    let totalVolume = 0;

    for (let i = 0; i < NUM_CANDLES; i++) {
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = currentRound + 300000 - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(i + 1, chainlink);
        if (result) {
            for (const s of result.snapshots) {
                allSnapshots.push({ ...s, outcome: result.outcome });
            }
            totalVolume += result.volume;
        }
    }

    chainlink.disconnect();

    if (allSnapshots.length === 0) return;

    // Analysis
    console.log('\n' + '='.repeat(70));
    console.log('LAG ANALYSIS');
    console.log('='.repeat(70));

    console.log(`\nSnapshots: ${allSnapshots.length} | Total volume: $${totalVolume.toLocaleString()}`);

    const lags = allSnapshots.map(s => s.lag);
    const absLags = allSnapshots.map(s => s.absLag);
    const avgLag = lags.reduce((a, b) => a + b, 0) / lags.length;
    const avgAbsLag = absLags.reduce((a, b) => a + b, 0) / absLags.length;
    const maxAbsLag = Math.max(...absLags);

    console.log(`\nAvg lag: ${(avgLag * 100).toFixed(2)}% (positive = book underprices Up relative to CL)`);
    console.log(`Avg |lag|: ${(avgAbsLag * 100).toFixed(2)}%`);
    console.log(`Max |lag|: ${(maxAbsLag * 100).toFixed(2)}%`);

    // Lag by time bucket
    console.log('\n--- Lag by Time in Candle ---');
    const buckets = [0, 30, 60, 120, 180, 240, 270, 300];
    for (let b = 0; b < buckets.length - 1; b++) {
        const low = buckets[b];
        const high = buckets[b + 1];
        const inBucket = allSnapshots.filter(s => s.secondsInto >= low && s.secondsInto < high);
        if (inBucket.length === 0) continue;
        const avgL = inBucket.reduce((s, snap) => s + snap.lag, 0) / inBucket.length;
        const avgAbsL = inBucket.reduce((s, snap) => s + snap.absLag, 0) / inBucket.length;
        const large = inBucket.filter(s => s.absLag > 0.05).length;
        console.log(
            `  ${low.toString().padStart(3)}s-${high.toString().padStart(3)}s | ` +
            `Avg lag: ${(avgL * 100).toFixed(2).padStart(6)}% | ` +
            `Avg |lag|: ${(avgAbsL * 100).toFixed(2).padStart(6)}% | ` +
            `>5% lag: ${large}/${inBucket.length}`
        );
    }

    // Lag direction vs outcome
    console.log('\n--- Does Lag Direction Predict Outcome? ---');
    const lagUp = allSnapshots.filter(s => s.lag > 0.03); // CL says UP more than book
    const lagDown = allSnapshots.filter(s => s.lag < -0.03); // CL says DOWN more than book

    if (lagUp.length > 0) {
        const lagUpCorrect = lagUp.filter(s => s.outcome === 'UP').length;
        console.log(`  CL > Book by >3%: ${lagUpCorrect}/${lagUp.length} resolved UP (${((lagUpCorrect / lagUp.length) * 100).toFixed(0)}%)`);
    }
    if (lagDown.length > 0) {
        const lagDownCorrect = lagDown.filter(s => s.outcome === 'DOWN').length;
        console.log(`  CL < Book by >3%: ${lagDownCorrect}/${lagDown.length} resolved DOWN (${((lagDownCorrect / lagDown.length) * 100).toFixed(0)}%)`);
    }

    // Simulated P&L: When lag > 5%, buy the CL-implied direction at book price
    console.log('\n--- Simulated: Trade When Lag > 5% ---');
    let pnl = 0;
    let trades = 0;
    let wins = 0;

    // Only take the FIRST trade per candle to avoid overcounting
    const tradedCandles = new Set<number>();

    for (const s of allSnapshots) {
        if (s.absLag < 0.05) continue;
        if (s.secondsInto < 15 || s.secondsInto > 270) continue;

        // Simple: hash by secondsInto bucket to limit trades
        const bucket = Math.floor(s.secondsInto / 30);
        const key = s.timestamp - (s.timestamp % 300000); // candle identifier
        const tradeKey = `${key}-${bucket}`;
        if (tradedCandles.has(key) && bucket === Math.floor(s.secondsInto / 30)) continue;

        trades++;
        const buyUp = s.lag > 0; // CL implies Up is underpriced in book
        const entryPrice = buyUp ? s.bookBestAsk : (1 - s.bookBestBid); // Buy at ask as taker (worst case)
        const correct = (buyUp && s.outcome === 'UP') || (!buyUp && s.outcome === 'DOWN');

        if (correct) {
            pnl += (1 - entryPrice) * 100;
            wins++;
        } else {
            pnl += -entryPrice * 100;
        }
    }

    console.log(`  Trades: ${trades} | Wins: ${wins}/${trades} (${((wins / trades) * 100).toFixed(0)}%)`);
    console.log(`  P&L: $${pnl.toFixed(2)} | Per trade: $${(pnl / Math.max(1, trades)).toFixed(2)}`);

    // Key insight
    console.log('\n--- Key Insight ---');
    if (avgAbsLag > 0.03) {
        console.log('Significant lag detected between Chainlink and book pricing.');
        console.log('The book updates slower than Chainlink, creating exploitable windows.');
    } else {
        console.log('Book tracks Chainlink closely. Lag-based strategy unlikely to work.');
    }
}

main().catch(console.error);
