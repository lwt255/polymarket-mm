/**
 * Candle Transition Study
 *
 * Focus on the TRANSITION between candles:
 * - Old candle resolves at 0/100 or 100/0
 * - New candle opens at ~50/50
 * - How fast does the new candle's book form?
 * - What's the spread at the open?
 * - Can we get fills at 50/50 when outcome is still unknown?
 *
 * Also: Track the "early direction" signal.
 * - If BTC moved +$100 in the last candle, does it continue or reverse?
 * - Does the new candle's first tick predict the final outcome?
 *
 * Key question: Is there a pattern where we can enter early at 50/50
 * with a directional bias that gives us >50% win rate?
 */

import { ChainlinkFeed } from './chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

async function findMarketForTimestamp(targetTs: number): Promise<any> {
    const rounded = Math.floor(targetTs / 300) * 300;
    for (const ts of [rounded, rounded + 300, rounded - 300]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0) return data[0];
    }
    return null;
}

async function getBook(tokenId: string) {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, mid: 0.5, spread: 1, bidDepth: 0, askDepth: 0 };
    const bids = (raw.bids || []).map((b: any) => ({ p: parseFloat(b.price), s: parseFloat(b.size) })).sort((a: any, b: any) => b.p - a.p);
    const asks = (raw.asks || []).map((a: any) => ({ p: parseFloat(a.price), s: parseFloat(a.size) })).sort((a: any, b: any) => a.p - b.p);
    const bestBid = bids[0]?.p ?? 0;
    const bestAsk = asks[0]?.p ?? 1;
    const bidDepth = bids.reduce((sum: number, b: any) => sum + b.s, 0);
    const askDepth = asks.reduce((sum: number, a: any) => sum + a.s, 0);
    return { bestBid, bestAsk, mid: (bestBid + bestAsk) / 2, spread: bestAsk - bestBid, bidDepth, askDepth };
}

interface TransitionData {
    prevOutcome: 'UP' | 'DOWN' | 'UNKNOWN';
    prevChainlinkMove: number;  // How much BTC moved in previous candle
    newCandleIndex: number;
    firstMid: number;           // First observed midpoint of new candle
    first10sMid: number;        // Avg mid in first 10 seconds
    first30sMid: number;        // Avg mid in first 30 seconds
    midAt60s: number;
    midAt120s: number;
    midAt180s: number;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    chainlinkAtOpen: number;
    chainlinkAt30s: number;
    chainlinkAt60s: number;
    earlySpread: number;        // Spread in first 10 seconds
    earlyDepth: number;         // Total depth in first 10 seconds
    firstTickDirection: 'UP' | 'DOWN' | 'FLAT'; // Did the first tick go up or down?
    prevContinuation: boolean;  // Did this candle continue previous direction?
}

