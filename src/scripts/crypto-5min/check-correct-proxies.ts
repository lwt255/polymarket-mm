/**
 * Check USDC balances and allowances on the correct proxy addresses.
 */
const RPC = 'https://polygon.drpc.org';
const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

const addresses = [
    ['Key1 proxy', '0xad393c46d82f99067cac74aa787edacf9e4b13ea'],
    ['Key2 proxy', '0x8e9d6af0626a3f77496c8551858109869b8180a7'],
    ['Mystery proxy', '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1'],
];

async function call(to: string, data: string): Promise<string> {
    const r = await fetch(RPC, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] })
    });
    return ((await r.json()) as any).result || '0x';
}

async function main() {
    console.log('=== USDC.e Balances ===');
    for (const [name, addr] of addresses) {
        const r = await call(USDC, '0x70a08231' + addr.slice(2).toLowerCase().padStart(64, '0'));
        const bal = r.length >= 66 ? parseInt(r, 16) / 1e6 : 0;
        console.log(`${name} (${addr.slice(0, 10)}...): $${bal.toFixed(2)}`);
    }

    console.log('\n=== USDC.e Allowance for Exchange ===');
    for (const [name, addr] of addresses) {
        const data = '0xdd62ed3e' + addr.slice(2).toLowerCase().padStart(64, '0') + EXCHANGE.slice(2).toLowerCase().padStart(64, '0');
        const r = await call(USDC, data);
        if (r.length >= 66) {
            const val = BigInt(r);
            const display = val > BigInt('1000000000000000000') ? 'UNLIMITED' : (Number(val) / 1e6).toFixed(2);
            console.log(`${name}: ${display}`);
        }
    }

    // Now try placing an order with Key 1 using its CORRECT proxy
    console.log('\n=== Testing Key 1 with correct proxy ===');
    const { ClobClient } = await import('@polymarket/clob-client');
    const { Wallet } = await import('@ethersproject/wallet');

    const pk1 = '0x48e484646c6da1ac13d3774cf4292bce9048324a9846eb06be798249904ccb58';
    const wallet = new Wallet(pk1);
    const correctProxy1 = '0xad393c46d82f99067cac74aa787edacf9e4b13ea';

    console.log(`EOA: ${wallet.address}`);
    console.log(`Correct proxy: ${correctProxy1}`);

    const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    const apiKey = (creds as any).key;
    console.log(`API key: ${apiKey?.slice(0, 12)}...`);

    // Try with POLY_PROXY (1) and the correct proxy
    const client = new ClobClient(
        'https://clob.polymarket.com', 137, wallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        1, // POLY_PROXY
        correctProxy1
    );

    // Find a market
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

    if (market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        console.log(`Market: ${market.question}`);

        try {
            const result = await client.createAndPostOrder({
                tokenID: tokenIds[0],
                price: 0.01,
                size: 15,
                side: 'BUY' as any,
            });
            console.log('Result:', JSON.stringify(result).slice(0, 300));
            if (result?.orderID) {
                await client.cancelOrder(result.orderID);
                console.log('ORDER PLACED AND CANCELLED SUCCESSFULLY');
            } else if (result?.error) {
                console.log('Error:', result.error);
            } else {
                await client.cancelAll();
            }
        } catch (e: any) {
            console.error('Failed:', e.response?.data?.error || e.message?.slice(0, 200));
        }
    }
}

main().catch(e => console.error('Fatal:', e));
