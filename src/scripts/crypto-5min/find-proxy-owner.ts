/**
 * Find who owns/controls the Polymarket proxy wallet by reading on-chain storage.
 * The proxy delegates to an implementation contract, so storage belongs to the proxy.
 */
const RPC = 'https://polygon.drpc.org';
const PROXY = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1';
const EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a';
const IMPL = '0xe51abdf814f8854941b9fe8e3a4f65cab4e7a4a8';

async function rpcCall(method: string, params: any[]): Promise<any> {
    const r = await fetch(RPC, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
    });
    return ((await r.json()) as any).result;
}

async function ethCall(to: string, data: string): Promise<string> {
    return await rpcCall('eth_call', [{ to, data }, 'latest']) || '0x';
}

async function main() {
    console.log('=== Finding Proxy Owner ===\n');
    console.log('Proxy:', PROXY);
    console.log('Implementation:', IMPL);

    // Read several storage slots of the proxy
    console.log('\n--- Proxy Storage Slots ---');
    for (let i = 0; i < 10; i++) {
        const slot = '0x' + i.toString(16).padStart(64, '0');
        const val = await rpcCall('eth_getStorageAt', [PROXY, slot, 'latest']);
        if (val && val !== '0x' + '0'.repeat(64)) {
            const addr = '0x' + val.slice(26);
            console.log(`Slot ${i}: ${val}`);
            console.log(`  As address: ${addr}`);
        }
    }

    // Also read implementation contract storage
    console.log('\n--- Implementation Contract Storage ---');
    for (let i = 0; i < 10; i++) {
        const slot = '0x' + i.toString(16).padStart(64, '0');
        const val = await rpcCall('eth_getStorageAt', [IMPL, slot, 'latest']);
        if (val && val !== '0x' + '0'.repeat(64)) {
            console.log(`Slot ${i}: ${val}`);
            console.log(`  As address: 0x${val.slice(26)}`);
        }
    }

    // Check implementation contract code size
    const implCode = await rpcCall('eth_getCode', [IMPL, 'latest']);
    console.log(`\nImpl contract code size: ${implCode ? (implCode.length - 2) / 2 : 0} bytes`);

    // Try calling common owner/admin functions on the proxy
    const { keccak256, toBytes } = await import('viem');
    const sel = (sig: string) => keccak256(toBytes(sig)).slice(0, 10);

    console.log('\n--- Calling functions on proxy ---');
    const funcs = ['owner()', 'admin()', 'getOwner()', 'signer()', 'getSigner()'];
    for (const f of funcs) {
        const result = await ethCall(PROXY, sel(f));
        if (result.length >= 66) {
            const addr = '0x' + result.slice(26);
            if (addr !== '0x' + '0'.repeat(40)) {
                console.log(`${f}: ${addr}`);
            }
        }
    }

    // Check the Exchange contract — isValidSignature or operator mappings
    console.log('\n--- Exchange contract queries ---');

    // Try getPolyProxyWalletAddress with different selectors
    // The ABI shows: getPolyProxyWalletAddress(address) and getPolyProxyFactoryImplementation()
    const getProxyWalletSel = sel('getPolyProxyWalletAddress(address)');
    console.log('getPolyProxyWalletAddress selector:', getProxyWalletSel);

    const eoa1 = '0xAfE78054F8917c49Fb5CfC6758627cBd5E8B4498';
    const eoa2 = '0x3b68A0810DCc36861F4369c1cb1Df69AFbCB7156';

    for (const [name, addr] of [['EOA1', eoa1], ['EOA2', eoa2]]) {
        const data = getProxyWalletSel + addr.slice(2).toLowerCase().padStart(64, '0');
        const result = await ethCall(EXCHANGE, data);
        console.log(`${name} proxy via Exchange: ${result.length >= 66 ? '0x' + result.slice(26) : 'failed'}`);
    }

    // Try on negRisk exchange too
    for (const [name, addr] of [['EOA1', eoa1], ['EOA2', eoa2]]) {
        const data = getProxyWalletSel + addr.slice(2).toLowerCase().padStart(64, '0');
        const result = await ethCall(NEG_RISK_EXCHANGE, data);
        console.log(`${name} proxy via NegRiskExchange: ${result.length >= 66 ? '0x' + result.slice(26) : 'failed'}`);
    }

    // Check the proxy factory implementation
    const getFactoryImplSel = sel('getPolyProxyFactoryImplementation()');
    const factoryImpl = await ethCall(EXCHANGE, getFactoryImplSel);
    console.log(`\nExchange proxy factory impl: ${factoryImpl.length >= 66 ? '0x' + factoryImpl.slice(26) : 'failed'}`);

    // Check recent transactions on the proxy to find who interacts with it
    console.log('\n--- Recent proxy transactions (via RPC) ---');
    const txCount = await rpcCall('eth_getTransactionCount', [PROXY, 'latest']);
    console.log('Proxy tx count (as sender):', parseInt(txCount, 16));
}

main().catch(e => console.error('Fatal:', e));
