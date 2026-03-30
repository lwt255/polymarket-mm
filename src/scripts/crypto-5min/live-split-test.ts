/**
 * Live Split Straddle Test — Bulletproofed
 *
 * Executes the split straddle strategy on live 5-min BTC markets:
 *   1. Wait for a new candle to start
 *   2. At T-30s: Split $AMOUNT USDC into UP + DOWN tokens on-chain
 *   3. At T-20s: Check Chainlink direction + loser bid
 *   4. SAFETY CHECKS before selling:
 *      - Loser bid must be ≤30c (otherwise merge back)
 *      - CL move must exist (not exactly 0)
 *      - Must be before candle end (don't sell into resolved market)
 *      - Must have enough bid size
 *   5. After selling: VERIFY fill status
 *      - If filled (matched): hold winner to resolution
 *      - If NOT filled (live): cancel order + merge back = break even
 *   6. If anything fails at any point: merge back to USDC
 *
 * LOSS SCENARIOS (only 1 should exist):
 *   - CL prediction was wrong AND sell filled = ~$88-94 loss on $100
 *   - Everything else = break even (merge back) or skip
 *
 * Run: npx tsx src/scripts/crypto-5min/live-split-test.ts [numCandles] [amountUSD]
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainlinkFeed } from './chainlink-feed.js';

// Contracts
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;

const usdcAbi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
]);

const ctAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
]);

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
const PARTITION = [1n, 2n];
const GAMMA = 'https://gamma-api.polymarket.com';

// === SAFETY PARAMETERS ===
const MAX_LOSER_BID = 0.30;       // Skip if loser bid > 30c (market too uncertain)
const MIN_BID_SIZE_RATIO = 0.5;   // Need at least 50% of our size in bid depth
const MIN_SECONDS_BEFORE_END = 5; // Don't sell if less than 5s before candle end
const FILL_CHECK_DELAY_MS = 3000; // Wait 3s then verify fill
const FILL_CHECK_RETRIES = 3;     // Check fill status up to 3 times

interface CandleResult {
    index: number;
    question: string;
    splitAmount: number;
    openClPrice: number;
    clPriceAtSell: number;
    clDirection: 'UP' | 'DOWN';
    clMoveDollars: number;
    loserSide: string;
    loserBid: number;
    loserBidSize: number;
    action: 'SELL' | 'MERGE' | 'SKIP';
    actionReason: string;
    sellFilled: boolean;
    sellFilledAmount: number;
    sellResult?: any;
    sellError?: string;
    mergeResult?: string;
    resolution?: string;
    pnl: number;
    gasUsed?: string;
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

// Merge back tokens — the universal safety net
async function mergeBack(
    walletClient: any, pub: any, account: any,
    conditionId: `0x${string}`, tokenIds: string[],
    reason: string
): Promise<{ success: boolean; amount: number }> {
    console.log(`  MERGE-BACK: ${reason}`);
    try {
        const upBal = await pub.readContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
            args: [account.address, BigInt(tokenIds[0])],
        });
        const downBal = await pub.readContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
            args: [account.address, BigInt(tokenIds[1])],
        });
        const mergeAmt = upBal < downBal ? upBal : downBal;

        if (mergeAmt === 0n) {
            console.log(`  No tokens to merge (UP: ${Number(upBal)/1e6}, DOWN: ${Number(downBal)/1e6})`);
            return { success: false, amount: 0 };
        }

        console.log(`  Merging ${(Number(mergeAmt) / 1e6).toFixed(2)} pairs...`);
        const mergeTx = await walletClient.writeContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'mergePositions',
            args: [USDC_ADDRESS, ZERO_BYTES32, conditionId, PARTITION, mergeAmt],
        });
        await pub.waitForTransactionReceipt({ hash: mergeTx });
        console.log(`  Merged successfully. USDC recovered.`);
        return { success: true, amount: Number(mergeAmt) / 1e6 };
    } catch (e: any) {
        console.log(`  Merge FAILED: ${e.message?.slice(0, 200)}`);
        return { success: false, amount: 0 };
    }
}

async function main() {
    const NUM_CANDLES = parseInt(process.argv[2] || '3');
    const AMOUNT_USD = parseInt(process.argv[3] || '10');
    const SPLIT_AMOUNT = BigInt(AMOUNT_USD) * 1_000_000n;

    console.log(`=== Live Split Straddle Test (Bulletproofed) ===`);
    console.log(`Candles: ${NUM_CANDLES} | Amount: $${AMOUNT_USD}/candle`);
    console.log(`Safety: max loser bid ≤${MAX_LOSER_BID * 100}c | min ${MIN_SECONDS_BEFORE_END}s before end | fill verification ON`);
    console.log();

    // Setup wallet
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 as `0x${string}`;
    if (!privateKey) { console.log('Need POLYMARKET_PRIVATE_KEY2'); return; }

    const account = privateKeyToAccount(privateKey);
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    const walletClient = createWalletClient({
        account, chain: polygon,
        transport: http('https://polygon.drpc.org'),
    });

    console.log(`Wallet: ${account.address}`);

    // Check balance
    const balance = await pub.readContract({
        address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
        args: [account.address],
    });
    console.log(`USDC.e: $${(Number(balance) / 1e6).toFixed(2)}`);
    if (balance < SPLIT_AMOUNT) {
        console.log(`Need at least $${AMOUNT_USD}. Aborting.`);
        return;
    }

    // Check/set approvals
    const usdcAllowance = await pub.readContract({
        address: USDC_ADDRESS, abi: usdcAbi, functionName: 'allowance',
        args: [account.address, CT_ADDRESS],
    });
    if (usdcAllowance < SPLIT_AMOUNT * 100n) {
        console.log('Approving USDC for CTF...');
        const tx = await walletClient.writeContract({
            address: USDC_ADDRESS, abi: usdcAbi, functionName: 'approve',
            args: [CT_ADDRESS, SPLIT_AMOUNT * 10000n],
        });
        await pub.waitForTransactionReceipt({ hash: tx });
        console.log('Approved.');
    }

    const ctApproved = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'isApprovedForAll',
        args: [account.address, EXCHANGE],
    });
    if (!ctApproved) {
        console.log('Approving CT for Exchange...');
        const tx = await walletClient.writeContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'setApprovalForAll',
            args: [EXCHANGE, true],
        });
        await pub.waitForTransactionReceipt({ hash: tx });
        console.log('Approved.');
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

    const results: CandleResult[] = [];

    for (let i = 0; i < NUM_CANDLES; i++) {
        console.log(`\n${'='.repeat(50)}`);
        console.log(`--- Candle ${i + 1}/${NUM_CANDLES} ---`);

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
        const conditionId = market.conditionId as `0x${string}`;
        const endTime = new Date(market.endDate).getTime();

        console.log(`Market: ${market.question}`);
        console.log(`Condition: ${conditionId.slice(0, 20)}...`);

        // Record open price
        const openClPrice = chainlink.getPrice();
        console.log(`CL open: $${openClPrice.toFixed(2)}`);

        // Wait until T-30s to split
        const splitTargetTime = endTime - 30000;
        const waitMs = splitTargetTime - Date.now();
        if (waitMs > 0) {
            console.log(`Waiting ${(waitMs / 1000).toFixed(0)}s until T-30s...`);
            let remaining = waitMs;
            while (remaining > 30000) {
                await new Promise(r => setTimeout(r, 30000));
                remaining -= 30000;
                const secsLeft = (endTime - Date.now()) / 1000;
                const clNow = chainlink.getPrice();
                const move = clNow - openClPrice;
                const dir = move >= 0 ? 'UP' : 'DOWN';
                console.log(`  ${secsLeft.toFixed(0)}s left | CL: $${clNow.toFixed(2)} (${dir} $${Math.abs(move).toFixed(1)})`);
            }
            if (remaining > 0) await new Promise(r => setTimeout(r, remaining));
        }

        // === SAFETY CHECK 1: Is there enough time? ===
        const preCheckSecs = (endTime - Date.now()) / 1000;
        if (preCheckSecs < 15) {
            console.log(`SAFETY: Only ${preCheckSecs.toFixed(0)}s left. Not enough time to split+sell. Skipping.`);
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: chainlink.getPrice(), clDirection: 'UP',
                clMoveDollars: 0, loserSide: 'N/A', loserBid: 0, loserBidSize: 0,
                action: 'SKIP', actionReason: 'not enough time', sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === STEP 1: SPLIT ===
        const secsBeforeSplit = (endTime - Date.now()) / 1000;
        console.log(`\nSPLITTING $${AMOUNT_USD} at T-${secsBeforeSplit.toFixed(0)}s...`);

        let splitSuccess = false;
        try {
            const splitTx = await walletClient.writeContract({
                address: CT_ADDRESS, abi: ctAbi, functionName: 'splitPosition',
                args: [USDC_ADDRESS, ZERO_BYTES32, conditionId, PARTITION, SPLIT_AMOUNT],
            });
            const receipt = await pub.waitForTransactionReceipt({ hash: splitTx });
            const splitTime = (endTime - Date.now()) / 1000;
            console.log(`Split confirmed at T-${splitTime.toFixed(0)}s (gas: ${receipt.gasUsed})`);
            splitSuccess = true;
        } catch (e: any) {
            console.log(`Split FAILED: ${e.message?.slice(0, 200)}`);
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: chainlink.getPrice(), clDirection: 'UP',
                clMoveDollars: 0, loserSide: 'N/A', loserBid: 0, loserBidSize: 0,
                action: 'SKIP', actionReason: 'split failed', sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === SAFETY CHECK 2: Did the split take too long? ===
        const postSplitSecs = (endTime - Date.now()) / 1000;
        if (postSplitSecs < MIN_SECONDS_BEFORE_END) {
            console.log(`SAFETY: Split took too long. Only ${postSplitSecs.toFixed(0)}s left. Merging back.`);
            await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'split too slow');
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: chainlink.getPrice(), clDirection: 'UP',
                clMoveDollars: 0, loserSide: 'N/A', loserBid: 0, loserBidSize: 0,
                action: 'MERGE', actionReason: 'split too slow — merged back', sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === STEP 2: CHECK CL DIRECTION ===
        const secsLeft = (endTime - Date.now()) / 1000;
        const clPrice = chainlink.getPrice();
        const clMove = clPrice - openClPrice;
        const clDirection: 'UP' | 'DOWN' = clMove >= 0 ? 'UP' : 'DOWN';
        const loserSide = clDirection === 'UP' ? 'DOWN' : 'UP';
        const loserTokenIdx = clDirection === 'UP' ? 1 : 0;
        const loserTokenId = tokenIds[loserTokenIdx];
        const winnerTokenId = tokenIds[loserTokenIdx === 0 ? 1 : 0];

        console.log(`\nT-${secsLeft.toFixed(0)}s | CL: ${clDirection} ($${Math.abs(clMove).toFixed(1)} move)`);
        console.log(`Predicted loser: ${loserSide}`);

        // === SAFETY CHECK 3: CL move is exactly 0 ===
        if (clMove === 0) {
            console.log(`SAFETY: CL move is exactly $0. No direction signal. Merging back.`);
            await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'no CL signal');
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: clPrice, clDirection, clMoveDollars: clMove,
                loserSide, loserBid: 0, loserBidSize: 0,
                action: 'MERGE', actionReason: 'CL move = $0', sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === STEP 3: CHECK LOSER BOOK ===
        const book = await fetchJSON(`https://clob.polymarket.com/book?token_id=${loserTokenId}`);
        const bids = (book?.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestBidSize = parseFloat(bids[0]?.size || '0');

        console.log(`${loserSide} best bid: ${(bestBid * 100).toFixed(0)}c x ${bestBidSize.toFixed(0)} tokens`);

        // === SAFETY CHECK 4: Loser bid too high (market uncertain) ===
        if (bestBid > MAX_LOSER_BID) {
            console.log(`SAFETY: Loser bid ${(bestBid * 100).toFixed(0)}c > ${MAX_LOSER_BID * 100}c limit. Market too uncertain. Merging back.`);
            await mergeBack(walletClient, pub, account, conditionId, tokenIds, `bid ${(bestBid*100).toFixed(0)}c > ${MAX_LOSER_BID*100}c`);
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: clPrice, clDirection, clMoveDollars: clMove,
                loserSide, loserBid: bestBid, loserBidSize: bestBidSize,
                action: 'MERGE', actionReason: `bid too high (${(bestBid*100).toFixed(0)}c)`, sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === SAFETY CHECK 5: No bid or bid too small ===
        if (bestBid <= 0 || bestBidSize < AMOUNT_USD * MIN_BID_SIZE_RATIO) {
            const reason = bestBid <= 0 ? 'no bid' : `bid size ${bestBidSize.toFixed(0)} < ${AMOUNT_USD * MIN_BID_SIZE_RATIO}`;
            console.log(`SAFETY: ${reason}. Merging back.`);
            await mergeBack(walletClient, pub, account, conditionId, tokenIds, reason);
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: clPrice, clDirection, clMoveDollars: clMove,
                loserSide, loserBid: bestBid, loserBidSize: bestBidSize,
                action: 'MERGE', actionReason: reason, sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === SAFETY CHECK 6: Time check again (book fetch took time) ===
        const preTradeSecsLeft = (endTime - Date.now()) / 1000;
        if (preTradeSecsLeft < MIN_SECONDS_BEFORE_END) {
            console.log(`SAFETY: Only ${preTradeSecsLeft.toFixed(0)}s left after book check. Merging back.`);
            await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'time ran out after book check');
            results.push({
                index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
                openClPrice, clPriceAtSell: clPrice, clDirection, clMoveDollars: clMove,
                loserSide, loserBid: bestBid, loserBidSize: bestBidSize,
                action: 'MERGE', actionReason: 'time ran out', sellFilled: false,
                sellFilledAmount: 0, pnl: 0,
            });
            continue;
        }

        // === STEP 4: SELL LOSER ===
        const sellSize = Number(SPLIT_AMOUNT) / 1e6;
        console.log(`\nSELLING ${sellSize} ${loserSide} at ${(bestBid * 100).toFixed(0)}c...`);

        const result: CandleResult = {
            index: i + 1, question: market.question, splitAmount: AMOUNT_USD,
            openClPrice, clPriceAtSell: clPrice, clDirection, clMoveDollars: clMove,
            loserSide, loserBid: bestBid, loserBidSize: bestBidSize, action: 'SELL',
            actionReason: 'all checks passed', sellFilled: false, sellFilledAmount: 0, pnl: 0,
        };

        let orderID: string | null = null;

        try {
            const sellResult = await authed.createAndPostOrder({
                tokenID: loserTokenId,
                price: bestBid,
                size: sellSize,
                side: 'SELL' as any,
            });
            console.log(`SELL response: status=${sellResult?.status} orderID=${sellResult?.orderID?.slice(0, 20)}...`);
            result.sellResult = sellResult;
            orderID = sellResult?.orderID || null;

            if (!orderID) {
                // Order wasn't even accepted
                console.log(`SAFETY: No orderID returned. Sell rejected. Merging back.`);
                await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'sell rejected — no orderID');
                result.action = 'MERGE';
                result.actionReason = 'sell rejected';
                results.push(result);
                continue;
            }

            // === STEP 5: VERIFY FILL ===
            if (sellResult?.status === 'matched') {
                // Taker fill — matched immediately
                const filledAmt = parseFloat(sellResult.takingAmount || '0');
                console.log(`FILLED IMMEDIATELY (matched). Got $${filledAmt.toFixed(4)}`);
                result.sellFilled = true;
                result.sellFilledAmount = filledAmt;
            } else if (sellResult?.status === 'live') {
                // Order is resting — NOT filled yet
                console.log(`Order is LIVE (not filled). Checking for fill...`);

                let filled = false;
                let filledAmount = 0;

                for (let retry = 0; retry < FILL_CHECK_RETRIES; retry++) {
                    await new Promise(r => setTimeout(r, FILL_CHECK_DELAY_MS));

                    // Check if we still hold the loser tokens
                    const loserBal = await pub.readContract({
                        address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
                        args: [account.address, BigInt(loserTokenId)],
                    });
                    const expectedTokens = Number(SPLIT_AMOUNT);
                    const currentTokens = Number(loserBal);

                    if (currentTokens < expectedTokens * 0.5) {
                        // Tokens are gone — order filled
                        filledAmount = (expectedTokens - currentTokens) / 1e6;
                        filled = true;
                        console.log(`  Check ${retry + 1}: FILLED (balance dropped). ~${filledAmount.toFixed(2)} tokens sold.`);
                        break;
                    } else {
                        console.log(`  Check ${retry + 1}: NOT filled (still hold ${(currentTokens/1e6).toFixed(2)} loser tokens)`);
                    }

                    // Check time — if candle is about to end, cancel and merge
                    const timeLeft = (endTime - Date.now()) / 1000;
                    if (timeLeft < 2) {
                        console.log(`  Time running out (${timeLeft.toFixed(1)}s). Stopping fill checks.`);
                        break;
                    }
                }

                if (filled) {
                    result.sellFilled = true;
                    result.sellFilledAmount = filledAmount * bestBid; // approximate revenue
                } else {
                    // NOT filled — cancel order and merge back
                    console.log(`\nSAFETY: Order NOT filled. Cancelling and merging back.`);

                    // Cancel the order
                    try {
                        await authed.cancelOrder({ orderID } as any);
                        console.log(`  Order cancelled.`);
                    } catch (cancelErr: any) {
                        console.log(`  Cancel failed (may already be expired): ${cancelErr.message?.slice(0, 100)}`);
                    }

                    // Small delay for cancel to settle
                    await new Promise(r => setTimeout(r, 1000));

                    // Merge back
                    const mergeResult = await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'sell not filled');
                    result.action = 'MERGE';
                    result.actionReason = 'sell not filled — merged back';
                    result.mergeResult = mergeResult.success ? `merged ${mergeResult.amount}` : 'merge failed';
                    result.pnl = 0; // break even (minus gas)
                    results.push(result);

                    // Wait for next candle
                    const waitForNext = endTime - Date.now() + 5000;
                    if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
                    continue;
                }
            } else {
                // Unknown status — treat as failed
                console.log(`SAFETY: Unknown sell status "${sellResult?.status}". Merging back.`);
                await mergeBack(walletClient, pub, account, conditionId, tokenIds, `unknown status: ${sellResult?.status}`);
                result.action = 'MERGE';
                result.actionReason = `unknown sell status: ${sellResult?.status}`;
                results.push(result);
                continue;
            }

        } catch (e: any) {
            const errMsg = e.response?.data?.error || e.message?.slice(0, 300);
            console.log(`SELL ERROR: ${errMsg}`);
            result.sellError = errMsg;

            // Sell failed — merge back everything
            console.log('SAFETY: Sell failed. Merging back...');
            const mergeResult = await mergeBack(walletClient, pub, account, conditionId, tokenIds, 'sell error');
            result.action = 'MERGE';
            result.actionReason = `sell error — ${errMsg?.slice(0, 50)}`;
            result.mergeResult = mergeResult.success ? `merged ${mergeResult.amount}` : 'merge failed';
            result.pnl = 0;
            results.push(result);

            // Wait for candle to end before next
            const waitForNext = endTime - Date.now() + 5000;
            if (waitForNext > 0) await new Promise(r => setTimeout(r, waitForNext));
            continue;
        }

        // === STEP 6: SELL FILLED — WAIT FOR RESOLUTION ===
        console.log(`\n*** SELL CONFIRMED (filled) ***`);
        console.log(`Holding ${loserSide === 'DOWN' ? 'UP' : 'DOWN'} tokens. Waiting for resolution...`);
        results.push(result);

        const waitForRes = endTime - Date.now() + 15000;
        if (waitForRes > 0) {
            console.log(`Waiting ${(waitForRes / 1000).toFixed(0)}s for resolution...`);
            await new Promise(r => setTimeout(r, waitForRes));
        }

        // Check resolution
        const resolved = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
        const prices = resolved?.[0] ? JSON.parse(resolved[0].outcomePrices || '[]').map(Number) : [];
        let outcome = 'UNKNOWN';
        if (prices[0] >= 0.95) outcome = 'UP';
        else if (prices[1] >= 0.95) outcome = 'DOWN';

        // Retry resolution check if unknown
        if (outcome === 'UNKNOWN') {
            console.log('Resolution unclear. Waiting 10s and retrying...');
            await new Promise(r => setTimeout(r, 10000));
            const resolved2 = await fetchJSON(`${GAMMA}/markets?slug=${market.slug}`);
            const prices2 = resolved2?.[0] ? JSON.parse(resolved2[0].outcomePrices || '[]').map(Number) : [];
            if (prices2[0] >= 0.95) outcome = 'UP';
            else if (prices2[1] >= 0.95) outcome = 'DOWN';
        }

        result.resolution = outcome;

        const wasCorrect = clDirection === outcome;
        if (wasCorrect) {
            // We sold the loser correctly, winner resolves to $1
            const revenue = result.sellFilled ? (bestBid * AMOUNT_USD) : 0;
            result.pnl = revenue; // profit = what we got for loser tokens
            console.log(`\n>>> CORRECT! Profit: $${revenue.toFixed(2)} (sold loser at ${(bestBid * 100).toFixed(0)}c)`);
        } else {
            // We sold the winner, loser resolves to $0
            const revenue = result.sellFilled ? (bestBid * AMOUNT_USD) : 0;
            result.pnl = revenue - AMOUNT_USD; // loss = revenue - amount
            console.log(`\n>>> WRONG! Loss: $${(AMOUNT_USD - revenue).toFixed(2)} (sold winner at ${(bestBid * 100).toFixed(0)}c)`);
        }

        // Final balance
        const finalBal = await pub.readContract({
            address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
            args: [account.address],
        });
        console.log(`Balance: $${(Number(finalBal) / 1e6).toFixed(2)}`);
    }

    // === SUMMARY ===
    console.log('\n' + '='.repeat(60));
    console.log('LIVE TEST SUMMARY');
    console.log('='.repeat(60));
    for (const r of results) {
        const pnlStr = `$${r.pnl >= 0 ? '+' : ''}${r.pnl.toFixed(2)}`;
        console.log(`  ${r.index}: ${r.action} (${r.actionReason}) | CL: ${r.clDirection} ($${Math.abs(r.clMoveDollars).toFixed(0)}) | Bid: ${(r.loserBid * 100).toFixed(0)}c | Filled: ${r.sellFilled} | ${r.resolution || '?'} | P&L: ${pnlStr}`);
    }

    const sells = results.filter(r => r.action === 'SELL' && r.sellFilled);
    const merges = results.filter(r => r.action === 'MERGE');
    const skips = results.filter(r => r.action === 'SKIP');
    const totalPnl = results.reduce((s, r) => s + r.pnl, 0);

    console.log(`\nFilled sells: ${sells.length} | Merges: ${merges.length} | Skips: ${skips.length}`);
    console.log(`Total P&L: $${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}`);

    // Verify no unexpected losses
    const unexpectedLosses = results.filter(r => r.pnl < -1 && r.action !== 'SELL');
    if (unexpectedLosses.length > 0) {
        console.log(`\n!!! WARNING: ${unexpectedLosses.length} unexpected losses detected on non-SELL actions!`);
        for (const u of unexpectedLosses) {
            console.log(`  Candle ${u.index}: ${u.action} (${u.actionReason}) P&L: $${u.pnl.toFixed(2)}`);
        }
    }

    chainlink.disconnect();
    console.log('\n=== Test Complete ===');
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
