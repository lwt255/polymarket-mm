/**
 * Redeem all winning positions from resolved Polymarket markets.
 *
 * Winning conditional tokens sit in the wallet until manually redeemed.
 * This script finds all unredeemed positions and redeems them for USDC.e.
 *
 * ARCHITECTURE NOTES (from CTF Exchange source code analysis):
 * - For EOA wallets using signature type 0, CLOB trades settle via
 *   CTFExchange.matchOrders() which transfers conditional tokens
 *   DIRECTLY to the taker's EOA (takerOrder.maker address).
 * - Tokens are NOT held by the exchange contract after settlement.
 * - Redemption calls redeemPositions() on the CTF contract (0x4D97...6045).
 * - The CTF contract burns tokens and sends USDC.e to the caller (msg.sender).
 * - The collateral is USDC.e (bridged), NOT native USDC.
 *
 * COMMON FAILURE MODES:
 * 1. Wrong wallet — redeem script uses different key than trading bot
 * 2. Market not yet resolved on-chain (Gamma says resolved but oracle hasn't called reportPayouts)
 * 3. Zero token balance (tokens never arrived or already redeemed)
 * 4. Wrong conditionId (Gamma API returns stale data)
 *
 * This script includes full diagnostics to identify the exact issue.
 *
 * Usage: npx tsx src/scripts/redeem-winnings.ts
 *        npx tsx src/scripts/redeem-winnings.ts --dry-run
 *        npx tsx src/scripts/redeem-winnings.ts --diagnose   (deep diagnostics only, no redeem)
 */

import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

