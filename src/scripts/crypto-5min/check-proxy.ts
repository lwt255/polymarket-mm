/**
 * Check on-chain proxy wallets, USDC balances, and allowances for our EOAs.
 */
import 'dotenv/config';

const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const proxy = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1';
const eoa1 = '0xAfE78054F8917c49Fb5CfC6758627cBd5E8B4498';
const eoa2 = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156';

const RPCS = [
    'https://polygon.llamarpc.com',
    'https://rpc.ankr.com/polygon',
    'https://polygon.drpc.org',
];

let RPC = '';

async function findRpc() {
    for (const rpc of RPCS) {
        try {
            const r = await fetch(rpc, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] })
            });
            const d = await r.json() as any;
            if (d.result) { RPC = rpc; return; }
        } catch {}
    }
    throw new Error('No working RPC');
}

async function ethCall(to: string, data: string): Promise<string> {
    const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
    const d = await r.json() as any;
    return d.result || '0x';
}

async function ethRpc(method: string, params: any[]): Promise<any> {
    const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return ((await r.json()) as any).result;
}

async function main() {
    await findRpc();
    console.log('RPC:', RPC);

    // 1. USDC.e balances
    console.log('\n=== USDC.e Balances ===');
    for (const [n, a] of [['Proxy', proxy], ['EOA1', eoa1], ['EOA2', eoa2]]) {
        const r = await ethCall(USDC, '0x70a08231' + a.slice(2).toLowerCase().padStart(64, '0'));
        const bal = r.length >= 66 ? parseInt(r, 16) / 1e6 : 0;
        console.log(`${n} (${a.slice(0, 10)}...): $${bal.toFixed(2)}`);
    }

    // 2. Check if proxy is a contract
    console.log('\n=== Contract Check ===');
    const code = await ethRpc('eth_getCode', [proxy, 'latest']);
    console.log(`Proxy is contract: ${code && code !== '0x' ? 'YES' : 'NO (just an EOA)'}`);
    if (code && code !== '0x') {
        console.log(`  Code size: ${(code.length - 2) / 2} bytes`);
    }

    // 3. MATIC balances
    console.log('\n=== MATIC Balances ===');
    for (const [n, a] of [['Proxy', proxy], ['EOA1', eoa1], ['EOA2', eoa2]]) {
        const bal = await ethRpc('eth_getBalance', [a, 'latest']);
        console.log(`${n}: ${(parseInt(bal, 16) / 1e18).toFixed(4)} MATIC`);
    }

    // 4. Try Exchange.getPolyProxyWalletAddress(address)
    // Selector for getPolyProxyWalletAddress(address) = 0xedc17226
    console.log('\n=== Exchange Proxy Lookup ===');
    for (const [n, a] of [['EOA1', eoa1], ['EOA2', eoa2]]) {
        const r = await ethCall(EXCHANGE, '0xedc17226' + a.slice(2).toLowerCase().padStart(64, '0'));
        if (r.length >= 66) {
            const addr = '0x' + r.slice(26);
            const isZero = addr === '0x' + '0'.repeat(40);
            console.log(`${n} → ${isZero ? 'NO PROXY REGISTERED' : addr}`);
        } else {
            console.log(`${n} → call failed`);
        }
    }

    // 5. Allowances
    console.log('\n=== USDC.e Allowance for Exchange ===');
    for (const [n, owner] of [['Proxy', proxy], ['EOA1', eoa1], ['EOA2', eoa2]]) {
        // allowance(address,address) = 0xdd62ed3e
        const data = '0xdd62ed3e' + owner.slice(2).toLowerCase().padStart(64, '0') + EXCHANGE.slice(2).toLowerCase().padStart(64, '0');
        const r = await ethCall(USDC, data);
        if (r.length >= 66) {
            const val = BigInt(r);
            console.log(`${n} → Exchange: ${val > BigInt(1e18) ? 'UNLIMITED' : (Number(val) / 1e6).toFixed(2)}`);
        }
    }
}

main().catch(e => console.error('Fatal:', e));
