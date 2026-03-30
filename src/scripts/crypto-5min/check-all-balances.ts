const RPC = 'https://polygon.drpc.org';
const USDC_E = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';

const addrs = [
    ['EOA2', '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156'],
    ['Proxy2', '0x8e9d6af0626a3f77496c8551858109869b8180a7'],
    ['Old proxy', '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1'],
    ['EOA1', '0xAfE78054F8917c49Fb5CfC6758627cBd5E8B4498'],
    ['Proxy1', '0xad393c46d82f99067cac74aa787edacf9e4b13ea'],
];

async function call(to: string, data: string): Promise<string> {
    const r = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
    return ((await r.json()) as any).result || '0x';
}

async function main() {
    console.log('Address                                      | USDC.e    | USDC');
    console.log('---------------------------------------------|-----------|----------');
    for (const [name, addr] of addrs) {
        const r1 = await call(USDC_E, '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0'));
        const r2 = await call(USDC, '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0'));
        const b1 = r1.length >= 66 ? (parseInt(r1, 16) / 1e6).toFixed(2) : '0.00';
        const b2 = r2.length >= 66 ? (parseInt(r2, 16) / 1e6).toFixed(2) : '0.00';
        console.log(`${(name + ' ' + addr).padEnd(45)}| $${b1.padStart(8)} | $${b2.padStart(8)}`);
    }
}
main();
