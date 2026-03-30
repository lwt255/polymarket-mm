import 'dotenv/config';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const EOA = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156' as `0x${string}`;
const ctAbi = parseAbi(['function balanceOf(address account, uint256 id) view returns (uint256)']);

async function main() {
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    console.log('=== Recent Market Resolutions ===\n');
    for (const offset of [300, 600, 900, 1200, 1500]) {
        const ts = rounded - offset;
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0) {
            const m = data[0];
            const prices = JSON.parse(m.outcomePrices || '[]');
            const tokenIds = JSON.parse(m.clobTokenIds || '[]');
            console.log(`${m.question}`);
            console.log(`  Outcome: UP=${prices[0]} DOWN=${prices[1]} | Volume: $${parseFloat(m.volume || '0').toFixed(0)}`);

            // Check token balances
            for (let i = 0; i < tokenIds.length; i++) {
                const bal = await pub.readContract({
                    address: CT, abi: ctAbi, functionName: 'balanceOf',
                    args: [EOA, BigInt(tokenIds[i])]
                });
                if (bal > 0n) {
                    console.log(`  ** ${i === 0 ? 'UP' : 'DOWN'} token balance: ${(Number(bal) / 1e6).toFixed(2)} tokens **`);
                }
            }
            console.log('');
        }
    }
}

main().catch(e => console.error('Fatal:', e));
