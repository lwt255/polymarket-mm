/**
 * Diagnose why redeems aren't paying out USDC
 */
import 'dotenv/config';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;
const PROXY = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1' as `0x${string}`;

const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

const ctAbi = parseAbi([
    'function balanceOf(address owner, uint256 id) view returns (uint256)',
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

async function main() {
    console.log('=== WALLET DIAGNOSIS ===\n');

    // Check all possible keys
    const keyNames = ['POLYMARKET_PRIVATE_KEY', 'POLYMARKET_PRIVATE_KEY2', 'EVM_WALLET_PRIVATE_KEY2'];
    for (const name of keyNames) {
        const pk = process.env[name];
        if (!pk) { console.log(`  ${name}: not set`); continue; }
        const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
        const account = privateKeyToAccount(key);
        const usdc = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [account.address] });
        console.log(`  ${name}: ${account.address} — $${(Number(usdc) / 1e6).toFixed(2)}`);
    }

    // Bot's wallet
    const botPk = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || '';
    const botKey = (botPk.startsWith('0x') ? botPk : `0x${botPk}`) as `0x${string}`;
    const botAddr = privateKeyToAccount(botKey).address;
    console.log(`\n  Bot wallet: ${botAddr}`);
    console.log(`  Proxy: ${PROXY}`);

    // Our confirmed winning markets
    const wins = [
        { slug: 'sol-updown-5m-1774812300', label: 'SOL DOWN @27¢ (session 3)', side: 1 },
        { slug: 'eth-updown-5m-1774813800', label: 'ETH UP @44¢ (session 3)', side: 0 },
        { slug: 'btc-updown-5m-1774753500', label: 'BTC UP @7¢ (session 1)', side: 0 },
        { slug: 'sol-updown-5m-1774753500', label: 'SOL UP @4¢ (session 1)', side: 0 },
    ];

    for (const win of wins) {
        console.log(`\n=== ${win.label} ===`);
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${win.slug}`);
        const data = await resp.json() as any[];
        if (!data?.[0]) { console.log('  Market not found'); continue; }

        const m = data[0];
        const conditionId = m.conditionId as `0x${string}`;
        const tokens = JSON.parse(m.clobTokenIds || '[]');
        const outcomes = JSON.parse(m.outcomes || '[]');
        const prices = JSON.parse(m.outcomePrices || '[]');

        console.log(`  Condition: ${conditionId}`);
        console.log(`  API prices: ${outcomes.map((o: string, i: number) => `${o}=${prices[i]}`).join(', ')}`);

        // On-chain resolution
        const den = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutDenominator', args: [conditionId] });
        console.log(`  On-chain resolved: ${Number(den) > 0 ? 'YES' : 'NO'}`);

        if (Number(den) > 0) {
            for (let i = 0; i < outcomes.length; i++) {
                const pn = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutNumerators', args: [conditionId, BigInt(i)] });
                console.log(`  ${outcomes[i]} payout: ${pn.toString()} ${Number(pn) > 0 ? '← WINNER' : ''}`);
            }
        }

        // Token balances on all addresses
        const addresses: Record<string, `0x${string}`> = {
            'Bot EOA': botAddr as `0x${string}`,
            'Proxy': PROXY,
            'Exchange': EXCHANGE,
        };

        let anyTokens = false;
        for (const [name, addr] of Object.entries(addresses)) {
            for (let i = 0; i < tokens.length; i++) {
                const bal = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'balanceOf', args: [addr, BigInt(tokens[i])] });
                const shares = Number(bal) / 1e6;
                if (shares > 0.001) {
                    console.log(`  ${name} holds ${outcomes[i]}: ${shares.toFixed(2)} shares ← UNREDEEMED`);
                    anyTokens = true;
                }
            }
        }
        if (!anyTokens) {
            console.log(`  No tokens found anywhere — already redeemed or never received`);
        }
    }
}

main().catch(e => console.error(e));
