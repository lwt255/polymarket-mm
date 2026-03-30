/**
 * Manual test: try to SELL the DOWN tokens we're currently holding from the failed exit.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EOA = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156' as `0x${string}`;
const ctAbi = parseAbi([
    'function balanceOf(address account, uint256 id) view returns (uint256)',
    'function isApprovedForAll(address owner, address operator) view returns (bool)',
]);
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const NEG_RISK = '0xC5d563A36AE78145C45a50134d48A1215220f80a' as `0x${string}`;

async function main() {
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

    // Find the most recent markets and check token balances
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    console.log('=== Checking all recent token balances ===\n');

    let foundToken: string | null = null;
    let foundBalance = 0n;
    let foundName = '';

    for (const offset of [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400]) {
        const ts = rounded - offset;
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0) {
            const m = data[0];
            const tokenIds = JSON.parse(m.clobTokenIds || '[]');
            for (let i = 0; i < tokenIds.length; i++) {
                const bal = await pub.readContract({
                    address: CT, abi: ctAbi, functionName: 'balanceOf',
                    args: [EOA, BigInt(tokenIds[i])]
                });
                if (bal > 0n) {
                    const label = i === 0 ? 'UP' : 'DOWN';
                    console.log(`${m.question} — ${label}: ${(Number(bal) / 1e6).toFixed(2)} tokens`);
                    console.log(`  Token ID: ${tokenIds[i]}`);
                    if (!foundToken) {
                        foundToken = tokenIds[i];
                        foundBalance = bal;
                        foundName = `${label} (${m.question})`;
                    }
                }
            }
        }
    }

    if (!foundToken) {
        console.log('No tokens found in wallet.');
        return;
    }

    // Check approvals
    console.log('\n=== Approvals ===');
    const approvedExchange = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'isApprovedForAll', args: [EOA, EXCHANGE] });
    const approvedNegRisk = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'isApprovedForAll', args: [EOA, NEG_RISK] });
    console.log('Exchange approved:', approvedExchange);
    console.log('NegRisk approved:', approvedNegRisk);

    // Try to sell
    console.log(`\n=== Attempting SELL of ${foundName} ===`);
    console.log(`Token: ${foundToken}`);
    console.log(`Balance: ${(Number(foundBalance) / 1e6).toFixed(2)}`);

    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

    // Check order book for this token
    const book = await authed.getOrderBook(foundToken);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    console.log(`Best bid: ${bids[0]?.price || 'none'} (size: ${bids[0]?.size || 0})`);

    if (bids.length === 0) {
        console.log('No bids — cannot sell');
        return;
    }

    const sellSize = Number(foundBalance) / 1e6;
    const bestBid = parseFloat(bids[0].price);
    console.log(`\nSelling ${sellSize} tokens at ${bestBid}...`);

    try {
        const result = await authed.createAndPostOrder({
            tokenID: foundToken,
            price: bestBid,
            size: sellSize,
            side: 'SELL' as any,
        });
        console.log('Result:', JSON.stringify(result).slice(0, 500));
    } catch (e: any) {
        console.log('SELL error:', e.response?.data || e.message?.slice(0, 200));
    }
}

main().catch(e => console.error('Fatal:', e));
