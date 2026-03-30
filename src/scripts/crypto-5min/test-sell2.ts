/**
 * Debug: Check conditional token balance and approval, then try SELL again.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`;
const EOA = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156' as `0x${string}`;

const ctAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);

async function main() {
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

    // Find current market to get token IDs
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let market: any = null;
    for (const ts of [rounded, rounded + 300, rounded - 300]) {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0) { market = data[0]; break; }
    }

    if (!market) { console.log('No market'); return; }
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    console.log('Market:', market.question);
    console.log('UP token ID:', tokenIds[0]);

    // Check conditional token approval
    const approvedExchange = await pub.readContract({
        address: CT, abi: ctAbi, functionName: 'isApprovedForAll',
        args: [EOA, EXCHANGE]
    });
    const approvedNegRisk = await pub.readContract({
        address: CT, abi: ctAbi, functionName: 'isApprovedForAll',
        args: [EOA, NEG_RISK_EXCHANGE]
    });
    console.log('\nConditional Token approvals:');
    console.log('  Exchange:', approvedExchange);
    console.log('  NegRisk:', approvedNegRisk);

    // Check conditional token balance for UP token
    const upTokenBigInt = BigInt(tokenIds[0]);
    const balance = await pub.readContract({
        address: CT, abi: ctAbi, functionName: 'balanceOf',
        args: [EOA, upTokenBigInt]
    });
    console.log(`\nUP token balance: ${balance.toString()} (${(Number(balance) / 1e6).toFixed(2)} tokens)`);

    // If we have tokens, try to SELL
    if (balance > 0n) {
        console.log('\nAttempting SELL...');
        const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
        const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
        const creds = await client.createOrDeriveApiKey();
        const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
            { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

        const book = await authed.getOrderBook(tokenIds[0]);
        const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const bestBid = parseFloat(bids[0]?.price || '0');
        console.log('Best bid:', bestBid);

        const sellSize = Number(balance) / 1e6;
        console.log(`Selling ${sellSize} tokens at ${bestBid}...`);

        try {
            const result = await authed.createAndPostOrder({
                tokenID: tokenIds[0],
                price: bestBid,
                size: sellSize,
                side: 'SELL' as any,
            });
            console.log('Result:', JSON.stringify(result).slice(0, 300));
        } catch (e: any) {
            console.log('SELL failed:', e.response?.data?.error || e.message?.slice(0, 150));
        }
    } else {
        console.log('\nNo tokens to sell (may have already resolved or not settled yet).');
    }

    console.log('\nDone.');
}

main().catch(e => console.error('Fatal:', e));
