/**
 * Trace a specific trade end-to-end on-chain
 * Find: USDC out, token in, token burn, USDC back
 */
import 'dotenv/config';
import { createPublicClient, http, parseAbi, parseAbiItem } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const pk = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || '';
const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
const EOA = privateKeyToAccount(key).address;
const PROXY = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1' as `0x${string}`;
const POLY_PROXY = '0x8E9D6Af0626A3F77496c8551858109869b8180A7' as `0x${string}`;
const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E' as `0x${string}`;

const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

const usdcTransfer = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const ctTransferSingle = parseAbiItem('event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)');
const ctTransferBatch = parseAbiItem('event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)');
const payoutRedemption = parseAbiItem('event PayoutRedemption(address indexed redeemer, bytes32 indexed collateralToken, bytes32 indexed parentCollectionId, bytes32 conditionId, uint256[] indexSets, uint256 payout)');

async function checkAddress(label: string, addr: `0x${string}`, blockStart: bigint, blockEnd: bigint) {
    console.log(`\n--- ${label} (${addr.slice(0,12)}...) ---`);

    // USDC in
    try {
        const usdcIn = await pub.getLogs({ address: USDC, event: usdcTransfer, args: { to: addr }, fromBlock: blockStart, toBlock: blockEnd });
        for (const log of usdcIn) {
            console.log(`  USDC IN:  +$${(Number(log.args.value) / 1e6).toFixed(2)} from ${log.args.from?.slice(0,12)} block ${log.blockNumber}`);
        }
        if (usdcIn.length === 0) console.log('  USDC IN:  none');
    } catch { console.log('  USDC IN:  query failed'); }

    // USDC out
    try {
        const usdcOut = await pub.getLogs({ address: USDC, event: usdcTransfer, args: { from: addr }, fromBlock: blockStart, toBlock: blockEnd });
        for (const log of usdcOut) {
            console.log(`  USDC OUT: -$${(Number(log.args.value) / 1e6).toFixed(2)} to ${log.args.to?.slice(0,12)} block ${log.blockNumber}`);
        }
        if (usdcOut.length === 0) console.log('  USDC OUT: none');
    } catch { console.log('  USDC OUT: query failed'); }

    // CT tokens in
    try {
        const ctIn = await pub.getLogs({ address: CT, event: ctTransferSingle, args: { to: addr }, fromBlock: blockStart, toBlock: blockEnd });
        for (const log of ctIn) {
            console.log(`  CT IN:    ${(Number(log.args.value) / 1e6).toFixed(2)} shares (id:${log.args.id?.toString().slice(0,8)}...) from ${log.args.from?.slice(0,12)} block ${log.blockNumber}`);
        }
        if (ctIn.length === 0) console.log('  CT IN:    none');
    } catch { console.log('  CT IN:    query failed'); }

    // CT tokens out (including burns to 0x0)
    try {
        const ctOut = await pub.getLogs({ address: CT, event: ctTransferSingle, args: { from: addr }, fromBlock: blockStart, toBlock: blockEnd });
        for (const log of ctOut) {
            const isBurn = log.args.to === '0x0000000000000000000000000000000000000000';
            console.log(`  CT OUT:   ${(Number(log.args.value) / 1e6).toFixed(2)} shares ${isBurn ? 'BURNED (redeem)' : 'to ' + log.args.to?.slice(0,12)} block ${log.blockNumber}`);
        }
        if (ctOut.length === 0) console.log('  CT OUT:   none');
    } catch { console.log('  CT OUT:   query failed'); }
}

async function main() {
    const latest = await pub.getBlockNumber();
    // Session 3 was ~19:30-20:40 UTC = roughly 2-3 hours ago
    // At 2s/block, 3 hours = ~5400 blocks
    // Search in 2000-block chunks

    console.log('=== TRACING ALL ON-CHAIN ACTIVITY FOR ALL ADDRESSES ===');
    console.log(`Latest block: ${latest}`);
    console.log(`Searching last ~1 hour (1000 blocks)\n`);

    const blockEnd = latest;
    const blockStart = latest - 1000n;

    await checkAddress('EOA (bot wallet)', EOA as `0x${string}`, blockStart, blockEnd);
    await checkAddress('Gnosis Safe proxy', PROXY, blockStart, blockEnd);
    await checkAddress('Poly Proxy', POLY_PROXY, blockStart, blockEnd);
}

main().catch(e => console.error(e));
