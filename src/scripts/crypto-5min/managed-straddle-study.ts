/**
 * Managed Straddle Study
 *
 * KEY HYPOTHESIS: The friend's strategy is a straddle with ACTIVE POSITION MANAGEMENT.
 * Unlike our previous study (hold to resolution), this tests:
 *
 * 1. Place BUY at mid-offset and SELL at mid+offset at candle open
 * 2. If BOTH fill → guaranteed spread profit → WIN
 * 3. If only ONE fills → EXIT the position by selling back to the book before resolution
 *    - This avoids the 100% adverse selection loss we observed
 *    - Cost = the spread to exit (~1-2c)
 * 4. Track actual win rate under this active management
 *
 * This could explain:
 * - 90%+ win rate (83% both-fill + some single-fills exit at breakeven)
 * - "Not about predicting price" (direction-agnostic)
 * - "Not about being first" (don't need queue priority)
 *
 * Run: npx tsx src/scripts/crypto-5min/managed-straddle-study.ts 30
 * Run via pm2: pm2 start --no-autorestart --name managed-straddle "npx tsx src/scripts/crypto-5min/managed-straddle-study.ts 30"
 */

import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'managed-straddle-results.json';

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
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

interface BookSnapshot {
    timestamp: number;
    secondsLeft: number;
    bestBid: number;
    bestAsk: number;
    mid: number;
    spread: number;
    bidSize: number;
    askSize: number;
}

async function getBook(tokenId: string): Promise<BookSnapshot | null> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return null;
    const bids = (raw.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    return {
        timestamp: Date.now(), secondsLeft: 0,
        bestBid, bestAsk, mid: (bestBid + bestAsk) / 2,
        spread: bestAsk - bestBid,
        bidSize: bids[0]?.size ?? 0,
        askSize: asks[0]?.size ?? 0,
    };
}

interface ManagedResult {
    index: number;
    timestamp: number;
    question: string;
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    volume: number;
    openMid: number;
    snapshotCount: number;
    openChainlink: number;
    closeChainlink: number;
    strategies: StrategyResult[];
}

interface StrategyResult {
    offset: number;
    bidPrice: number;
    askPrice: number;
    bidFillTime: number | null;    // seconds into candle when bid filled
    askFillTime: number | null;    // seconds into candle when ask filled
    bothFilled: boolean;
    // Exit management
    exitAction: 'both_filled' | 'exit_bid' | 'exit_ask' | 'hold_bid' | 'hold_ask' | 'none';
    exitPrice: number;            // price at which we exited the single-side position
    exitSecondsLeft: number;      // how much time was left when we exited
    // P&L
    pnl: number;
    isWin: boolean;
    // For hold-to-resolution comparison
    holdPnl: number;
}

const EXIT_DEADLINE = 30; // Exit single-side positions when this many seconds remain