// --- Contract Addresses (Polygon) ---
// Conditional Tokens Framework (ERC1155 holding outcome tokens)
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
// USDC.e (bridged) — this is what Polymarket uses as collateral
const USDC_E_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
// CTF Exchange — settles CLOB trades for regular (non-negRisk) binary markets
const CTF_EXCHANGE_ADDRESS = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
// NegRisk CTF Exchange — settles CLOB trades for neg risk multi-outcome markets
const NEG_RISK_CTF_EXCHANGE_ADDRESS = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`;
// NegRisk Adapter — wraps CTF for neg risk markets
const NEG_RISK_ADAPTER_ADDRESS = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296' as `0x${string}`;

const GAMMA = 'https://gamma-api.polymarket.com';
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;

// --- ABIs ---
const ctAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
    'function getConditionId(address oracle, bytes32 questionId, uint256 outcomeSlotCount) pure returns (bytes32)',
    'event PayoutRedemption(address indexed redeemer, address indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)',
]);

const erc20Abi = parseAbi([
    'function balanceOf(address account) view returns (uint256)',
    'function decimals() view returns (uint8)',
]);

const erc1155Abi = parseAbi([
    'function isApprovedForAll(address account, address operator) view returns (bool)',
]);

// --- CLI Flags ---
const DRY_RUN = process.argv.includes('--dry-run');
const DIAGNOSE = process.argv.includes('--diagnose');

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) return null;
    return resp.json();
}

interface MarketInfo {
    slug: string;
    conditionId: `0x${string}`;
    questionID: string;
    outcomes: string[];
    outcomePrices: number[];
    clobTokenIds: string[];
    negRisk: boolean;
    umaResolutionStatus: string;
}

async function main() {
    // ---- Load private key (try multiple env var names) ----
    const privateKey =
        process.env.EVM_WALLET_PRIVATE_KEY2 ||
        process.env.POLYMARKET_PRIVATE_KEY2 ||
        process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) {
        console.error('No private key found. Set EVM_WALLET_PRIVATE_KEY2 or POLYMARKET_PRIVATE_KEY in .env');
        process.exit(1);
    }

    const formattedKey = (privateKey.trim().startsWith('0x') ? privateKey.trim() : `0x${privateKey.trim()}`) as `0x${string}`;
    const account = privateKeyToAccount(formattedKey);
    console.log(`Wallet: ${account.address}`);
    console.log(`Mode: ${DIAGNOSE ? 'DIAGNOSE (deep diagnostics only)' : DRY_RUN ? 'DRY RUN (no transactions)' : 'LIVE (will send transactions)'}\n`);

    const publicClient = createPublicClient({
        chain: polygon,
        transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'),
    });

    const walletClient = createWalletClient({
        account,
        chain: polygon,
        transport: http(process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com'),
    });

    // ---- Check USDC.e balance ----
    const usdcBefore = await publicClient.readContract({
        address: USDC_E_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
    });
    console.log(`USDC.e balance: $${(Number(usdcBefore) / 1e6).toFixed(6)}`);

    // Also check native USDC for comparison
    const nativeUSDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359' as `0x${string}`;
    try {
        const nativeBalance = await publicClient.readContract({
            address: nativeUSDC,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [account.address],
        });
        console.log(`Native USDC balance: $${(Number(nativeBalance) / 1e6).toFixed(6)}`);
    } catch { /* native USDC check is informational only */ }

    // Check MATIC/POL balance for gas
    const maticBalance = await publicClient.getBalance({ address: account.address });
    console.log(`POL balance: ${(Number(maticBalance) / 1e18).toFixed(4)} POL`);
    if (maticBalance < 10000000000000000n) { // < 0.01 POL
        console.warn('WARNING: Low POL balance for gas fees!\n');
    }
    console.log('');

    // ---- Collect market slugs from trade logs ----
    const slugsToCheck = new Set<string>();

    // From underdog-trades.jsonl (the main live trade log)
    for (const logFile of ['underdog-trades.jsonl', 'underdog-snipe-trades.jsonl']) {
        try {
            const { readFileSync } = await import('node:fs');
            const lines = readFileSync(logFile, 'utf-8').trim().split('\n');
            for (const line of lines) {
                try {
                    const t = JSON.parse(line);
                    // Only check live trades (not dry-run simulations)
                    if (t.slug && t.orderID && t.orderID !== 'dry-run') {
                        slugsToCheck.add(t.slug);
                    }
                } catch {}
            }
        } catch {}
    }

    // Hardcoded known live trades as fallback
    const knownLiveSlugs = [
        'btc-updown-5m-1774159800',
        'btc-updown-15m-1774161900',
        'xrp-updown-15m-1774226700',
        'btc-updown-5m-1774229400',
        'btc-updown-5m-1774230600',
        'eth-updown-5m-1774233000',
        'xrp-updown-15m-1774235700',
        'btc-updown-5m-1774237200',
        'xrp-updown-5m-1774240800',
        'btc-updown-5m-1774242900',
        'btc-updown-15m-1774248300',
        'xrp-updown-5m-1774250100',
    ];
    for (const s of knownLiveSlugs) slugsToCheck.add(s);

    console.log(`Checking ${slugsToCheck.size} markets for unredeemed tokens...\n`);

    // ---- Fetch market data and check balances ----
    interface RedeemCandidate {
        slug: string;
        conditionId: `0x${string}`;
        negRisk: boolean;
        tokenBalances: { tokenId: string; outcome: string; balance: bigint; isWinner: boolean }[];
        payoutDenom: bigint;
        payoutNums: bigint[];
        value: number;
    }

    const candidates: RedeemCandidate[] = [];

    for (const slug of slugsToCheck) {
        try {
            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (!data || data.length === 0) {
                console.log(`  SKIP ${slug}: not found in Gamma API`);
                continue;
            }

            const market = data[0];
            const conditionId = market.conditionId as `0x${string}`;
            if (!conditionId) {
                console.log(`  SKIP ${slug}: no conditionId`);
                continue;
            }

            const tokenIds: string[] = JSON.parse(market.clobTokenIds || '[]');
            const outcomes: string[] = JSON.parse(market.outcomes || '[]');
            const outcomePrices: number[] = JSON.parse(market.outcomePrices || '[]').map(Number);
            const negRisk: boolean = market.negRisk === true || market.negRisk === 'true';
            const umaStatus: string = market.umaResolutionStatus || '';

            // ---- Check on-chain resolution via payoutDenominator ----
            let payoutDenom = 0n;
            let payoutNums: bigint[] = [];
            try {
                payoutDenom = await publicClient.readContract({
                    address: CT_ADDRESS,
                    abi: ctAbi,
                    functionName: 'payoutDenominator',
                    args: [conditionId],
                });
                // Get payout numerators for each outcome
                for (let i = 0; i < outcomes.length; i++) {
                    const num = await publicClient.readContract({
                        address: CT_ADDRESS,
                        abi: ctAbi,
                        functionName: 'payoutNumerators',
                        args: [conditionId, BigInt(i)],
                    });
                    payoutNums.push(num);
                }
            } catch (err: any) {
                // payoutDenominator reverts if condition doesn't exist
                if (DIAGNOSE) console.log(`  DIAG ${slug}: payoutDenominator call failed — ${err.message?.slice(0, 80)}`);
            }

            const onChainResolved = payoutDenom > 0n;

            // ---- Check token balances ----
            const tokenBalances: RedeemCandidate['tokenBalances'] = [];
            let totalValue = 0;

            for (let i = 0; i < tokenIds.length; i++) {
                const tokenId = tokenIds[i];
                if (!tokenId) continue;

                const balance = await publicClient.readContract({
                    address: CT_ADDRESS,
                    abi: ctAbi,
                    functionName: 'balanceOf',
                    args: [account.address, BigInt(tokenId)],
                });

                // Also check if the exchange contract holds tokens (diagnostic)
                let exchangeBalance = 0n;
                if (DIAGNOSE) {
                    exchangeBalance = await publicClient.readContract({
                        address: CT_ADDRESS,
                        abi: ctAbi,
                        functionName: 'balanceOf',
                        args: [negRisk ? NEG_RISK_CTF_EXCHANGE_ADDRESS : CTF_EXCHANGE_ADDRESS, BigInt(tokenId)],
                    });
                }

                const outcome = outcomes[i] || `Outcome ${i}`;
                const isWinner = onChainResolved && payoutNums.length > i && payoutNums[i] > 0n;
                const shares = Number(balance) / 1e6;
                const value = isWinner ? shares * Number(payoutNums[i]) / Number(payoutDenom) : 0;

                if (balance > 0n || (DIAGNOSE && exchangeBalance > 0n)) {
                    tokenBalances.push({ tokenId, outcome, balance, isWinner });
                    totalValue += value;

                    const status = !onChainResolved ? 'NOT RESOLVED ON-CHAIN'
                        : isWinner ? `WINNER = $${value.toFixed(2)}`
                        : 'LOSER ($0)';

                    console.log(`  ${isWinner ? '+' : ' '} ${slug} | ${outcome}: ${shares.toFixed(6)} tokens | ${status}`);
                    if (DIAGNOSE) {
                        console.log(`    Gamma status: ${umaStatus} | prices: ${outcomePrices.join(', ')}`);
                        console.log(`    On-chain: payoutDenom=${payoutDenom}, payoutNums=[${payoutNums.join(', ')}]`);
                        console.log(`    EOA balance: ${balance} | Exchange balance: ${exchangeBalance}`);
                        console.log(`    negRisk: ${negRisk} | conditionId: ${conditionId}`);
                    }
                }
            }

            if (tokenBalances.length > 0 && onChainResolved) {
                candidates.push({
                    slug,
                    conditionId,
                    negRisk,
                    tokenBalances,
                    payoutDenom,
                    payoutNums,
                    value: totalValue,
                });
            } else if (tokenBalances.length === 0 && DIAGNOSE) {
                console.log(`  SKIP ${slug}: zero token balance in EOA | resolved=${onChainResolved} (${umaStatus})`);
            } else if (!onChainResolved && tokenBalances.length > 0) {
                console.log(`    ^ NOT YET RESOLVED ON-CHAIN (Gamma says: ${umaStatus})`);
            }
        } catch (err: any) {
            console.log(`  ERROR ${slug}: ${err.message?.slice(0, 100)}`);
        }
    }

    // ---- Summary ----
    const totalRedeemable = candidates.reduce((s, c) => s + c.value, 0);
    const winnerCount = candidates.filter(c => c.value > 0).length;
    console.log(`\nFound ${candidates.length} resolved positions with tokens (${winnerCount} with value)`);
    console.log(`Total redeemable value: $${totalRedeemable.toFixed(2)}`);

    if (candidates.length === 0) {
        console.log('\nNothing to redeem.');
        if (!DIAGNOSE) {
            console.log('Tip: Run with --diagnose for detailed analysis of why tokens may be missing.');
        }
        return;
    }

    if (DRY_RUN || DIAGNOSE) {
        console.log(`\n${DIAGNOSE ? 'DIAGNOSE' : 'DRY RUN'} mode — no transactions sent.`);
        return;
    }

    // ---- Execute redemptions ----
    console.log('\nRedeeming positions...\n');
    const redeemed = new Set<string>();
    let totalRecovered = 0;

    for (const candidate of candidates) {
        // Skip conditions we already redeemed (each conditionId only needs one redemption call)
        if (redeemed.has(candidate.conditionId)) continue;
        redeemed.add(candidate.conditionId);

        // Skip if no value (all losing tokens — redeem still burns them but yields $0)
        if (candidate.value === 0) {
            console.log(`  Skipping ${candidate.slug} (all losing tokens, $0 value)`);
            continue;
        }

        try {
            console.log(`  Redeeming ${candidate.slug}...`);
            console.log(`    conditionId: ${candidate.conditionId}`);
            console.log(`    negRisk: ${candidate.negRisk}`);
            console.log(`    expected value: $${candidate.value.toFixed(2)}`);

            // Check USDC.e balance before this specific redemption
            const balBefore = await publicClient.readContract({
                address: USDC_E_ADDRESS,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account.address],
            });

            // For non-negRisk binary markets: call redeemPositions on CTF directly
            // indexSets [1, 2] covers both outcomes for a binary market
            // The CTF contract will:
            //   1. Check payoutDenominator > 0 (market resolved)
            //   2. For each indexSet, compute payout based on payoutNumerators
            //   3. Burn the conditional tokens
            //   4. Transfer USDC.e collateral to msg.sender
            const hash = await walletClient.writeContract({
                address: CT_ADDRESS,
                abi: ctAbi,
                functionName: 'redeemPositions',
                args: [
                    USDC_E_ADDRESS,
                    ZERO_BYTES32,
                    candidate.conditionId,
                    [1n, 2n], // indexSets for binary market: outcome 0 = 1, outcome 1 = 2
                ],
            });

            console.log(`    TX: ${hash}`);

            // Wait for confirmation
            const receipt = await publicClient.waitForTransactionReceipt({ hash });
            console.log(`    Confirmed in block ${receipt.blockNumber} | gas: ${receipt.gasUsed}`);

            // Check if redemption event was emitted
            const redeemEvents = receipt.logs.filter(log => {
                try {
                    const decoded = decodeEventLog({
                        abi: ctAbi,
                        data: log.data,
                        topics: log.topics,
                    });
                    return decoded.eventName === 'PayoutRedemption';
                } catch { return false; }
            });

            if (redeemEvents.length > 0) {
                console.log(`    PayoutRedemption event found (${redeemEvents.length} events)`);
            } else {
                console.log(`    WARNING: No PayoutRedemption event in tx logs`);
            }

            // Check actual USDC.e change
            const balAfter = await publicClient.readContract({
                address: USDC_E_ADDRESS,
                abi: erc20Abi,
                functionName: 'balanceOf',
                args: [account.address],
            });

            const gained = Number(balAfter - balBefore) / 1e6;
            totalRecovered += gained;
            console.log(`    USDC.e gained: $${gained.toFixed(6)}`);

            if (gained === 0 && candidate.value > 0) {
                console.log(`    WARNING: Expected $${candidate.value.toFixed(2)} but got $0!`);
                console.log(`    This may indicate tokens were already redeemed or the condition is not properly resolved.`);
            }

            console.log('');
        } catch (err: any) {
            console.log(`    FAILED: ${err.message?.slice(0, 200)}`);
            console.log('');
        }
    }

    // ---- Final balance check ----
    const usdcAfter = await publicClient.readContract({
        address: USDC_E_ADDRESS,
        abi: erc20Abi,
        functionName: 'balanceOf',
        args: [account.address],
    });
    const totalGained = (Number(usdcAfter) - Number(usdcBefore)) / 1e6;
    console.log(`USDC.e balance after: $${(Number(usdcAfter) / 1e6).toFixed(6)}`);
    console.log(`Total recovered this run: $${totalGained.toFixed(6)}`);
    console.log(`Per-redemption total: $${totalRecovered.toFixed(6)}`);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