async function monitorTransition(candleIndex: number, chainlink: ChainlinkFeed, prevOutcome: string, prevMove: number): Promise<TransitionData | null> {
    // Wait for candle boundary
    const now = Date.now();
    const currentRound = Math.floor(now / 300000) * 300000;
    const nextCandle = currentRound + 300000;
    const intoCandle = (now - currentRound) / 1000;

    if (intoCandle > 15) {
        const waitMs = nextCandle - now;
        console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for transition...`);
        await new Promise(r => setTimeout(r, waitMs));
    }

    // Wait a moment for new market to appear
    await new Promise(r => setTimeout(r, 2000));

    const market = await (async () => {
        const ts = Math.floor(Date.now() / 1000);
        const rounded = Math.floor(ts / 300) * 300;
        for (const t of [rounded, rounded + 300]) {
            const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${t}`);
            if (data?.length > 0) {
                const m = data[0];
                if (new Date(m.endDate).getTime() > Date.now()) return m;
            }
        }
        return null;
    })();

    if (!market) {
        console.log(`  Candle ${candleIndex}: No market found`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    console.log(`  Candle ${candleIndex}: ${market.question} (prev: ${prevOutcome})`);

    const chainlinkAtOpen = chainlink.getPrice();
    let chainlinkAt30s = 0;
    let chainlinkAt60s = 0;

    const mids: { t: number; mid: number }[] = [];
    const earlyMids: number[] = [];
    const earlyFirst10: number[] = [];
    const earlySpreads: number[] = [];
    const earlyDepths: number[] = [];

    const POLL_INTERVAL = 2000;
    const maxPolls = 160;

    for (let p = 0; p < maxPolls; p++) {
        const secondsLeft = (endDate.getTime() - Date.now()) / 1000;
        if (secondsLeft < -5) break;
        const secondsInto = 300 - secondsLeft;

        try {
            const book = await getBook(upToken);

            if (book.mid > 0.02 && book.mid < 0.98) {
                mids.push({ t: secondsInto, mid: book.mid });

                if (secondsInto <= 10) {
                    earlyFirst10.push(book.mid);
                    earlySpreads.push(book.spread);
                    earlyDepths.push(book.bidDepth + book.askDepth);
                }
                if (secondsInto <= 30) {
                    earlyMids.push(book.mid);
                }
            }

            // Record Chainlink at key times
            if (secondsInto >= 28 && secondsInto <= 32 && chainlinkAt30s === 0) {
                chainlinkAt30s = chainlink.getPrice();
            }
            if (secondsInto >= 58 && secondsInto <= 62 && chainlinkAt60s === 0) {
                chainlinkAt60s = chainlink.getPrice();
            }

            // Log at key moments
            if (secondsInto <= 15 || (p % 10 === 0 && secondsInto > 15)) {
                console.log(
                    `    ${Math.round(secondsInto).toString().padStart(4)}s | ` +
                    `Mid: ${(book.mid * 100).toFixed(1).padStart(5)}% | ` +
                    `Spread: ${(book.spread * 100).toFixed(1).padStart(4)}c | ` +
                    `Depth: $${(book.bidDepth + book.askDepth).toFixed(0).padStart(5)} | ` +
                    `CL: ${(chainlink.getPrice() - chainlinkAtOpen >= 0 ? '+' : '')}$${(chainlink.getPrice() - chainlinkAtOpen).toFixed(1)}`
                );
            }
        } catch {}

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    // Resolution
    await new Promise(r => setTimeout(r, 8000));
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    if (outcome === 'UNKNOWN') {
        outcome = chainlink.getPrice() >= chainlinkAtOpen ? 'UP' : 'DOWN';
    }

    const firstMid = mids.length > 0 ? mids[0].mid : 0.5;
    const first10sMid = earlyFirst10.length > 0 ? earlyFirst10.reduce((a, b) => a + b, 0) / earlyFirst10.length : 0.5;
    const first30sMid = earlyMids.length > 0 ? earlyMids.reduce((a, b) => a + b, 0) / earlyMids.length : 0.5;

    const midAt = (targetS: number) => {
        const closest = mids.filter(m => m.t >= targetS - 5 && m.t <= targetS + 5);
        return closest.length > 0 ? closest[closest.length - 1].mid : 0.5;
    };

    const firstTickDir = firstMid > 0.52 ? 'UP' : firstMid < 0.48 ? 'DOWN' : 'FLAT';
    const prevContinuation = (prevOutcome === 'UP' && outcome === 'UP') || (prevOutcome === 'DOWN' && outcome === 'DOWN');

    const earlySpread = earlySpreads.length > 0 ? earlySpreads.reduce((a, b) => a + b, 0) / earlySpreads.length : 0;
    const earlyDepth = earlyDepths.length > 0 ? earlyDepths.reduce((a, b) => a + b, 0) / earlyDepths.length : 0;

    console.log(`    → ${outcome} | Prev continued: ${prevContinuation} | First tick: ${firstTickDir}`);

    return {
        prevOutcome: prevOutcome as any,
        prevChainlinkMove: prevMove,
        newCandleIndex: candleIndex,
        firstMid,
        first10sMid,
        first30sMid,
        midAt60s: midAt(60),
        midAt120s: midAt(120),
        midAt180s: midAt(180),
        outcome,
        chainlinkAtOpen,
        chainlinkAt30s,
        chainlinkAt60s,
        earlySpread,
        earlyDepth,
        firstTickDirection: firstTickDir,
        prevContinuation,
    };
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '6');
    console.log(`=== Candle Transition Study: ${NUM_CANDLES} transitions ===\n`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    const transitions: TransitionData[] = [];
    let prevOutcome = 'UNKNOWN';
    let prevMove = 0;

    for (let i = 0; i < NUM_CANDLES; i++) {
        const openPrice = chainlink.getPrice();
        const result = await monitorTransition(i + 1, chainlink, prevOutcome, prevMove);
        if (result) {
            transitions.push(result);
            prevOutcome = result.outcome;
            prevMove = chainlink.getPrice() - result.chainlinkAtOpen;
        }
    }

    chainlink.disconnect();

    if (transitions.length === 0) return;

    // Analysis
    console.log('\n' + '='.repeat(70));
    console.log('TRANSITION ANALYSIS');
    console.log('='.repeat(70));

    console.log(`\nTransitions: ${transitions.length}`);

    // Continuation vs reversal
    const withPrev = transitions.filter(t => t.prevOutcome !== 'UNKNOWN');
    const continues = withPrev.filter(t => t.prevContinuation);
    console.log(`\nContinuation rate: ${continues.length}/${withPrev.length} (${((continues.length / Math.max(1, withPrev.length)) * 100).toFixed(0)}%)`);
    console.log('(50% = random, >50% = momentum, <50% = mean-reversion)');

    // Early spread and depth
    console.log(`\n--- Open Characteristics ---`);
    const avgEarlySpread = transitions.reduce((s, t) => s + t.earlySpread, 0) / transitions.length;
    const avgEarlyDepth = transitions.reduce((s, t) => s + t.earlyDepth, 0) / transitions.length;
    console.log(`Avg spread (first 10s): ${(avgEarlySpread * 100).toFixed(2)}c`);
    console.log(`Avg depth (first 10s): $${avgEarlyDepth.toFixed(0)}`);

    // First tick prediction
    console.log(`\n--- First Tick Direction vs Outcome ---`);
    const upTicks = transitions.filter(t => t.firstTickDirection === 'UP');
    const downTicks = transitions.filter(t => t.firstTickDirection === 'DOWN');
    const flatTicks = transitions.filter(t => t.firstTickDirection === 'FLAT');

    if (upTicks.length > 0) {
        const upCorrect = upTicks.filter(t => t.outcome === 'UP').length;
        console.log(`  First tick UP: ${upCorrect}/${upTicks.length} resolved UP (${((upCorrect / upTicks.length) * 100).toFixed(0)}%)`);
    }
    if (downTicks.length > 0) {
        const downCorrect = downTicks.filter(t => t.outcome === 'DOWN').length;
        console.log(`  First tick DOWN: ${downCorrect}/${downTicks.length} resolved DOWN (${((downCorrect / downTicks.length) * 100).toFixed(0)}%)`);
    }
    if (flatTicks.length > 0) {
        console.log(`  First tick FLAT: ${flatTicks.length} candles`);
    }

    // Mid progression
    console.log(`\n--- Mid Progression ---`);
    for (const t of transitions) {
        console.log(
            `  C${t.newCandleIndex}: ` +
            `Open ${(t.firstMid * 100).toFixed(0)}% → ` +
            `30s ${(t.first30sMid * 100).toFixed(0)}% → ` +
            `60s ${(t.midAt60s * 100).toFixed(0)}% → ` +
            `120s ${(t.midAt120s * 100).toFixed(0)}% → ` +
            `180s ${(t.midAt180s * 100).toFixed(0)}% → ` +
            `${t.outcome} (prev: ${t.prevOutcome})`
        );
    }

    // Strategy: Buy contrarian (fade the previous candle)
    console.log(`\n--- Strategy: Fade Previous Candle ---`);
    console.log('If prev=UP → buy Down at open, if prev=DOWN → buy Up at open');
    let fadePnL = 0;
    let fadeTrades = 0;
    for (const t of withPrev) {
        fadeTrades++;
        const buyUp = t.prevOutcome === 'DOWN';
        const entryPrice = buyUp ? t.first30sMid : (1 - t.first30sMid);
        if ((buyUp && t.outcome === 'UP') || (!buyUp && t.outcome === 'DOWN')) {
            fadePnL += (1 - entryPrice) * 100;
        } else {
            fadePnL += -entryPrice * 100;
        }
    }
    console.log(`  Trades: ${fadeTrades} | P&L: $${fadePnL.toFixed(2)} | Per trade: $${(fadePnL / Math.max(1, fadeTrades)).toFixed(2)}`);

    // Strategy: Follow momentum (continue previous candle)
    console.log(`\n--- Strategy: Follow Previous Candle ---`);
    let momPnL = 0;
    let momTrades = 0;
    for (const t of withPrev) {
        momTrades++;
        const buyUp = t.prevOutcome === 'UP';
        const entryPrice = buyUp ? t.first30sMid : (1 - t.first30sMid);
        if ((buyUp && t.outcome === 'UP') || (!buyUp && t.outcome === 'DOWN')) {
            momPnL += (1 - entryPrice) * 100;
        } else {
            momPnL += -entryPrice * 100;
        }
    }
    console.log(`  Trades: ${momTrades} | P&L: $${momPnL.toFixed(2)} | Per trade: $${(momPnL / Math.max(1, momTrades)).toFixed(2)}`);

    // Strategy: Follow first tick direction
    console.log(`\n--- Strategy: Follow First Tick ---`);
    let tickPnL = 0;
    let tickTrades = 0;
    for (const t of transitions) {
        if (t.firstTickDirection === 'FLAT') continue;
        tickTrades++;
        const buyUp = t.firstTickDirection === 'UP';
        const entryPrice = 0.50; // Assume we enter at ~50c near open
        if ((buyUp && t.outcome === 'UP') || (!buyUp && t.outcome === 'DOWN')) {
            tickPnL += (1 - entryPrice) * 100;
        } else {
            tickPnL += -entryPrice * 100;
        }
    }
    console.log(`  Trades: ${tickTrades} | P&L: $${tickPnL.toFixed(2)} | Per trade: $${(tickPnL / Math.max(1, tickTrades)).toFixed(2)}`);
}

main().catch(console.error);
