/**
 * Resolution Window Study
 *
 * Investigates the EXACT mechanics around candle close:
 * 1. When does Chainlink deliver the "final" price?
 * 2. Is the order book still live after the 5-min mark?
 * 3. Is there a window to trade at stale prices during resolution?
 * 4. How quickly does the book collapse to 0/1 after candle end?
 *
 * Also studies cross-token dynamics:
 * 5. What is Up_bid + Down_bid over time? (underround = arb opportunity)
 * 6. Does oscillation create windows where both-token bids fill?
 * 7. What is the cross-token spread dynamics during high volatility?
 *
 * Polls every 500ms in the critical final 30 seconds.
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

interface BookSnapshot {
    timestamp: number;
    secondsLeft: number;
    upBestBid: number;
    upBestAsk: number;
    upMid: number;
    downBestBid: number;
    downBestAsk: number;
    downMid: number;
    upBidSize: number;     // Total bid depth on Up
    upAskSize: number;     // Total ask depth on Up
    downBidSize: number;
    downAskSize: number;
    crossBidSum: number;   // upBid + downBid (< 1 = maker arb)
    crossAskSum: number;   // upAsk + downAsk (> 1 = always, taker anti-arb)
    chainlinkPrice: number;
    chainlinkMove: number;
}

async function getFullBook(tokenId: string): Promise<{
    bestBid: number; bestAsk: number; mid: number;
    bidDepth: number; askDepth: number;
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
}> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, mid: 0.5, bidDepth: 0, askDepth: 0, bids: [], asks: [] };

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
    const bidDepth = bids.reduce((s: number, b: any) => s + b.size * b.price, 0);
    const askDepth = asks.reduce((s: number, a: any) => s + a.size * a.price, 0);

    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, bidDepth, askDepth, bids, asks };
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

interface CandleData {
    index: number;
    snapshots: BookSnapshot[];
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openChainlink: number;
    // Resolution timing
    lastTradableSnapshot: number;  // seconds before end where book was still "live"
    firstResolvedSnapshot: number; // seconds after end where book showed 0/1
    resolutionGapMs: number;       // time between CL final and book collapse
}

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<CandleData | null> {
    const market = await findCurrentMarket();
    if (!market) return null;

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    if (!upToken || !downToken) return null;

    const endDate = new Date(market.endDate);
    console.log(`\n  Candle ${candleIndex}: ${market.question}`);
    console.log(`    End: ${endDate.toLocaleTimeString()} | Tokens: Up=${upToken.slice(0,8)}... Down=${downToken.slice(0,8)}...`);

    let openChainlink: number | null = null;
    const snapshots: BookSnapshot[] = [];

    // Phase 1: Normal polling (every 3s) for first 270 seconds
    // Phase 2: Fast polling (every 500ms) for last 30 seconds + 10s after

    const startTime = Date.now();
    let phase = 1;

    while (true) {
        const now = Date.now();
        const secondsLeft = (endDate.getTime() - now) / 1000;

        // Stop 15 seconds after candle end
        if (secondsLeft < -15) break;

        // Switch to fast polling in last 30 seconds
        if (secondsLeft <= 30 && phase === 1) {
            phase = 2;
            console.log(`    >>> Entering fast-poll mode (${secondsLeft.toFixed(1)}s left) <<<`);
        }

        const clPrice = chainlink.getPrice();
        if (!openChainlink && clPrice > 0) {
            openChainlink = clPrice;
            console.log(`    Open CL: $${openChainlink.toFixed(2)}`);
        }

        try {
            const [upBook, downBook] = await Promise.all([
                getFullBook(upToken),
                getFullBook(downToken),
            ]);

            const snap: BookSnapshot = {
                timestamp: now,
                secondsLeft,
                upBestBid: upBook.bestBid,
                upBestAsk: upBook.bestAsk,
                upMid: upBook.mid,
                downBestBid: downBook.bestBid,
                downBestAsk: downBook.bestAsk,
                downMid: downBook.mid,
                upBidSize: upBook.bidDepth,
                upAskSize: upBook.askDepth,
                downBidSize: downBook.bidDepth,
                downAskSize: downBook.askDepth,
                crossBidSum: upBook.bestBid + downBook.bestBid,
                crossAskSum: upBook.bestAsk + downBook.bestAsk,
                chainlinkPrice: clPrice,
                chainlinkMove: openChainlink ? clPrice - openChainlink : 0,
            };

            snapshots.push(snap);

            // Log in fast mode or every 30s in normal mode
            const shouldLog = phase === 2 || snapshots.length % 10 === 0;
            if (shouldLog) {
                const move = snap.chainlinkMove;
                console.log(
                    `    ${secondsLeft.toFixed(1).padStart(6)}s | ` +
                    `CL: ${move >= 0 ? '+' : ''}$${move.toFixed(1).padStart(6)} | ` +
                    `Up: ${snap.upBestBid.toFixed(3)}/${snap.upBestAsk.toFixed(3)} | ` +
                    `Dn: ${snap.downBestBid.toFixed(3)}/${snap.downBestAsk.toFixed(3)} | ` +
                    `BidSum: ${snap.crossBidSum.toFixed(3)} | ` +
                    `Depth: $${(snap.upBidSize + snap.downBidSize).toFixed(0)}`
                );
            }
        } catch (e) {
            // Network hiccup, continue
        }

        const interval = phase === 2 ? 500 : 3000;
        await new Promise(r => setTimeout(r, interval));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 5000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';

    if (outcome === 'UNKNOWN' && openChainlink && chainlink.getPrice() > 0) {
        outcome = chainlink.getPrice() >= openChainlink ? 'UP' : 'DOWN';
    }

    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Analyze resolution timing
    let lastTradable = 0;
    let firstResolved = 999;

    for (const s of snapshots) {
        const isLive = s.upBestBid > 0.02 && s.upBestAsk < 0.98 && s.upMid > 0.05 && s.upMid < 0.95;
        if (isLive && s.secondsLeft > lastTradable) {
            // This is before the earliest "resolved" state
        }
        if (isLive) {
            lastTradable = Math.max(lastTradable, -s.secondsLeft); // positive = after end
            if (s.secondsLeft < 0) {
                // Book is still live AFTER candle end!
            }
        }
        if (!isLive && s.secondsLeft < 0) {
            firstResolved = Math.min(firstResolved, -s.secondsLeft);
        }
    }

    // Find last live snapshot and first resolved snapshot more carefully
    const postEndSnapshots = snapshots.filter(s => s.secondsLeft <= 0);
    const lastLiveAfterEnd = postEndSnapshots
        .filter(s => s.upMid > 0.05 && s.upMid < 0.95)
        .sort((a, b) => a.secondsLeft - b.secondsLeft)[0]; // most negative secondsLeft = latest after end

    const firstDeadAfterEnd = postEndSnapshots
        .filter(s => s.upMid <= 0.05 || s.upMid >= 0.95)
        .sort((a, b) => b.secondsLeft - a.secondsLeft)[0]; // least negative = earliest after end

    console.log(`    >>> Resolved: ${outcome} | Vol: $${volume.toFixed(0)}`);
    if (lastLiveAfterEnd) {
        console.log(`    >>> Book still LIVE ${(-lastLiveAfterEnd.secondsLeft).toFixed(1)}s after candle end! Mid: ${lastLiveAfterEnd.upMid.toFixed(3)}`);
    }
    if (firstDeadAfterEnd) {
        console.log(`    >>> Book collapsed ${(-firstDeadAfterEnd.secondsLeft).toFixed(1)}s after candle end. Mid: ${firstDeadAfterEnd.upMid.toFixed(3)}`);
    }

    return {
        index: candleIndex,
        snapshots,
        outcome,
        volume,
        openChainlink: openChainlink || 0,
        lastTradableSnapshot: lastLiveAfterEnd ? -lastLiveAfterEnd.secondsLeft : 0,
        firstResolvedSnapshot: firstDeadAfterEnd ? -firstDeadAfterEnd.secondsLeft : 999,
        resolutionGapMs: (lastLiveAfterEnd && firstDeadAfterEnd) ?
            (lastLiveAfterEnd.timestamp - firstDeadAfterEnd.timestamp) : 0,
    };
}

function analyzeResults(results: CandleData[]) {
    console.log('\n' + '='.repeat(80));
    console.log('RESOLUTION WINDOW ANALYSIS');
    console.log('='.repeat(80));

    // 1. Resolution timing
    console.log('\n--- Resolution Timing ---');
    for (const r of results) {
        console.log(
            `  Candle ${r.index}: ` +
            `Last live: ${r.lastTradableSnapshot.toFixed(1)}s after end | ` +
            `First resolved: ${r.firstResolvedSnapshot.toFixed(1)}s after end | ` +
            `Outcome: ${r.outcome} | Vol: $${r.volume.toFixed(0)}`
        );
    }

    const avgLastLive = results.reduce((s, r) => s + r.lastTradableSnapshot, 0) / results.length;
    const avgFirstResolved = results.reduce((s, r) => s + r.firstResolvedSnapshot, 0) / results.length;
    console.log(`\n  Avg last live: ${avgLastLive.toFixed(1)}s after end`);
    console.log(`  Avg first resolved: ${avgFirstResolved.toFixed(1)}s after end`);

    // 2. Cross-token bid sum analysis
    console.log('\n' + '='.repeat(80));
    console.log('CROSS-TOKEN ANALYSIS');
    console.log('='.repeat(80));

    const allSnaps = results.flatMap(r => r.snapshots.filter(s => s.secondsLeft > 2));

    console.log(`\nTotal snapshots: ${allSnaps.length}`);

    const bidSums = allSnaps.map(s => s.crossBidSum);
    const askSums = allSnaps.map(s => s.crossAskSum);

    console.log(`\n--- Cross-Token Bid Sum (Up_bid + Down_bid) ---`);
    console.log(`  Mean: ${(bidSums.reduce((a, b) => a + b, 0) / bidSums.length).toFixed(4)}`);
    console.log(`  Min:  ${Math.min(...bidSums).toFixed(4)}`);
    console.log(`  Max:  ${Math.max(...bidSums).toFixed(4)}`);

    const underOne = bidSums.filter(s => s < 1.0).length;
    const underNinetyFive = bidSums.filter(s => s < 0.95).length;
    console.log(`  < $1.00: ${underOne}/${bidSums.length} (${((underOne / bidSums.length) * 100).toFixed(0)}%)`);
    console.log(`  < $0.95: ${underNinetyFive}/${bidSums.length} (${((underNinetyFive / bidSums.length) * 100).toFixed(0)}%)`);

    console.log(`\n--- Cross-Token Ask Sum (Up_ask + Down_ask) ---`);
    console.log(`  Mean: ${(askSums.reduce((a, b) => a + b, 0) / askSums.length).toFixed(4)}`);
    console.log(`  Min:  ${Math.min(...askSums).toFixed(4)}`);
    console.log(`  Max:  ${Math.max(...askSums).toFixed(4)}`);

    // 3. Underround by time bucket
    console.log('\n--- Cross Bid Sum by Time in Candle ---');
    const timeBuckets = [
        { min: 0, max: 60, label: '0-60s' },
        { min: 60, max: 120, label: '60-120s' },
        { min: 120, max: 180, label: '120-180s' },
        { min: 180, max: 240, label: '180-240s' },
        { min: 240, max: 270, label: '240-270s' },
        { min: 270, max: 300, label: '270-300s' },
    ];

    for (const bucket of timeBuckets) {
        const inBucket = allSnaps.filter(s => {
            const secondsIn = 300 - s.secondsLeft;
            return secondsIn >= bucket.min && secondsIn < bucket.max;
        });
        if (inBucket.length === 0) continue;

        const avgBidSum = inBucket.reduce((s, snap) => s + snap.crossBidSum, 0) / inBucket.length;
        const minBidSum = Math.min(...inBucket.map(s => s.crossBidSum));
        const avgSpread = inBucket.reduce((s, snap) => s + (snap.upBestAsk - snap.upBestBid), 0) / inBucket.length;

        console.log(
            `  ${bucket.label.padEnd(10)} | ` +
            `Avg bid sum: ${avgBidSum.toFixed(4)} | ` +
            `Min: ${minBidSum.toFixed(4)} | ` +
            `Avg spread: ${(avgSpread * 100).toFixed(1)}c | ` +
            `n=${inBucket.length}`
        );
    }

    // 4. Simulate cross-token maker strategy
    console.log('\n' + '='.repeat(80));
    console.log('CROSS-TOKEN MAKER STRATEGY SIMULATION');
    console.log('='.repeat(80));

    // Strategy: Place bid on BOTH Up and Down tokens at their respective best bids.
    // If both fill, profit = 1 - (upBid + downBid) per share regardless of outcome.
    // Track whether oscillation allows both to fill within a candle.

    for (const r of results) {
        const liveSnaps = r.snapshots.filter(s => s.secondsLeft > 5 && s.upMid > 0.05 && s.upMid < 0.95);
        if (liveSnaps.length === 0) continue;

        // Track the range of Up midpoints
        const upMids = liveSnaps.map(s => s.upMid);
        const upHigh = Math.max(...upMids);
        const upLow = Math.min(...upMids);
        const upRange = upHigh - upLow;

        // For cross-token: Up bid fills when Up price drops (BTC down), Down bid fills when Down price drops (BTC up)
        // Both fill when BTC oscillates enough
        const firstSnap = liveSnaps[0];
        const upBidEntry = firstSnap.upBestBid;
        const downBidEntry = firstSnap.downBestBid;
        const totalCost = upBidEntry + downBidEntry;

        // Check if both would fill during the candle
        const upBidFills = liveSnaps.some(s => s.upMid <= upBidEntry + 0.005); // small tolerance
        const downBidFills = liveSnaps.some(s => s.downMid <= downBidEntry + 0.005);

        const bothFill = upBidFills && downBidFills;
        const profit = bothFill ? (1 - totalCost) * 100 : 0;

        // If only one fills, what's the damage?
        let singleFillPnL = 0;
        if (upBidFills && !downBidFills) {
            singleFillPnL = r.outcome === 'UP' ? (1 - upBidEntry) * 100 : -upBidEntry * 100;
        } else if (downBidFills && !upBidFills) {
            singleFillPnL = r.outcome === 'DOWN' ? (1 - downBidEntry) * 100 : -downBidEntry * 100;
        }

        console.log(
            `  Candle ${r.index}: ` +
            `Up range: ${(upLow * 100).toFixed(0)}-${(upHigh * 100).toFixed(0)}c (${(upRange * 100).toFixed(0)}c) | ` +
            `Entry: Up@${upBidEntry.toFixed(2)} + Dn@${downBidEntry.toFixed(2)} = $${totalCost.toFixed(3)} | ` +
            `${bothFill ? 'BOTH FILL' : upBidFills ? 'Up bid only' : downBidFills ? 'Dn bid only' : 'NONE'} | ` +
            `P&L: $${(bothFill ? profit : singleFillPnL).toFixed(1)} | ${r.outcome}`
        );
    }

    // 5. What if we post bids LOWER than best bid (deeper in the book)?
    console.log('\n--- Deeper Bid Strategy (bid at best_bid - Xc) ---');
    const offsets = [0, 0.01, 0.02, 0.03, 0.05];

    for (const offset of offsets) {
        let totalPnL = 0;
        let bothCount = 0;
        let upOnly = 0;
        let downOnly = 0;
        let neither = 0;

        for (const r of results) {
            const liveSnaps = r.snapshots.filter(s => s.secondsLeft > 5 && s.upMid > 0.05 && s.upMid < 0.95);
            if (liveSnaps.length === 0) continue;

            const firstSnap = liveSnaps[0];
            const upBid = firstSnap.upBestBid - offset;
            const downBid = firstSnap.downBestBid - offset;

            if (upBid <= 0.01 || downBid <= 0.01) continue;

            const upFills = liveSnaps.some(s => s.upBestBid <= upBid + 0.002);
            const downFills = liveSnaps.some(s => s.downBestBid <= downBid + 0.002);

            if (upFills && downFills) {
                bothCount++;
                totalPnL += (1 - upBid - downBid) * 100;
            } else if (upFills) {
                upOnly++;
                totalPnL += r.outcome === 'UP' ? (1 - upBid) * 100 : -upBid * 100;
            } else if (downFills) {
                downOnly++;
                totalPnL += r.outcome === 'DOWN' ? (1 - downBid) * 100 : -downBid * 100;
            } else {
                neither++;
            }
        }

        const total = bothCount + upOnly + downOnly + neither;
        console.log(
            `  Offset ${(offset * 100).toFixed(0)}c: ` +
            `Both: ${bothCount}/${total} | ` +
            `Up only: ${upOnly} | Dn only: ${downOnly} | None: ${neither} | ` +
            `P&L: $${totalPnL.toFixed(1)}`
        );
    }

    // 6. Key insight
    console.log('\n--- Key Insights ---');
    const avgBidSum = bidSums.reduce((a, b) => a + b, 0) / bidSums.length;
    console.log(`Cross-token bid sum averages $${avgBidSum.toFixed(4)} — ${avgBidSum < 1 ? 'UNDER $1 (maker arb exists)' : 'AT/ABOVE $1 (no arb)'}`);

    const liveAfterEnd = results.filter(r => r.lastTradableSnapshot > 0);
    if (liveAfterEnd.length > 0) {
        console.log(`Book was live AFTER candle end in ${liveAfterEnd.length}/${results.length} candles — EXPLOITABLE WINDOW!`);
    } else {
        console.log('Book collapses at or before candle end — no resolution window exploit.');
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '6');
    console.log(`=== Resolution Window + Cross-Token Study: ${NUM_CANDLES} candles ===\n`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const results: CandleData[] = [];

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

        const result = await monitorCandle(i + 1, chainlink);
        if (result) results.push(result);
    }

    chainlink.disconnect();

    if (results.length > 0) {
        analyzeResults(results);
    }
}

main().catch(console.error);
