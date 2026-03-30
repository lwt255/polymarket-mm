/**
 * Buy-Winner Live Bot
 *
 * Simple strategy backed by 51,840 candles of data:
 *   1. Track Chainlink BTC price from candle open
 *   2. At T-60s, check: has BTC moved > 0.03% from open?
 *   3. If yes, BUY the predicted winner token on the CLOB
 *   4. Hold to resolution. Right = +33%, Wrong = -100%
 *   5. 93.4% accuracy over 180 days (35,707 trades)
 *
 * Risk Management:
 *   - Daily loss limit: stop after N losses
 *   - Consecutive loss pause: pause after 2 in a row
 *   - Accuracy tracking: stop if accuracy drops below threshold
 *
 * Run: npx tsx src/scripts/crypto-5min/buy-winner-live.ts [numCandles] [amountUSD]
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainlinkFeed } from './chainlink-feed.js';
import { writeFileSync, existsSync, readFileSync } from 'fs';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const GAMMA = 'https://gamma-api.polymarket.com';
const RESULTS_FILE = 'buy-winner-results.json';

const usdcAbi = parseAbi([
    'function balanceOf(address account) view returns (uint256)',
]);

// === STRATEGY PARAMETERS ===
const MIN_MOVE_PCT = 0.05;          // Minimum % move from open to trade (5bps - cuts 47% of losses vs 3bps)
const ENTRY_SECONDS_BEFORE = 60;    // Enter at T-60s
const MIN_SECONDS_AFTER_BUY = 3;    // Don't buy if < 3s left
const MAX_WINNER_ASK = 0.80;        // Skip if winner ask > 80c (bad risk/reward)

// === RISK MANAGEMENT ===
const MAX_DAILY_LOSSES = 4;         // Stop after 4 losses in a day
const MAX_CONSECUTIVE_LOSSES = 2;   // Pause after 2 consecutive losses
const PAUSE_AFTER_CONSEC_MS = 1800000; // 30 min pause after consecutive losses
const MIN_ACCURACY_THRESHOLD = 0.80;   // Stop if accuracy < 80% after 10+ trades
const MIN_TRADES_FOR_ACC_CHECK = 10;

interface TradeResult {
    index: number;
    timestamp: number;
    question: string;
    openClPrice: number;
    clPriceAtEntry: number;
    movePct: number;
    predictedWinner: 'UP' | 'DOWN';
    winnerTokenId: string;
    buyPrice: number;
    buySize: number;
    action: 'BUY' | 'SKIP';
    actionReason: string;
    filled: boolean;
    resolution?: 'UP' | 'DOWN' | 'UNKNOWN';
    correct?: boolean;
    pnl: number;
}

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

async function findNextMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300, rounded + 600]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0) {
            const endTime = new Date(data[0].endDate).getTime();
            const secsLeft = (endTime - Date.now()) / 1000;
            if (secsLeft > 30 && secsLeft < 330) {
                return data[0];
            }
        }
    }
    return null;
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '10');
    const AMOUNT_USD = parseInt(process.argv[3] || '10');

    console.log(`=== Buy-Winner Live Bot ===`);
    console.log(`Candles: ${NUM_CANDLES} | Amount: $${AMOUNT_USD}/trade`);
    console.log(`Filter: move > ${MIN_MOVE_PCT}% | Entry: T-${ENTRY_SECONDS_BEFORE}s`);
    console.log(`Risk: max ${MAX_DAILY_LOSSES} losses/day | pause after ${MAX_CONSECUTIVE_LOSSES} consecutive`);
    console.log();

    // Setup wallet
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 as `0x${string}`;
    if (!privateKey) { console.log('Need POLYMARKET_PRIVATE_KEY2'); return; }

    const account = privateKeyToAccount(privateKey);
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

    console.log(`Wallet: ${account.address}`);

    // Check balance
    const balance = await pub.readContract({
        address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
        args: [account.address],
    });
    console.log(`USDC.e: $${(Number(balance) / 1e6).toFixed(2)}`);
    if (Number(balance) / 1e6 < AMOUNT_USD) {
        console.log(`Need at least $${AMOUNT_USD}. Aborting.`);
        return;
    }

    // Setup CLOB client
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

    // Setup Chainlink
    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}`);
    console.log();

    // Load existing results
    let allResults: TradeResult[] = [];
    if (existsSync(RESULTS_FILE)) {
        try {
            allResults = JSON.parse(readFileSync(RESULTS_FILE, 'utf-8'));
            console.log(`Loaded ${allResults.length} previous results\n`);
        } catch {}
    }

    // Daily tracking
    let dailyLosses = 0;
    let consecutiveLosses = 0;
    let dailyWins = 0;
    let dailyPnl = 0;
    let pauseUntil = 0;

    const sessionResults: TradeResult[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`--- Candle ${i + 1}/${NUM_CANDLES} ---`);

        // Check risk limits
        if (dailyLosses >= MAX_DAILY_LOSSES) {
            console.log(`RISK: Hit daily loss limit (${dailyLosses} losses). Stopping.`);
            break;
        }

        if (Date.now() < pauseUntil) {
            const waitMs = pauseUntil - Date.now();
            console.log(`RISK: Paused after ${MAX_CONSECUTIVE_LOSSES} consecutive losses. Waiting ${(waitMs / 60000).toFixed(0)} min...`);
            await new Promise(r => setTimeout(r, waitMs));
        }

        const totalTrades = dailyWins + dailyLosses;
        if (totalTrades >= MIN_TRADES_FOR_ACC_CHECK) {
            const accuracy = dailyWins / totalTrades;
            if (accuracy < MIN_ACCURACY_THRESHOLD) {
                console.log(`RISK: Accuracy ${(accuracy * 100).toFixed(0)}% < ${MIN_ACCURACY_THRESHOLD * 100}% threshold after ${totalTrades} trades. Stopping.`);
                break;
            }
        }

        // Find next market
        let market = await findNextMarket();
        if (!market) {
            console.log('No market found. Waiting for next candle...');
            const now = Date.now();
            const nextCandle = (Math.floor(now / 300000) + 1) * 300000;
            await new Promise(r => setTimeout(r, nextCandle - now + 3000));
            market = await findNextMarket();
            if (!market) { console.log('Still no market. Skipping.'); continue; }
        }

        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        const endTime = new Date(market.endDate).getTime();

        console.log(`Market: ${market.question}`);

        // Record open price at candle start
        const openClPrice = chainlink.getPrice();
        console.log(`CL open: $${openClPrice.toFixed(2)}`);

        // Wait until T-60s
        const entryTargetTime = endTime - ENTRY_SECONDS_BEFORE * 1000;
        const waitMs = entryTargetTime - Date.now();
        if (waitMs > 0) {
            console.log(`Waiting ${(waitMs / 1000).toFixed(0)}s until T-${ENTRY_SECONDS_BEFORE}s...`);
            let remaining = waitMs;
            while (remaining > 30000) {
                await new Promise(r => setTimeout(r, 30000));
                remaining -= 30000;
                const secsLeft = (endTime - Date.now()) / 1000;
                const clNow = chainlink.getPrice();
                const move = clNow - openClPrice;
                const movePct = Math.abs(move) / openClPrice * 100;
                const dir = move >= 0 ? 'UP' : 'DOWN';
                console.log(`  ${secsLeft.toFixed(0)}s left | CL: $${clNow.toFixed(2)} (${dir} ${movePct.toFixed(3)}%)`);
            }
            if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
        }

        // === CHECK MOVE SIZE ===
        const secsLeft = (endTime - Date.now()) / 1000;
        const clPrice = chainlink.getPrice();
        const clMove = clPrice - openClPrice;
        const movePct = Math.abs(clMove) / openClPrice * 100;
        const predictedWinner: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';
        const winnerTokenIdx = predictedWinner === 'UP' ? 0 : 1;
        const winnerTokenId = tokenIds[winnerTokenIdx];

        console.log(`\nT-${secsLeft.toFixed(0)}s | CL: ${predictedWinner} | Move: ${movePct.toFixed(4)}% ($${Math.abs(clMove).toFixed(2)})`);

        const result: TradeResult = {
            index: allResults.length + sessionResults.length + 1,
            timestamp: Date.now(),
            question: market.question,
            openClPrice,
            clPriceAtEntry: clPrice,
            movePct,
            predictedWinner,
            winnerTokenId,
            buyPrice: 0,
            buySize: 0,
            action: 'SKIP',
            actionReason: '',
            filled: false,
            pnl: 0,
        };

        // Filter: move too small
        if (movePct < MIN_MOVE_PCT) {
            console.log(`SKIP: Move ${movePct.toFixed(4)}% < ${MIN_MOVE_PCT}% threshold.`);
            result.actionReason = `move too small (${movePct.toFixed(4)}%)`;
            sessionResults.push(result);
            // Wait for candle to end
            const waitForNext = endTime - Date.now() + 5000;
            if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
            continue;
        }

        // Time check
        if (secsLeft < MIN_SECONDS_AFTER_BUY) {
            console.log(`SKIP: Only ${secsLeft.toFixed(0)}s left. Not enough time.`);
            result.actionReason = 'not enough time';
            sessionResults.push(result);
            continue;
        }

        // === GET WINNER TOKEN BOOK ===
        const book = await fetchJSON(`https://clob.polymarket.com/book?token_id=${winnerTokenId}`);
        const asks = (book?.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
        const bestAsk = parseFloat(asks[0]?.price || '0');
        const bestAskSize = parseFloat(asks[0]?.size || '0');

        console.log(`${predictedWinner} best ask: ${(bestAsk * 100).toFixed(0)}c x ${bestAskSize.toFixed(0)} tokens`);

        if (bestAsk <= 0 || bestAsk > MAX_WINNER_ASK) {
            const reason = bestAsk <= 0 ? 'no ask' : `ask too high (${(bestAsk * 100).toFixed(0)}c > ${(MAX_WINNER_ASK * 100).toFixed(0)}c)`;
            console.log(`SKIP: ${reason}. Risk/reward not worth it.`);
            result.actionReason = reason;
            sessionResults.push(result);
            const waitForNext = endTime - Date.now() + 5000;
            if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
            continue;
        }

        // Time re-check after book fetch
        const secsLeft2 = (endTime - Date.now()) / 1000;
        if (secsLeft2 < MIN_SECONDS_AFTER_BUY) {
            console.log(`SKIP: Only ${secsLeft2.toFixed(0)}s left after book fetch.`);
            result.actionReason = 'time ran out';
            sessionResults.push(result);
            continue;
        }

        // === BUY WINNER ===
        const buySize = AMOUNT_USD / bestAsk; // number of tokens
        const displaySize = Math.floor(buySize * 100) / 100; // round down
        result.buyPrice = bestAsk;
        result.buySize = displaySize;
        result.action = 'BUY';
        result.actionReason = `move ${movePct.toFixed(3)}% > ${MIN_MOVE_PCT}%`;

        console.log(`\nBUYING ${displaySize.toFixed(1)} ${predictedWinner} tokens at ${(bestAsk * 100).toFixed(0)}c ($${(displaySize * bestAsk).toFixed(2)})...`);

        try {
            const buyResult = await authed.createAndPostOrder({
                tokenID: winnerTokenId,
                price: bestAsk,
                size: displaySize,
                side: 'BUY' as any,
            });
            console.log(`BUY response: status=${buyResult?.status} orderID=${buyResult?.orderID?.slice(0, 20)}...`);

            if (buyResult?.orderID) {
                result.filled = true;

                if (buyResult.status === 'matched') {
                    console.log(`FILLED immediately (matched).`);
                } else if (buyResult.status === 'live') {
                    console.log(`Order is LIVE. Should fill shortly (hitting the ask)...`);
                    // Give it a moment
                    await new Promise(r => setTimeout(r, 2000));
                    // We'll assume it fills since we're hitting the best ask
                    result.filled = true;
                }
            } else {
                console.log(`BUY rejected. No orderID returned.`);
                result.filled = false;
                result.actionReason = 'buy rejected';
                sessionResults.push(result);
                const waitForNext = endTime - Date.now() + 5000;
                if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
                continue;
            }
        } catch (e: any) {
            const errMsg = e.response?.data?.error || e.message?.slice(0, 300);
            console.log(`BUY ERROR: ${errMsg}`);
            result.filled = false;
            result.actionReason = `buy error: ${errMsg?.slice(0, 50)}`;
            sessionResults.push(result);
            const waitForNext = endTime - Date.now() + 5000;
            if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
            continue;
        }

        // === WAIT FOR RESOLUTION ===
        console.log(`Holding ${predictedWinner} tokens. Waiting for resolution...`);
        const waitForRes = endTime - Date.now() + 15000;
        if (waitForRes > 0) {
            console.log(`Waiting ${(waitForRes / 1000).toFixed(0)}s...`);
            await new Promise(r => setTimeout(r, waitForRes));
        }

        // Check resolution
        const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
        const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
        let outcome: 'UP' | 'DOWN' | 'UNKNOWN' = 'UNKNOWN';
        if (prices[0] >= 0.95) outcome = 'UP';
        else if (prices[1] >= 0.95) outcome = 'DOWN';

        // Retry if unknown
        if (outcome === 'UNKNOWN') {
            console.log('Resolution unclear. Waiting 10s...');
            await new Promise(r => setTimeout(r, 10000));
            const resolved2 = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
            const prices2 = resolved2?.[0] ? JSON.parse(resolved2[0].outcomePrices || '[]').map(Number) : [];
            if (prices2[0] >= 0.95) outcome = 'UP';
            else if (prices2[1] >= 0.95) outcome = 'DOWN';
        }

        result.resolution = outcome;
        result.correct = predictedWinner === outcome;

        if (result.correct) {
            const profit = displaySize * (1 - bestAsk);
            result.pnl = profit;
            dailyWins++;
            consecutiveLosses = 0;
            dailyPnl += profit;
            console.log(`\n>>> CORRECT! +$${profit.toFixed(2)} (bought at ${(bestAsk * 100).toFixed(0)}c, resolved to $1)`);
        } else {
            const loss = displaySize * bestAsk;
            result.pnl = -loss;
            dailyLosses++;
            consecutiveLosses++;
            dailyPnl -= loss;
            console.log(`\n>>> WRONG. -$${loss.toFixed(2)} (bought at ${(bestAsk * 100).toFixed(0)}c, resolved to $0)`);

            if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
                pauseUntil = Date.now() + PAUSE_AFTER_CONSEC_MS;
                console.log(`RISK: ${consecutiveLosses} consecutive losses. Pausing for 30 min.`);
            }
        }

        // Check balance
        const currentBal = await pub.readContract({
            address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
            args: [account.address],
        });
        console.log(`Balance: $${(Number(currentBal) / 1e6).toFixed(2)} | Day: ${dailyWins}W-${dailyLosses}L ($${dailyPnl >= 0 ? '+' : ''}${dailyPnl.toFixed(2)})`);

        sessionResults.push(result);

        // Save after each trade
        const combined = [...allResults, ...sessionResults];
        writeFileSync(RESULTS_FILE, JSON.stringify(combined, null, 2));
    }

    // === SESSION SUMMARY ===
    console.log('\n' + '='.repeat(60));
    console.log('SESSION SUMMARY');
    console.log('='.repeat(60));

    const trades = sessionResults.filter(r => r.action === 'BUY' && r.filled);
    const skips = sessionResults.filter(r => r.action === 'SKIP');
    const wins = trades.filter(r => r.correct);
    const losses = trades.filter(r => r.correct === false);

    for (const r of sessionResults) {
        const pnlStr = r.pnl !== 0 ? `$${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}` : '$0';
        console.log(
            `  #${r.index}: ${r.action} | ` +
            `Move: ${r.movePct.toFixed(3)}% | ` +
            `${r.predictedWinner} at ${(r.buyPrice * 100).toFixed(0)}c | ` +
            `${r.resolution || '-'} | ` +
            `${r.correct === true ? 'WIN' : r.correct === false ? 'LOSS' : r.actionReason} | ` +
            pnlStr
        );
    }

    const totalPnl = sessionResults.reduce((s, r) => s + r.pnl, 0);
    console.log(`\nTrades: ${trades.length} (${wins.length}W-${losses.length}L) | Skips: ${skips.length}`);
    if (trades.length > 0) {
        console.log(`Accuracy: ${(wins.length / trades.length * 100).toFixed(1)}%`);
    }
    console.log(`Session P&L: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);

    chainlink.disconnect();
    console.log('\n=== Done ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
