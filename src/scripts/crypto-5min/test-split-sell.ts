/**
 * Test: Can CTF-split tokens be IMMEDIATELY sold on the CLOB?
 *
 * This is the critical test for the split straddle strategy.
 * The CLOB settlement delay blocks selling tokens bought via CLOB orders.
 * But tokens from an on-chain CTF split are in your wallet atomically.
 *
 * Steps:
 *   1. Find a current 5-min market
 *   2. Call CTF splitPosition on-chain: $5 USDC -> 5 UP + 5 NO tokens
 *   3. IMMEDIATELY try to place a SELL order on the CLOB
 *   4. If it works: the split straddle strategy is viable
 *   5. Merge the tokens back to recover USDC (or let market resolve)
 *
 * IMPORTANT: negRisk=false for 5-min markets, so we use the CTF contract
 * directly (not the NegRiskAdapter).
 *
 * CTF splitPosition:
 *   splitPosition(IERC20 collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint[] partition, uint amount)
 *
 * SMALL TEST: Only $5 at risk (5 token pairs).
 *
 * Run: npx tsx src/scripts/crypto-5min/test-split-sell.ts
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// Contract addresses (Polygon mainnet)
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;

// ABIs
const usdcAbi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
]);

const ctAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
    'function setApprovalForAll(address operator, bool approved)',
    // Standard CTF splitPosition (negRisk=false markets use this directly)
    'function splitPosition(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
    'function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount)',
]);

const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
const PARTITION = [1n, 2n]; // Binary market: outcome 0 = [1], outcome 1 = [2]

async function main() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 as `0x${string}`;
    if (!privateKey) {
        console.log('Need POLYMARKET_PRIVATE_KEY2 in .env');
        return;
    }

    const account = privateKeyToAccount(privateKey);
    console.log(`Wallet: ${account.address}`);

    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http('https://polygon.drpc.org'),
    });

    // Find current market
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let market: any = null;
    for (const ts of [rounded, rounded + 300]) {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
            market = data[0]; break;
        }
    }
    if (!market) { console.log('No active market. Try again.'); return; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const conditionId = market.conditionId as `0x${string}`;
    console.log(`\nMarket: ${market.question}`);
    console.log(`negRisk: ${market.negRisk}`);
    console.log(`Condition ID: ${conditionId}`);
    console.log(`UP token: ${tokenIds[0]?.slice(0, 40)}...`);
    console.log(`DOWN token: ${tokenIds[1]?.slice(0, 40)}...`);

    if (!conditionId) {
        console.log('No conditionId. Aborting.');
        return;
    }

    // Check USDC balance
    const usdcBalance = await pub.readContract({
        address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
        args: [account.address],
    });
    console.log(`\nUSDC balance: ${(Number(usdcBalance) / 1e6).toFixed(2)} USDC`);

    const SPLIT_AMOUNT = 5_000_000n; // $5 USDC = 5 token pairs

    if (usdcBalance < SPLIT_AMOUNT) {
        console.log(`Need at least $${Number(SPLIT_AMOUNT) / 1e6} USDC. Have $${(Number(usdcBalance) / 1e6).toFixed(2)}. Aborting.`);
        return;
    }

    // Step 1: Check/set USDC approval for CTF contract
    const allowance = await pub.readContract({
        address: USDC_ADDRESS, abi: usdcAbi, functionName: 'allowance',
        args: [account.address, CT_ADDRESS],
    });
    console.log(`USDC allowance for CTF: ${(Number(allowance) / 1e6).toFixed(2)}`);

    if (allowance < SPLIT_AMOUNT) {
        console.log('Approving USDC spend for CTF...');
        const approveTx = await walletClient.writeContract({
            address: USDC_ADDRESS, abi: usdcAbi, functionName: 'approve',
            args: [CT_ADDRESS, SPLIT_AMOUNT * 1000n], // Approve extra for future
        });
        console.log(`Approve tx: ${approveTx}`);
        await pub.waitForTransactionReceipt({ hash: approveTx });
        console.log('Approved.');
    }

    // Step 2: Check CT approval for Exchange (needed for SELL orders)
    const ctApprovedExchange = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'isApprovedForAll',
        args: [account.address, EXCHANGE],
    });
    console.log(`CT approved for Exchange: ${ctApprovedExchange}`);
    if (!ctApprovedExchange) {
        console.log('Approving CT for Exchange...');
        const tx = await walletClient.writeContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'setApprovalForAll',
            args: [EXCHANGE, true],
        });
        await pub.waitForTransactionReceipt({ hash: tx });
        console.log('Approved.');
    }

    // Step 3: Check token balances BEFORE split
    const upBefore = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
        args: [account.address, BigInt(tokenIds[0])],
    });
    const downBefore = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
        args: [account.address, BigInt(tokenIds[1])],
    });
    console.log(`\nBefore split:`);
    console.log(`  UP tokens: ${(Number(upBefore) / 1e6).toFixed(2)}`);
    console.log(`  DOWN tokens: ${(Number(downBefore) / 1e6).toFixed(2)}`);

    // Step 4: SPLIT $5 USDC -> 5 UP + 5 DOWN via CTF directly
    console.log(`\n--- Splitting $${Number(SPLIT_AMOUNT) / 1e6} USDC into token pairs ---`);
    console.log(`  CTF contract: ${CT_ADDRESS}`);
    console.log(`  Collateral: ${USDC_ADDRESS}`);
    console.log(`  ConditionId: ${conditionId}`);
    console.log(`  Partition: [1, 2]`);
    console.log(`  Amount: ${SPLIT_AMOUNT.toString()}`);

    const splitStart = Date.now();
    try {
        const splitTx = await walletClient.writeContract({
            address: CT_ADDRESS,
            abi: ctAbi,
            functionName: 'splitPosition',
            args: [USDC_ADDRESS, ZERO_BYTES32, conditionId, PARTITION, SPLIT_AMOUNT],
        });
        console.log(`Split tx: ${splitTx}`);
        const receipt = await pub.waitForTransactionReceipt({ hash: splitTx });
        const splitTime = Date.now() - splitStart;
        console.log(`Split confirmed in ${splitTime}ms (block ${receipt.blockNumber}, gas: ${receipt.gasUsed})`);
    } catch (e: any) {
        console.log(`Split FAILED: ${e.message?.slice(0, 300)}`);
        return;
    }

    // Step 5: Verify token balances AFTER split
    const upAfter = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
        args: [account.address, BigInt(tokenIds[0])],
    });
    const downAfter = await pub.readContract({
        address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
        args: [account.address, BigInt(tokenIds[1])],
    });
    console.log(`\nAfter split:`);
    console.log(`  UP tokens: ${(Number(upAfter) / 1e6).toFixed(2)} (+${(Number(upAfter - upBefore) / 1e6).toFixed(2)})`);
    console.log(`  DOWN tokens: ${(Number(downAfter) / 1e6).toFixed(2)} (+${(Number(downAfter - downBefore) / 1e6).toFixed(2)})`);

    // Step 6: IMMEDIATELY try to sell DOWN token on CLOB
    console.log(`\n--- Attempting IMMEDIATE SELL on CLOB (0ms delay) ---`);
    const sellStart = Date.now();

    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

    // Get DOWN book
    const book = await authed.getOrderBook(tokenIds[1]);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    console.log(`DOWN best bid: ${(bestBid * 100).toFixed(0)}c`);

    if (bestBid <= 0) {
        console.log('No bids on DOWN token. Trying UP token instead...');
        const upBook = await authed.getOrderBook(tokenIds[0]);
        const upBids = (upBook.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const upBestBid = parseFloat(upBids[0]?.price || '0');
        console.log(`UP best bid: ${(upBestBid * 100).toFixed(0)}c`);
    }

    const sellSize = Number(SPLIT_AMOUNT) / 1e6;
    console.log(`Selling ${sellSize} DOWN at ${bestBid} (taker)...`);

    try {
        const result = await authed.createAndPostOrder({
            tokenID: tokenIds[1],
            price: bestBid,
            size: sellSize,
            side: 'SELL' as any,
        });
        const sellTime = Date.now() - sellStart;
        console.log(`\n*** SELL RESULT (${sellTime}ms after split confirmed): ***`);
        console.log(JSON.stringify(result, null, 2));

        if (result?.orderID) {
            console.log('\n========================================');
            console.log('SUCCESS! CTF split tokens CAN be immediately sold on CLOB!');
            console.log('The split straddle strategy IS viable!');
            console.log('========================================');
        } else if (result?.error) {
            console.log(`\nSELL returned error: ${result.error}`);
        }
    } catch (e: any) {
        const sellTime = Date.now() - sellStart;
        console.log(`\nSELL FAILED after ${sellTime}ms:`);
        console.log('Error:', e.response?.data?.error || e.message?.slice(0, 300));

        // Try with a delay
        console.log('\n--- Retrying with 5s delay ---');
        await new Promise(r => setTimeout(r, 5000));
        try {
            const result2 = await authed.createAndPostOrder({
                tokenID: tokenIds[1],
                price: bestBid,
                size: sellSize,
                side: 'SELL' as any,
            });
            console.log('Delayed sell result:', JSON.stringify(result2, null, 2));
        } catch (e2: any) {
            console.log('Delayed sell also failed:', e2.response?.data?.error || e2.message?.slice(0, 200));

            // Try with 30s delay
            console.log('\n--- Retrying with 30s delay ---');
            await new Promise(r => setTimeout(r, 25000));
            try {
                const result3 = await authed.createAndPostOrder({
                    tokenID: tokenIds[1],
                    price: bestBid,
                    size: sellSize,
                    side: 'SELL' as any,
                });
                console.log('30s delayed sell result:', JSON.stringify(result3, null, 2));
            } catch (e3: any) {
                console.log('30s delayed sell failed:', e3.response?.data?.error || e3.message?.slice(0, 200));
            }
        }
    }

    // Step 7: Try to merge remaining tokens back to USDC
    console.log('\n--- Cleanup: Merging remaining tokens ---');
    try {
        const upFinal = await pub.readContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
            args: [account.address, BigInt(tokenIds[0])],
        });
        const downFinal = await pub.readContract({
            address: CT_ADDRESS, abi: ctAbi, functionName: 'balanceOf',
            args: [account.address, BigInt(tokenIds[1])],
        });
        const mergeAmount = upFinal < downFinal ? upFinal : downFinal;
        console.log(`UP: ${(Number(upFinal) / 1e6).toFixed(2)}, DOWN: ${(Number(downFinal) / 1e6).toFixed(2)}, merge: ${(Number(mergeAmount) / 1e6).toFixed(2)}`);

        if (mergeAmount > 0n) {
            const mergeTx = await walletClient.writeContract({
                address: CT_ADDRESS,
                abi: ctAbi,
                functionName: 'mergePositions',
                args: [USDC_ADDRESS, ZERO_BYTES32, conditionId, PARTITION, mergeAmount],
            });
            const receipt = await pub.waitForTransactionReceipt({ hash: mergeTx });
            console.log(`Merged ${(Number(mergeAmount) / 1e6).toFixed(2)} pairs. Tx: ${mergeTx}`);

            const usdcFinal = await pub.readContract({
                address: USDC_ADDRESS, abi: usdcAbi, functionName: 'balanceOf',
                args: [account.address],
            });
            console.log(`USDC balance after merge: ${(Number(usdcFinal) / 1e6).toFixed(2)}`);
        }
    } catch (e: any) {
        console.log(`Merge failed: ${e.message?.slice(0, 200)}`);
        console.log('Tokens will resolve at market end.');
    }

    console.log('\n=== Test Complete ===');
}

main().catch(e => console.error('Fatal:', e));
