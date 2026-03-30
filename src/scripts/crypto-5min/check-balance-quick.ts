const RPC = 'https://polygon.drpc.org';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const EOA2 = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156';
const PROXY2 = '0x8e9d6af0626a3f77496c8551858109869b8180a7';

async function call(to: string, data: string): Promise<string> {
    const r = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
    return ((await r.json()) as any).result || '0x';
}

async function main() {
    for (const [name, addr] of [['EOA2', EOA2], ['Proxy2', PROXY2]]) {
        for (const [token, contract] of [['USDC.e', USDC], ['USDC', USDC_NATIVE]]) {
            const r = await call(contract, '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0'));
            const bal = r.length >= 66 ? parseInt(r, 16) / 1e6 : 0;
            console.log(`${name} ${token}: $${bal.toFixed(2)}`);
        }
    }
}
main();
