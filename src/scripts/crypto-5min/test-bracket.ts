/**
 * Test Bracket Trade — One live bracket trade to validate the L1 mechanic.
 *
 * What it does:
 * 1. Waits for a candle where the leader is in the 50-80¢ zone at T-180
 * 2. Buys $10 of the leader at the ask (taker)
 * 3. Immediately places a sell limit at entry - 3¢ (the stop)
 * 4. Monitors: did the stop fill? Did the price hit +20¢ target?
 * 5. If target hit, cancels the stop and sells at market (or holds to resolution)
 * 6. Logs everything for analysis
 *
 * This tests the critical question: does the pre-placed sell limit fill
 * at exactly the stop price, or does the order sit unfilled?
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/test-bracket.ts
 *   npx tsx src/scripts/crypto-5min/test-bracket.ts --crypto eth
 *   npx tsx src/scripts/crypto-5min/test-bracket.ts --dry  (log only, no orders)
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry');
const CRYPTO_FILTER = args.find((_, i, a) => a[i - 1] === '--crypto')?.toLowerCase() || '';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const STOP_CENTS = 3;
const TARGET_CENTS = 20;
const TRADE_SIZE = parseInt(args.find((_, i, a) => a[i - 1] === '--size') || '5');

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const log = (...a: any[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

async function fetchJSON(url: string) {
    try {
        const r = await fetch(url);
        return r.ok ? await r.json() : null;
    } catch { return null; }
}

async function getBookInfo(client: ClobClient, tokenId: string) {
    const book = await client.getOrderBook(tokenId);
    const bids = (book.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (book.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);
    return {
        bestBid: bids[0]?.price ?? 0,
        bestAsk: asks[0]?.price ?? 1,
        bestAskSize: asks[0]?.size ?? 0,
    };
}

async function main() {
    log('=== BRACKET TRADE TEST ===');
    log(`Mode: ${DRY_RUN ? 'DRY RUN (no orders)' : `LIVE ($${TRADE_SIZE} trade)`}`);
    log(`Bracket: stop -${STOP_CENTS}¢ / target +${TARGET_CENTS}¢`);
    log();

    // Connect
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient(CLOB, 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient(CLOB, 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);
    log('Connected to CLOB');

    const cryptos = CRYPTO_FILTER
        ? [{ slug: CRYPTO_FILTER, name: CRYPTO_FILTER.toUpperCase() }]
        : [{ slug: 'btc', name: 'BTC' }, { slug: 'eth', name: 'ETH' }, { slug: 'sol', name: 'SOL' }, { slug: 'xrp', name: 'XRP' }];

    // Wait for qualifying candle
    log('Waiting for a candle with leader in 50-80¢ zone...');

    while (true) {
        const now = Math.floor(Date.now() / 1000);
        const rounded = Math.floor(now / 300) * 300;
        const nextEnd = rounded + 300;
        const secsLeft = nextEnd - now;

        // Look for entry at T-180 (170-190s before end)
        if (secsLeft < 170 || secsLeft > 195) {
            await sleep(5000);
            continue;
        }

        // Find markets
        for (const crypto of cryptos) {
            const slug = `${crypto.slug}-updown-5m-${rounded}`;
            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (!data?.[0]) continue;
            const market = data[0];
            if (new Date(market.endDate).getTime() <= Date.now()) continue;

            const tokenIds = JSON.parse(market.clobTokenIds || '[]');
            const outcomes = JSON.parse(market.outcomes || '[]');
            if (tokenIds.length < 2 || outcomes.length < 2) continue;

            const upIdx = outcomes.indexOf('Up');
            const downIdx = outcomes.indexOf('Down');
            if (upIdx === -1 || downIdx === -1) continue;
            const upToken = tokenIds[upIdx];
            const downToken = tokenIds[downIdx];

            // Get book
            const [upBook, downBook] = await Promise.all([
                getBookInfo(authed, upToken),
                getBookInfo(authed, downToken),
            ]);

            const leaderSide = upBook.bestBid > downBook.bestBid ? 'UP' : 'DOWN';
            const leaderAsk = leaderSide === 'UP' ? upBook.bestAsk : downBook.bestAsk;
            const leaderBid = leaderSide === 'UP' ? upBook.bestBid : downBook.bestBid;
            const leaderToken = leaderSide === 'UP' ? upToken : downToken;
            const spread = leaderAsk - leaderBid;
            const otherAsk = leaderSide === 'UP' ? downBook.bestAsk : upBook.bestAsk;

            // Zone check
            if (leaderAsk < 0.50 || leaderAsk >= 0.80) {
                log(`  ${crypto.name}: ${leaderSide} @${(leaderAsk*100).toFixed(0)}¢ — outside 50-80¢`);
                continue;
            }
            if (otherAsk >= 0.99) {
                log(`  ${crypto.name}: one-sided, skip`);
                continue;
            }
            if (spread >= 0.03) {
                log(`  ${crypto.name}: spread ${(spread*100).toFixed(1)}¢ >= 3¢, skip`);
                continue;
            }

            const shares = Math.floor(TRADE_SIZE / leaderAsk);
            const stopPrice = Math.round((leaderAsk - STOP_CENTS / 100) * 100) / 100;
            const targetPrice = leaderAsk + TARGET_CENTS / 100;

            log();
            log(`══ BRACKET TRADE: ${crypto.name} ══`);
            log(`  Market: ${market.question}`);
            log(`  Leader: ${leaderSide} | Ask: ${(leaderAsk*100).toFixed(0)}¢ | Bid: ${(leaderBid*100).toFixed(0)}¢ | Spread: ${(spread*100).toFixed(1)}¢`);
            log(`  Shares: ${shares} | Cost: $${(shares * leaderAsk).toFixed(2)}`);
            log(`  Stop sell at: ${(stopPrice*100).toFixed(0)}¢ | Target: ${(targetPrice*100).toFixed(0)}¢`);
            log(`  Seconds left: ${secsLeft}`);
            log();

            if (DRY_RUN) {
                log('  DRY RUN — would place buy + sell limit here');
                log('  Run without --dry to execute live');
                return;
            }

            // ── STEP 1: BUY ──
            log('  STEP 1: Buying...');
            let buyOrderId: string;
            try {
                const buyResult = await authed.createAndPostOrder({
                    tokenID: leaderToken,
                    price: leaderAsk + 0.01, // slight bump to ensure taker fill
                    size: shares,
                    side: 'BUY' as any,
                });
                if (!buyResult?.orderID) {
                    log('  BUY FAILED:', buyResult?.error || 'no orderID');
                    return;
                }
                buyOrderId = buyResult.orderID;
                log(`  BUY placed: ${buyOrderId}`);
            } catch (e: any) {
                log('  BUY ERROR:', e.response?.data?.error || e.message?.slice(0, 100));
                return;
            }

            // Confirm buy filled
            await sleep(2000);
            const openAfterBuy = await authed.getOpenOrders() || [];
            const buyStillOpen = openAfterBuy.some((o: any) => o.id === buyOrderId || o.orderID === buyOrderId);
            if (buyStillOpen) {
                log('  BUY not filled after 2s — cancelling');
                await authed.cancelAll();
                return;
            }
            log('  BUY FILLED ✓');

            // ── STEP 2: WAIT FOR ON-CHAIN SETTLEMENT + PLACE STOP SELL ──
            log('  STEP 2: Waiting for on-chain token settlement (5s)...');
            await sleep(5000);

            // Refresh balance/allowance with CLOB
            try {
                await (authed as any).updateBalanceAllowance({
                    asset_type: 'CONDITIONAL',
                    token_id: leaderToken,
                });
                log('  Balance/allowance refreshed');
            } catch (e: any) {
                log('  Balance refresh skipped:', e.message?.slice(0, 50) || 'unknown');
            }

            // Check on-chain balance
            log(`  Placing sell limit at ${(stopPrice*100).toFixed(0)}¢...`);
            let sellOrderId: string = '';

            // Sell fewer shares than bought (fees reduce delivered tokens ~2%)
            const sellShares = Math.max(1, shares - 1);
            log(`  Selling ${sellShares} shares (bought ${shares}, -1 for fees)`);

            // Try up to 3 times with increasing delays
            for (let attempt = 0; attempt < 3; attempt++) {
                try {
                    const sellResult = await authed.createAndPostOrder({
                        tokenID: leaderToken,
                        price: stopPrice,
                        size: sellShares,
                        side: 'SELL' as any,
                    });
                    if (sellResult?.orderID) {
                        sellOrderId = sellResult.orderID;
                        log(`  SELL LIMIT placed: ${sellOrderId} at ${(stopPrice*100).toFixed(0)}¢ (attempt ${attempt + 1})`);
                        break;
                    } else {
                        log(`  SELL attempt ${attempt + 1} failed:`, sellResult?.error || 'no orderID');
                    }
                } catch (e: any) {
                    const errMsg = e.response?.data?.error || e.message?.slice(0, 100);
                    log(`  SELL attempt ${attempt + 1} error:`, errMsg);
                }
                if (attempt < 2) {
                    log(`  Waiting ${3 + attempt * 2}s before retry...`);
                    await sleep(3000 + attempt * 2000);
                }
            }

            if (!sellOrderId) {
                log('  ALL SELL ATTEMPTS FAILED — holding to resolution (no stop)');
            }

            // ── STEP 3: MONITOR ──
            log('  STEP 3: Monitoring...');
            const endTime = new Date(market.endDate).getTime();
            let stopFilled = false;
            let targetHit = false;

            while (Date.now() < endTime - 3000) {
                await sleep(3000);

                const secsRemaining = Math.round((endTime - Date.now()) / 1000);

                // Check book
                const book = leaderSide === 'UP'
                    ? await getBookInfo(authed, upToken)
                    : await getBookInfo(authed, downToken);
                const currentBid = book.bestBid;

                log(`    T-${secsRemaining}s | bid=${(currentBid*100).toFixed(0)}¢ | stop=${(stopPrice*100).toFixed(0)}¢ | target=${(targetPrice*100).toFixed(0)}¢`);

                // Check if sell order is still open (if it's gone, stop was filled)
                if (sellOrderId) {
                    const openOrders = await authed.getOpenOrders() || [];
                    const sellStillOpen = openOrders.some((o: any) => o.id === sellOrderId || o.orderID === sellOrderId);
                    if (!sellStillOpen) {
                        stopFilled = true;
                        log(`    ⛔ STOP FILLED — sell limit at ${(stopPrice*100).toFixed(0)}¢ was matched!`);
                        const stopPnl = sellShares * (stopPrice - leaderAsk);
                        log(`    Stop PnL: $${stopPnl.toFixed(2)} (exact, no slippage)`);
                        log(`    (1 share unsold from fee — worth $${(1 * stopPrice).toFixed(2)} if resolved, $0 if not)`);
                        break;
                    }
                }

                // Check if target hit
                if (currentBid >= targetPrice) {
                    targetHit = true;
                    log(`    🎯 TARGET HIT — bid ${(currentBid*100).toFixed(0)}¢ >= ${(targetPrice*100).toFixed(0)}¢`);

                    // Cancel the stop sell
                    if (sellOrderId) {
                        log('    Cancelling stop sell...');
                        await authed.cancelAll();
                    }

                    const targetPnl = sellShares * (targetPrice - leaderAsk);
                    log(`    Target PnL (if sold at target): $${targetPnl.toFixed(2)}`);
                    log('    Holding to resolution for full payout...');
                    break;
                }
            }

            // ── STEP 4: RESOLUTION ──
            if (!stopFilled) {
                log('  STEP 4: Waiting for resolution...');
                // Cancel any remaining sell orders before resolution
                if (sellOrderId && !stopFilled) {
                    await authed.cancelAll();
                    log('  Cancelled stop sell (holding to resolution)');
                }
                await sleep(Math.max(0, endTime - Date.now()) + 35000);

                // Check resolution
                const resolved = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                if (resolved?.[0]) {
                    const result = resolved[0].result;
                    const won = (leaderSide === 'UP' && result === 'Up') || (leaderSide === 'DOWN' && result === 'Down');
                    const holdPnl = won ? shares * (1 - leaderAsk) : -(shares * leaderAsk);
                    log(`  Resolution: ${result} — ${won ? 'WIN' : 'LOSS'} | PnL: $${holdPnl.toFixed(2)}`);
                } else {
                    log('  Could not fetch resolution');
                }
            }

            log();
            log('══ TEST COMPLETE ══');
            log(`  Stop filled: ${stopFilled}`);
            log(`  Target hit: ${targetHit}`);
            if (stopFilled) {
                log(`  KEY RESULT: Sell limit DID fill at exact stop price. L1 is viable.`);
            } else if (targetHit) {
                log(`  KEY RESULT: Target hit before stop. Profitable trade.`);
            } else {
                log(`  KEY RESULT: Neither stop nor target — held to resolution.`);
            }

            return;
        }

        await sleep(5000);
    }
}

main().catch(e => console.error('Fatal:', e));
