/**
 * Sell ALL conditional tokens we're currently holding.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EOA = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156' as `0x${string}`;
const ctAbi = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);

async function main() {
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    for (const offset of [0, 300, 600, 900, 1200, 1500, 1800, 2100, 2400, 2700, 3000, 3600, 4200, 4800]) {
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
                    const size = Number(bal) / 1e6;
                    console.log(`Found ${label}: ${size.toFixed(2)} tokens — ${m.question}`);

                    const book = await authed.getOrderBook(tokenIds[i]);
                    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
                    if (bids.length > 0) {
                        const bestBid = parseFloat(bids[0].price);
                        console.log(`  Best bid: ${bestBid}, selling ${size.toFixed(6)}...`);
                        try {
                            const result = await authed.createAndPostOrder({
                                tokenID: tokenIds[i], price: bestBid, size, side: 'SELL' as any,
                            });
                            const value = bestBid * size;
                            console.log(`  SOLD for ~$${value.toFixed(2)} — ${result?.success ? 'SUCCESS' : result?.error || JSON.stringify(result).slice(0, 100)}`);
                        } catch (e: any) {
                            console.log(`  SELL failed:`, e.response?.data?.error || e.message?.slice(0, 100));
                        }
                    } else {
                        console.log('  No bids in book — cannot sell');
                    }
                }
            }
        }
    }

    console.log('\nDone.');
}

main().catch(e => console.error('Fatal:', e));
