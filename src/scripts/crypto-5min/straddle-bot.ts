/**
 * Live Straddle Bot — BTC 5-min binary options
 *
 * Strategy:
 *   At candle open, place BUY on UP token at mid-offset and
 *   BUY on DOWN token at (1-mid)-offset (equivalent to SELL UP at mid+offset).
 *   If both fill → guaranteed profit = 2*offset per share pair.
 *   If single fill → cancel other side immediately, hold position to resolution.
 *
 * Usage: npx tsx src/scripts/crypto-5min/straddle-bot.ts [numCandles] [sharesPerSide] [offsetCents] [maxSingleLoss] [minPrevVolume]
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

// ── Config ──────────────────────────────────────────────────────────────
const OFFSET = parseFloat(process.argv[4] || '0.02');       // 2c each side
const SHARES_PER_SIDE = parseInt(process.argv[3] || '20');  // shares per leg
const NUM_CANDLES = parseInt(process.argv[2] || '5');        // candles to trade
const POLL_INTERVAL_MS = 2000;                               // check fills every 2s
const EXIT_BEFORE_END_S = 15;                                // cancel unfilled orders 15s before end
const MAX_SINGLE_LOSS = parseFloat(process.argv[5] || '0.50');     // stop if any single exit loses more than this
const MIN_PREV_VOLUME = parseFloat(process.argv[6] || '0');        // skip candle if previous candle volume below this (0 = no filter)
const GAMMA_API = 'https://gamma-api.polymarket.com';

// ── Types ───────────────────────────────────────────────────────────────
interface CandleResult {
    candle: number;
    market: string;
    upMid: number;
    downMid: number;
    upBuyPrice: number;
    downBuyPrice: number;
    upFilled: boolean;
    downFilled: boolean;
    outcome: 'both_fill' | 'single_up' | 'single_down' | 'no_fill';
    pnl: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────
function roundPrice(p: number): number {
    return Math.round(p * 100) / 100;
}

async function findMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300]) {
        try {
            const resp = await fetch(`${GAMMA_API}/markets?slug=btc-updown-5m-${ts}`);
            const data = await resp.json();
            if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
                return data[0];
            }
        } catch {}
    }
    return null;
}

async function getPrevCandleVolume(): Promise<number> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    const prevTs = rounded - 300;
    try {
        const resp = await fetch(`${GAMMA_API}/markets?slug=btc-updown-5m-${prevTs}`);
        const data = await resp.json();
        if (data?.length > 0) {
            return parseFloat(data[0].volume || '0');
        }
    } catch {}
    return 0;
}

async function getBookMid(client: ClobClient, tokenId: string): Promise<{ mid: number; bestBid: number; bestAsk: number }> {
    const book = await client.getOrderBook(tokenId);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    return { mid: (bestBid + bestAsk) / 2, bestBid, bestAsk };
}

// cancelOrder expects { orderID: string }, not a raw string
async function safeCancel(client: ClobClient, orderId: string): Promise<boolean> {
    if (!orderId) return false;
    try {
        await client.cancelOrder({ orderID: orderId } as any);
        return true;
    } catch {
        try { await client.cancelAll(); return true; } catch {}
        return false;
    }
}

// Immediately sell filled tokens back into the book to limit loss
// Includes retry with delay for on-chain settlement
async function instantExit(client: ClobClient, tokenId: string, size: number, buyPrice: number): Promise<{ sold: boolean; sellPrice: number; loss: number }> {
    const MAX_RETRIES = 6;
    const RETRY_DELAY_MS = 5000; // wait for on-chain settlement

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            // Wait for settlement before first attempt
            if (attempt === 1) {
                console.log(`    Waiting ${RETRY_DELAY_MS / 1000}s for settlement...`);
                await sleep(RETRY_DELAY_MS);
            }

            // Read current book to find best bid
            const book = await client.getOrderBook(tokenId);
            const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
            const bestBid = parseFloat(bids[0]?.price || '0');

            if (bestBid <= 0.01) {
                console.log(`    No bids in book — cannot exit`);
                return { sold: false, sellPrice: 0, loss: buyPrice * size };
            }

            console.log(`    [Attempt ${attempt}] Selling ${size} @ ${bestBid} (bought @ ${buyPrice}, loss: ${((buyPrice - bestBid) * 100).toFixed(1)}c/share)`);
            const result = await client.createAndPostOrder({
                tokenID: tokenId,
                price: bestBid,
                size: size,
                side: 'SELL' as any,
            });

            if (result?.orderID && !result?.error) {
                const loss = (buyPrice - bestBid) * size;
                console.log(`    EXIT SUCCESS — lost $${loss.toFixed(4)}`);
                return { sold: true, sellPrice: bestBid, loss };
            } else if (result?.error === 'not enough balance / allowance' && attempt < MAX_RETRIES) {
                console.log(`    Tokens not settled yet, retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
                continue;
            } else {
                console.log(`    SELL failed: ${result?.error || 'unknown'}`);
                return { sold: false, sellPrice: 0, loss: buyPrice * size };
            }
        } catch (e: any) {
            const errMsg = e.response?.data?.error || e.message?.slice(0, 100) || '';
            if (errMsg.includes('not enough balance') && attempt < MAX_RETRIES) {
                console.log(`    Tokens not settled yet (attempt ${attempt}), retrying in ${RETRY_DELAY_MS / 1000}s...`);
                await sleep(RETRY_DELAY_MS);
                continue;
            }
            console.log(`    EXIT FAILED: ${errMsg}`);
            return { sold: false, sellPrice: 0, loss: buyPrice * size };
        }
    }
    return { sold: false, sellPrice: 0, loss: buyPrice * size };
}

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
}

function msUntilNextCandle(): number {
    const now = Date.now();
    const nextBoundary = Math.ceil(now / 300000) * 300000;
    return nextBoundary - now;
}

// ── Main ────────────────────────────────────────────────────────────────
async function main() {
    console.log('=== BTC 5-Min Straddle Bot ===');
    console.log(`Config: ${SHARES_PER_SIDE} shares/side, ${(OFFSET * 100).toFixed(0)}c offset, ${NUM_CANDLES} candles`);
    console.log(`Safety: stop if any single exit loses more than $${MAX_SINGLE_LOSS.toFixed(2)} (instant exit validation)`);
    console.log(`Volume filter: ${MIN_PREV_VOLUME > 0 ? `skip if prev candle < $${MIN_PREV_VOLUME.toFixed(0)}` : 'disabled (logging only)'}\n`);

    // Init client
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    console.log(`Wallet: ${wallet.address}`);

    const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    const apiKey = (creds as any).key;

    const client = new ClobClient(
        'https://clob.polymarket.com', 137, wallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        0 // EOA mode
    );

    console.log(`API key: ${apiKey.slice(0, 12)}...`);

    // Cancel any stale orders
    await client.cancelAll();
    console.log('Cleared existing orders.\n');

    const results: CandleResult[] = [];
    let runningPnl = 0;
    let stopped = false;

    for (let i = 0; i < NUM_CANDLES; i++) {
        console.log(`\n${'='.repeat(60)}`);
        console.log(`CANDLE ${i + 1}/${NUM_CANDLES} | Running P&L: $${runningPnl.toFixed(4)}`);
        console.log(`${'='.repeat(60)}`);

        // Wait for next candle boundary (+ 3s buffer for market to appear)
        const waitMs = msUntilNextCandle();
        if (waitMs > 5000) {
            console.log(`Waiting ${(waitMs / 1000).toFixed(0)}s for next candle...`);
            await sleep(waitMs + 3000);
        } else {
            await sleep(3000);
        }

        // Find market
        let market = await findMarket();
        for (let retry = 0; retry < 5 && !market; retry++) {
            await sleep(2000);
            market = await findMarket();
        }
        if (!market) {
            console.log('No market found. Skipping candle.');
            continue;
        }

        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const upToken = tokenIds[0];
        const downToken = tokenIds[1];
        const endTime = new Date(market.endDate).getTime();
        console.log(`Market: ${market.question}`);
        console.log(`Ends: ${new Date(endTime).toLocaleTimeString()}`);

        // Volume analysis
        const prevVol = await getPrevCandleVolume();
        const currentVol0 = parseFloat(market.volume || '0');
        console.log(`Prev candle volume: $${prevVol.toFixed(0)} | Current so far: $${currentVol0.toFixed(0)}`);

        // Wait 15s and re-check current candle volume to see if flow is active
        if (MIN_PREV_VOLUME > 0) {
            console.log('  Checking volume warmup (15s)...');
            await sleep(15000);
            const refreshed = await findMarket();
            const currentVol15 = parseFloat(refreshed?.volume || '0');
            const flowRate = currentVol15 - currentVol0;
            console.log(`  Volume after 15s: $${currentVol15.toFixed(0)} (+$${flowRate.toFixed(0)} in 15s, projected: $${(flowRate * 20).toFixed(0)}/candle)`);

            if (prevVol < MIN_PREV_VOLUME && flowRate < MIN_PREV_VOLUME / 20) {
                console.log(`SKIP: Low volume — prev $${prevVol.toFixed(0)}, current flow $${flowRate.toFixed(0)}/15s. Below threshold.`);
                continue;
            }
        }

        // Read order books
        const upBook = await getBookMid(client, upToken);
        const downBook = await getBookMid(client, downToken);
        const upMid = upBook.mid;
        const downMid = downBook.mid;
        console.log(`UP: ${upBook.bestBid}/${upBook.bestAsk} (mid ${(upMid * 100).toFixed(1)}c) | DOWN: ${downBook.bestBid}/${downBook.bestAsk} (mid ${(downMid * 100).toFixed(1)}c)`);

        // Calculate prices — use complementary pricing for consistency
        // UP buy at mid - offset, DOWN buy at (1 - upMid) - offset
        // This ensures total cost = upBuy + downBuy = (upMid - offset) + (1 - upMid - offset) = 1 - 2*offset
        const upBuyPrice = roundPrice(upMid - OFFSET);
        const downBuyPrice = roundPrice(1.0 - upMid - OFFSET);
        const totalCostPerPair = upBuyPrice + downBuyPrice;
        const profitPerPair = 1.0 - totalCostPerPair;

        console.log(`BUY UP @ ${(upBuyPrice * 100).toFixed(0)}c + BUY DOWN @ ${(downBuyPrice * 100).toFixed(0)}c = ${(totalCostPerPair * 100).toFixed(0)}c/pair`);
        console.log(`Profit/pair: ${(profitPerPair * 100).toFixed(1)}c | ${SHARES_PER_SIDE} shares → Max: $${(profitPerPair * SHARES_PER_SIDE).toFixed(2)}`);

        // Sanity checks
        if (upBuyPrice <= 0.05 || downBuyPrice <= 0.05) {
            console.log('SKIP: Price too extreme (< 5c).');
            continue;
        }
        if (profitPerPair <= 0) {
            console.log('SKIP: No profit margin.');
            continue;
        }
        if (upBuyPrice >= upBook.bestAsk) {
            console.log('SKIP: UP price would cross spread (taker fill).');
            continue;
        }
        if (downBuyPrice >= downBook.bestAsk) {
            console.log('SKIP: DOWN price would cross spread (taker fill).');
            continue;
        }

        // Place BOTH orders
        let upOrderId = '';
        let downOrderId = '';

        try {
            const upResult = await client.createAndPostOrder({
                tokenID: upToken,
                price: upBuyPrice,
                size: SHARES_PER_SIDE,
                side: 'BUY' as any,
            });
            upOrderId = upResult?.orderID || '';
            if (upResult?.error) {
                console.log(`  UP FAILED: ${upResult.error}`);
            } else {
                console.log(`  UP LIVE: ${upOrderId.slice(0, 20)}...`);
            }
        } catch (e: any) {
            console.error(`  UP FAILED: ${e.response?.data?.error || e.message?.slice(0, 100)}`);
        }

        try {
            const downResult = await client.createAndPostOrder({
                tokenID: downToken,
                price: downBuyPrice,
                size: SHARES_PER_SIDE,
                side: 'BUY' as any,
            });
            downOrderId = downResult?.orderID || '';
            if (downResult?.error) {
                console.log(`  DOWN FAILED: ${downResult.error}`);
            } else {
                console.log(`  DOWN LIVE: ${downOrderId.slice(0, 20)}...`);
            }
        } catch (e: any) {
            console.error(`  DOWN FAILED: ${e.response?.data?.error || e.message?.slice(0, 100)}`);
        }

        // If only one order placed, cancel it and skip
        if (!upOrderId && !downOrderId) {
            console.log('Both orders failed. Skipping.');
            continue;
        }
        if (!upOrderId || !downOrderId) {
            console.log('Only one order placed — cancelling to avoid unhedged exposure.');
            if (upOrderId) await safeCancel(client, upOrderId);
            if (downOrderId) await safeCancel(client, downOrderId);
            continue;
        }

        // Monitor fills
        console.log('\n--- Monitoring ---');
        let upFilled = false;
        let downFilled = false;
        let exitResult: { sold: boolean; sellPrice: number; loss: number } | null = null;
        let exitSide: 'up' | 'down' | null = null;

        while (Date.now() < endTime - EXIT_BEFORE_END_S * 1000) {
            await sleep(POLL_INTERVAL_MS);

            const openOrders = await client.getOpenOrders();
            const openIds = new Set((openOrders || []).map((o: any) => o.id || o.orderID));

            if (!upFilled && !openIds.has(upOrderId)) {
                upFilled = true;
                console.log(`  [${new Date().toLocaleTimeString()}] UP FILLED @ ${upBuyPrice}`);
            }
            if (!downFilled && !openIds.has(downOrderId)) {
                downFilled = true;
                console.log(`  [${new Date().toLocaleTimeString()}] DOWN FILLED @ ${downBuyPrice}`);
            }

            // Both filled = guaranteed profit, done
            if (upFilled && downFilled) {
                console.log('  BOTH FILLED — Guaranteed profit!');
                break;
            }

            // Single fill — cancel the other side AND sell filled tokens immediately
            if (upFilled && !downFilled) {
                console.log('  Single fill (UP). Cancelling DOWN + exiting UP...');
                await safeCancel(client, downOrderId);
                const exit = await instantExit(client, upToken, SHARES_PER_SIDE, upBuyPrice);
                exitResult = exit;
                exitSide = 'up';
                break;
            }
            if (downFilled && !upFilled) {
                console.log('  Single fill (DOWN). Cancelling UP + exiting DOWN...');
                await safeCancel(client, upOrderId);
                const exit = await instantExit(client, downToken, SHARES_PER_SIDE, downBuyPrice);
                exitResult = exit;
                exitSide = 'down';
                break;
            }

            const remaining = Math.floor((endTime - Date.now()) / 1000);
            if (remaining % 30 < 3) {
                console.log(`  [${new Date().toLocaleTimeString()}] ${remaining}s left, both orders open`);
            }
        }

        // Cancel any remaining unfilled orders before resolution
        if (!upFilled) {
            await safeCancel(client, upOrderId);
            console.log('  Cancelled unfilled UP.');
        }
        if (!downFilled) {
            await safeCancel(client, downOrderId);
            console.log('  Cancelled unfilled DOWN.');
        }

        // Determine outcome and P&L
        let outcome: CandleResult['outcome'] = 'no_fill';
        let pnl = 0;

        if (upFilled && downFilled) {
            outcome = 'both_fill';
            pnl = profitPerPair * SHARES_PER_SIDE;
        } else if (exitResult) {
            outcome = exitSide === 'up' ? 'single_up' : 'single_down';
            if (exitResult.sold) {
                // Successfully exited — loss is just the spread
                pnl = -exitResult.loss;
            } else {
                // Exit failed — holding to resolution (worst case)
                const holdPrice = exitSide === 'up' ? upBuyPrice : downBuyPrice;
                pnl = -(holdPrice * SHARES_PER_SIDE);
                console.log(`  EXIT FAILED — holding ${SHARES_PER_SIDE} tokens to resolution. Worst case: -$${(-pnl).toFixed(2)}`);
            }
        } else if (upFilled) {
            outcome = 'single_up';
            pnl = -(upBuyPrice * SHARES_PER_SIDE);
        } else if (downFilled) {
            outcome = 'single_down';
            pnl = -(downBuyPrice * SHARES_PER_SIDE);
        }

        runningPnl += pnl;

        results.push({
            candle: i + 1,
            market: market.question,
            upMid, downMid,
            upBuyPrice, downBuyPrice,
            upFilled, downFilled,
            outcome, pnl,
        });

        console.log(`\n  Result: ${outcome} | P&L: $${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)}`);

        // Circuit breaker: if a single exit lost more than expected, something is wrong
        if (exitResult && exitResult.loss > MAX_SINGLE_LOSS) {
            console.log(`\n*** CIRCUIT BREAKER: Single exit lost $${exitResult.loss.toFixed(4)} (limit $${MAX_SINGLE_LOSS.toFixed(2)}). Instant exit may not be working correctly. Stopping. ***`);
            stopped = true;
            break;
        }
        if (exitResult && !exitResult.sold) {
            console.log(`\n*** CIRCUIT BREAKER: Instant exit FAILED (could not sell). Stopping to prevent hold-to-resolution losses. ***`);
            stopped = true;
            break;
        }

        // Wait for candle end before next
        const timeLeft = endTime - Date.now();
        if (timeLeft > 0 && i < NUM_CANDLES - 1) {
            console.log(`  Waiting ${(timeLeft / 1000).toFixed(0)}s for resolution...`);
            await sleep(timeLeft + 2000);
        }
    }

    // ── Summary ──
    console.log(`\n${'='.repeat(60)}`);
    console.log(`SESSION SUMMARY${stopped ? ' (STOPPED BY CIRCUIT BREAKER)' : ''}`);
    console.log(`${'='.repeat(60)}`);

    const bothFills = results.filter(r => r.outcome === 'both_fill');
    const singleFills = results.filter(r => r.outcome.startsWith('single'));
    const noFills = results.filter(r => r.outcome === 'no_fill');

    console.log(`Candles: ${results.length} | Both: ${bothFills.length} | Single: ${singleFills.length} | None: ${noFills.length}`);
    console.log(`Both-fill rate: ${results.length > 0 ? ((bothFills.length / results.length) * 100).toFixed(0) : 0}%`);

    const guaranteedProfit = bothFills.reduce((s, r) => s + r.pnl, 0);
    const singleFillLoss = singleFills.reduce((s, r) => s + r.pnl, 0);
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);
    console.log(`Both-fill profit: $${guaranteedProfit >= 0 ? '+' : ''}${guaranteedProfit.toFixed(4)}`);
    console.log(`Single-fill loss:  $${singleFillLoss.toFixed(4)}`);
    console.log(`Net P&L:           $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(4)}`);

    for (const r of results) {
        console.log(`  Candle ${r.candle}: ${r.outcome.padEnd(12)} UP@${(r.upBuyPrice * 100).toFixed(0)}c DOWN@${(r.downBuyPrice * 100).toFixed(0)}c P&L:$${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(4)}`);
    }

    await client.cancelAll();
    console.log('\nBot stopped. All orders cleared.');
}

main().catch(e => {
    console.error('Fatal:', e);
    process.exit(1);
});