async function monitorCandle(candleIndex: number, chainlink: ChainlinkFeed): Promise<ManagedResult | null> {
    const market = await findCurrentMarket();
    if (!market) {
        console.log(`  Candle ${candleIndex}: No market found`);
        return null;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    if (!upToken) return null;

    const endDate = new Date(market.endDate);
    const endTime = endDate.getTime();
    const startTime = endTime - 300000;

    let openChainlink: number | null = null;
    let openMid: number | null = null;

    // Track all snapshots for fill detection and exit pricing
    const snapshots: BookSnapshot[] = [];

    const POLL_INTERVAL = 2000;
    const maxPolls = 160;

    console.log(`  Candle ${candleIndex}: ${market.question}`);

    // Offsets to test
    const offsets = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];

    // Track fill state per offset
    const fillState = offsets.map(offset => ({
        offset,
        bidFilled: false,
        askFilled: false,
        bidFillTime: null as number | null,
        askFillTime: null as number | null,
        bidPrice: 0,
        askPrice: 0,
        exited: false,
        exitPrice: 0,
        exitSecondsLeft: 0,
        exitAction: 'none' as string,
    }));

    for (let p = 0; p < maxPolls; p++) {
        const now = Date.now();
        const secondsLeft = (endTime - now) / 1000;
        const secondsIn = (now - startTime) / 1000;
        if (secondsLeft < -5) break;

        const clPrice = chainlink.getPrice();
        if (!openChainlink && clPrice > 0) openChainlink = clPrice;

        const book = await getBook(upToken);
        if (!book || book.mid < 0.02 || book.mid > 0.98) {
            await new Promise(r => setTimeout(r, POLL_INTERVAL));
            continue;
        }

        book.secondsLeft = secondsLeft;
        snapshots.push(book);

        if (!openMid) {
            openMid = book.mid;
            // Set bid/ask prices for each offset
            for (const fs of fillState) {
                fs.bidPrice = Math.round((openMid - fs.offset) * 100) / 100;
                fs.askPrice = Math.round((openMid + fs.offset) * 100) / 100;
            }
            console.log(`    Open mid: ${(openMid * 100).toFixed(1)}c`);
        }

        // Check fills
        for (const fs of fillState) {
            if (fs.bidPrice <= 0.01 || fs.askPrice >= 0.99) continue;

            // Bid fills when market mid goes at or below our bid + tolerance
            if (!fs.bidFilled && book.mid <= fs.bidPrice + 0.005) {
                fs.bidFilled = true;
                fs.bidFillTime = secondsIn;
            }
            // Ask fills when market mid goes at or above our ask - tolerance
            if (!fs.askFilled && book.mid >= fs.askPrice - 0.005) {
                fs.askFilled = true;
                fs.askFillTime = secondsIn;
            }

            // EXIT MANAGEMENT: If only one side filled and we're approaching deadline
            if (!fs.exited && secondsLeft <= EXIT_DEADLINE && secondsLeft > 5) {
                if (fs.bidFilled && !fs.askFilled) {
                    // We bought at bidPrice, need to sell. Best exit = current bid
                    fs.exitPrice = book.bestBid;
                    fs.exitSecondsLeft = secondsLeft;
                    fs.exitAction = 'exit_bid';
                    fs.exited = true;
                } else if (fs.askFilled && !fs.bidFilled) {
                    // We sold at askPrice, need to buy back. Best exit = current ask
                    fs.exitPrice = book.bestAsk;
                    fs.exitSecondsLeft = secondsLeft;
                    fs.exitAction = 'exit_ask';
                    fs.exited = true;
                }
            }
        }

        // Brief status
        if (p % 30 === 0) {
            const move = openChainlink ? clPrice - openChainlink : 0;
            const fs4 = fillState.find(f => f.offset === 0.04)!;
            console.log(
                `    ${Math.round(secondsLeft).toString().padStart(4)}s | ` +
                `Mid: ${(book.mid * 100).toFixed(0)}c | ` +
                `CL: ${move >= 0 ? '+' : ''}$${move.toFixed(0)} | ` +
                `4c: ${fs4.bidFilled ? 'B' : '.'}${fs4.askFilled ? 'A' : '.'}`
            );
        }

        await new Promise(r => setTimeout(r, POLL_INTERVAL));
    }

    if (snapshots.length === 0 || !openMid || !openChainlink) {
        console.log(`    No data captured`);
        return null;
    }

    // Resolution
    await new Promise(r => setTimeout(r, 6000));
    const clClose = chainlink.getPrice();
    const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
    const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
    let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : 'UNKNOWN';
    if (outcome === 'UNKNOWN' && clClose >= openChainlink) outcome = 'UP';
    else if (outcome === 'UNKNOWN') outcome = 'DOWN';
    const volume = parseFloat(resolved?.[0]?.volume || '0');

    // Calculate P&L for each strategy
    const strategies: StrategyResult[] = fillState.map(fs => {
        let pnl = 0;
        let holdPnl = 0;
        let isWin = false;

        if (fs.bidFilled && fs.askFilled) {
            // Both filled → guaranteed spread capture
            pnl = (fs.askPrice - fs.bidPrice) * 100; // $100 per side
            holdPnl = pnl;
            isWin = true;
            fs.exitAction = 'both_filled';
        } else if (fs.bidFilled && !fs.askFilled) {
            // Hold-to-resolution P&L
            holdPnl = outcome === 'UP' ? (1 - fs.bidPrice) * 100 : -fs.bidPrice * 100;

            if (fs.exited) {
                // Managed exit: we bought at bidPrice, sold at exitPrice
                pnl = (fs.exitPrice - fs.bidPrice) * 100;
                isWin = pnl > 0;
            } else {
                // Too late to exit, hold to resolution
                pnl = holdPnl;
                isWin = pnl > 0;
                fs.exitAction = 'hold_bid';
            }
        } else if (fs.askFilled && !fs.bidFilled) {
            // Hold-to-resolution P&L
            holdPnl = outcome === 'DOWN' ? fs.askPrice * 100 : -(1 - fs.askPrice) * 100;

            if (fs.exited) {
                // Managed exit: we sold at askPrice, bought back at exitPrice
                pnl = (fs.askPrice - fs.exitPrice) * 100;
                isWin = pnl > 0;
            } else {
                pnl = holdPnl;
                isWin = pnl > 0;
                fs.exitAction = 'hold_ask';
            }
        }
        // else: nothing filled, pnl = 0

        return {
            offset: fs.offset,
            bidPrice: fs.bidPrice,
            askPrice: fs.askPrice,
            bidFillTime: fs.bidFillTime,
            askFillTime: fs.askFillTime,
            bothFilled: fs.bidFilled && fs.askFilled,
            exitAction: fs.exitAction as any,
            exitPrice: fs.exitPrice,
            exitSecondsLeft: fs.exitSecondsLeft,
            pnl,
            isWin,
            holdPnl,
        };
    });

    const result: ManagedResult = {
        index: candleIndex,
        timestamp: Date.now(),
        question: market.question,
        outcome,
        volume,
        openMid,
        snapshotCount: snapshots.length,
        openChainlink,
        closeChainlink: clClose,
        strategies,
    };

    // Log summary
    const s4 = strategies.find(s => s.offset === 0.04)!;
    console.log(
        `    >>> ${outcome} | Vol: $${volume.toFixed(0)} | ` +
        `4c: ${s4.exitAction} $${s4.pnl.toFixed(1)} (hold: $${s4.holdPnl.toFixed(1)})`
    );

    return result;
}

