/**
 * Test both wallet keys for order placement capability.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const PROXY_ADDRESS_KEY1 = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1';

async function testOrder(name: string, pk: string, sigType: number, funder?: string) {
    const wallet = new Wallet(pk);
    console.log(`\n=== ${name} ===`);
    console.log(`EOA: ${wallet.address}`);
    if (funder) console.log(`Funder: ${funder}`);
    console.log(`Signature type: ${sigType}`);

    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const apiKey = (creds as any).key;
    console.log(`API key: ${apiKey?.slice(0, 12)}...`);

    const authed = new ClobClient(
        'https://clob.polymarket.com', 137, wallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        sigType, funder
    );

    // Find a current market
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let market: any = null;
    for (const ts of [rounded, rounded + 300]) {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
            market = data[0];
            break;
        }
    }

    if (!market) {
        console.log('No active market found');
        return;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    console.log(`Market: ${market.question}`);

    try {
        const result = await authed.createAndPostOrder({
            tokenID: tokenIds[0],
            price: 0.01,
            size: 15,
            side: 'BUY' as any,
        });
        console.log('Result:', JSON.stringify(result).slice(0, 300));

        // Cancel immediately
        if (result?.orderID || result?.id) {
            await authed.cancelOrder(result.orderID || result.id);
            console.log('Order placed and cancelled successfully!');
        } else if (result?.error) {
            console.log('Server rejected:', result.error);
        } else {
            await authed.cancelAll();
            console.log('Cancelled all');
        }
    } catch (e: any) {
        console.error('FAILED:', e.response?.data?.error || e.message?.slice(0, 200));
    }
}

async function main() {
    const pk1 = process.env.POLYMARKET_PRIVATE_KEY!;
    const pk2 = process.env.POLYMARKET_PRIVATE_KEY2!;

    // Test all combinations
    // Key 1 with POLY_PROXY + proxy address
    await testOrder('Key 1 — POLY_PROXY', pk1, 1, PROXY_ADDRESS_KEY1);

    // Key 2 with POLY_PROXY + same proxy address (maybe it belongs to Key 2?)
    if (pk2) {
        await testOrder('Key 2 — POLY_PROXY', pk2, 1, PROXY_ADDRESS_KEY1);
    }

    console.log('\n=== Done ===');
}

main().catch(e => console.error('Fatal:', e));
