/**
 * Approve the Polymarket Exchange contract to spend USDC.e, then test an order.
 */
import 'dotenv/config';
import { createWalletClient, createPublicClient, http, parseAbi, maxUint256 } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`;
const CONDITIONAL_TOKENS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;

const erc20Abi = parseAbi([
    'function approve(address spender, uint256 amount) returns (bool)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function balanceOf(address account) view returns (uint256)',
]);

const ctAbi = parseAbi([
    'function setApprovalForAll(address operator, bool approved)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

async function main() {
    const pk = process.env.POLYMARKET_PRIVATE_KEY2! as `0x${string}`;
    const account = privateKeyToAccount(pk);
    console.log('EOA:', account.address);

    const publicClient = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    const walletClient = createWalletClient({ account, chain: polygon, transport: http('https://polygon.drpc.org') });

    // Check current allowance
    const currentAllowance = await publicClient.readContract({
        address: USDC_E, abi: erc20Abi, functionName: 'allowance',
        args: [account.address, EXCHANGE]
    });
    console.log('Current USDC.e allowance for Exchange:', currentAllowance.toString());

    const balance = await publicClient.readContract({
        address: USDC_E, abi: erc20Abi, functionName: 'balanceOf',
        args: [account.address]
    });
    console.log('USDC.e balance:', (Number(balance) / 1e6).toFixed(2));

    // Step 1: Approve Exchange to spend USDC.e (unlimited)
    if (currentAllowance < BigInt(1e12)) {
        console.log('\n--- Approving Exchange for USDC.e (unlimited) ---');
        const hash1 = await walletClient.writeContract({
            address: USDC_E, abi: erc20Abi, functionName: 'approve',
            args: [EXCHANGE, maxUint256]
        });
        console.log('Tx:', hash1);
        const receipt1 = await publicClient.waitForTransactionReceipt({ hash: hash1 });
        console.log('Status:', receipt1.status);
    } else {
        console.log('Exchange already approved');
    }

    // Step 2: Approve NegRisk Exchange too
    const negRiskAllowance = await publicClient.readContract({
        address: USDC_E, abi: erc20Abi, functionName: 'allowance',
        args: [account.address, NEG_RISK_EXCHANGE]
    });
    if (negRiskAllowance < BigInt(1e12)) {
        console.log('\n--- Approving NegRisk Exchange for USDC.e ---');
        const hash2 = await walletClient.writeContract({
            address: USDC_E, abi: erc20Abi, functionName: 'approve',
            args: [NEG_RISK_EXCHANGE, maxUint256]
        });
        console.log('Tx:', hash2);
        const receipt2 = await publicClient.waitForTransactionReceipt({ hash: hash2 });
        console.log('Status:', receipt2.status);
    }

    // Step 3: Approve Conditional Tokens for both exchanges
    for (const [name, addr] of [['Exchange', EXCHANGE], ['NegRisk', NEG_RISK_EXCHANGE]] as const) {
        const approved = await publicClient.readContract({
            address: CONDITIONAL_TOKENS, abi: ctAbi, functionName: 'isApprovedForAll',
            args: [account.address, addr]
        });
        if (!approved) {
            console.log(`\n--- Approving ${name} for Conditional Tokens ---`);
            const hash = await walletClient.writeContract({
                address: CONDITIONAL_TOKENS, abi: ctAbi, functionName: 'setApprovalForAll',
                args: [addr, true]
            });
            console.log('Tx:', hash);
            const receipt = await publicClient.waitForTransactionReceipt({ hash: hash });
            console.log('Status:', receipt.status);
        } else {
            console.log(`${name} already approved for Conditional Tokens`);
        }
    }

    console.log('\n=== All approvals done. Testing order... ===\n');

    // Step 4: Test order
    const ethersWallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, ethersWallet);
    const creds = await client.createOrDeriveApiKey();
    const apiKey = (creds as any).key;

    const authed = new ClobClient(
        'https://clob.polymarket.com', 137, ethersWallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        0 // EOA mode
    );

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

    if (!market) { console.log('No market'); return; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    console.log('Market:', market.question);

    try {
        const result = await authed.createAndPostOrder({
            tokenID: tokenIds[0],
            price: 0.01,
            size: 15,
            side: 'BUY' as any,
        });
        console.log('Result:', JSON.stringify(result).slice(0, 300));

        if (result?.orderID) {
            console.log('ORDER PLACED SUCCESSFULLY!');
            await authed.cancelOrder(result.orderID);
            console.log('Order cancelled.');
        } else if (result?.error) {
            console.log('Error:', result.error);
        } else {
            await authed.cancelAll();
        }
    } catch (e: any) {
        console.error('Failed:', e.response?.data?.error || e.message?.slice(0, 200));
    }

    console.log('\n=== Done ===');
}

main().catch(e => console.error('Fatal:', e));