function saveResults(results: ManagedResult[]) {
    writeFileSync(OUTPUT_FILE, JSON.stringify(results, null, 2));
}

function printAnalysis(results: ManagedResult[]) {
    console.log('\n' + '='.repeat(100));
    console.log('MANAGED STRADDLE STUDY — ANALYSIS');
    console.log('='.repeat(100));

    console.log(`\nCandles: ${results.length}`);
    const ups = results.filter(r => r.outcome === 'UP').length;
    console.log(`Outcomes: ${ups} UP / ${results.length - ups} DOWN`);

    console.log('\n--- Managed vs Hold-to-Resolution Comparison ---');
    console.log(
        `${'Offset'.padEnd(8)} | ` +
        `${'Both'.padEnd(6)} | ` +
        `${'Exit'.padEnd(6)} | ` +
        `${'Hold'.padEnd(6)} | ` +
        `${'None'.padEnd(6)} | ` +
        `${'Win%'.padEnd(6)} | ` +
        `${'Managed P&L'.padStart(12)} | ` +
        `${'Hold P&L'.padStart(12)} | ` +
        `${'Saved'.padStart(10)} | ` +
        `${'Daily Est'.padStart(10)}`
    );
    console.log('-'.repeat(105));

    const offsets = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
    for (const offset of offsets) {
        let both = 0, exits = 0, holds = 0, none = 0;
        let managedPnl = 0, holdPnl = 0, wins = 0;

        for (const r of results) {
            const s = r.strategies.find(s => s.offset === offset);
            if (!s) continue;

            if (s.exitAction === 'both_filled') both++;
            else if (s.exitAction === 'exit_bid' || s.exitAction === 'exit_ask') exits++;
            else if (s.exitAction === 'hold_bid' || s.exitAction === 'hold_ask') holds++;
            else none++;

            managedPnl += s.pnl;
            holdPnl += s.holdPnl;
            if (s.isWin) wins++;
        }

        const total = both + exits + holds + none;
        const perCandle = managedPnl / total;
        const saved = managedPnl - holdPnl;
        const daily = perCandle * 288;

        console.log(
            `${(offset * 100).toFixed(0)}c`.padEnd(8) + ' | ' +
            `${both}`.padEnd(6) + ' | ' +
            `${exits}`.padEnd(6) + ' | ' +
            `${holds}`.padEnd(6) + ' | ' +
            `${none}`.padEnd(6) + ' | ' +
            `${((wins / total) * 100).toFixed(0)}%`.padEnd(6) + ' | ' +
            `$${managedPnl.toFixed(2)}`.padStart(12) + ' | ' +
            `$${holdPnl.toFixed(2)}`.padStart(12) + ' | ' +
            `$${saved.toFixed(2)}`.padStart(10) + ' | ' +
            `$${daily.toFixed(0)}`.padStart(10)
        );
    }

    // Exit analysis detail
    console.log('\n--- Exit Management Detail ---');
    for (const offset of [0.03, 0.04, 0.05]) {
        console.log(`\n  ${(offset * 100).toFixed(0)}c offset:`);
        for (const r of results) {
            const s = r.strategies.find(s => s.offset === offset);
            if (!s) continue;
            if (s.exitAction === 'exit_bid' || s.exitAction === 'exit_ask') {
                const direction = s.exitAction === 'exit_bid' ? 'bought' : 'sold';
                const entryPrice = s.exitAction === 'exit_bid' ? s.bidPrice : s.askPrice;
                console.log(
                    `    Candle ${r.index}: ${direction} at ${(entryPrice * 100).toFixed(0)}c, ` +
                    `exited at ${(s.exitPrice * 100).toFixed(0)}c (${s.exitSecondsLeft.toFixed(0)}s left) → ` +
                    `$${s.pnl.toFixed(1)} (hold would've been $${s.holdPnl.toFixed(1)})`
                );
            }
        }
    }

    // Different exit deadlines simulation
    console.log('\n--- What-If: Different Exit Deadlines ---');
    // We can't re-simulate different deadlines with the data we have,
    // but we can show the exit timing distribution
    for (const offset of [0.04]) {
        const exitTimes = results
            .map(r => r.strategies.find(s => s.offset === offset))
            .filter(s => s && (s.exitAction === 'exit_bid' || s.exitAction === 'exit_ask'))
            .map(s => s!.exitSecondsLeft);

        if (exitTimes.length > 0) {
            console.log(`  4c exits: ${exitTimes.length} exits at avg ${(exitTimes.reduce((a, b) => a + b, 0) / exitTimes.length).toFixed(0)}s left`);
        }
    }

    // Win rate by outcome
    console.log('\n--- Win Rate Breakdown ---');
    for (const offset of [0.03, 0.04, 0.05]) {
        const strats = results.map(r => ({ outcome: r.outcome, s: r.strategies.find(s => s.offset === offset)! })).filter(x => x.s);
        const wins = strats.filter(x => x.s.isWin).length;
        const bothWins = strats.filter(x => x.s.exitAction === 'both_filled').length;
        const exitWins = strats.filter(x => (x.s.exitAction === 'exit_bid' || x.s.exitAction === 'exit_ask') && x.s.isWin).length;
        const exitTotal = strats.filter(x => x.s.exitAction === 'exit_bid' || x.s.exitAction === 'exit_ask').length;

        console.log(
            `  ${(offset * 100).toFixed(0)}c: ${wins}/${strats.length} wins (${((wins / strats.length) * 100).toFixed(0)}%) — ` +
            `${bothWins} from both-fill, ${exitWins}/${exitTotal} from managed exits`
        );
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '20');
    console.log(`=== Managed Straddle Study: ${NUM_CANDLES} candles ===`);
    console.log(`Exit deadline: ${EXIT_DEADLINE}s before resolution`);
    console.log(`Started: ${new Date().toLocaleString()}`);
    console.log(`Output: ${OUTPUT_FILE}\n`);

    // Load existing results
    let results: ManagedResult[] = [];
    if (existsSync(OUTPUT_FILE)) {
        try {
            results = JSON.parse(readFileSync(OUTPUT_FILE, 'utf-8'));
            console.log(`Resuming from ${results.length} existing results\n`);
        } catch {}
    }

    const startIndex = results.length;
    const remaining = NUM_CANDLES - startIndex;
    if (remaining <= 0) {
        console.log('Already have enough candles. Running analysis...');
        printAnalysis(results);
        return;
    }

    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}\n`);

    for (let i = 0; i < remaining; i++) {
        const now = Date.now();
        const currentRound = Math.floor(now / 300000) * 300000;
        const nextCandle = currentRound + 300000;
        const intoCandle = (now - currentRound) / 1000;

        if (intoCandle > 20) {
            const waitMs = nextCandle - now + 3000;
            console.log(`  Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const result = await monitorCandle(startIndex + i + 1, chainlink);
        if (result) {
            results.push(result);
            saveResults(results);
            console.log(`    [Saved ${results.length}/${NUM_CANDLES} candles]`);
        }
    }

    chainlink.disconnect();
    console.log(`\nCompleted: ${new Date().toLocaleString()}`);
    printAnalysis(results);
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
