/**
 * Quick check: what CLOB API endpoints are available to us with auth?
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2 as string);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

    // List available methods
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(authed)).filter(m => m !== 'constructor');
    console.log('Available ClobClient methods:', methods.join(', '));

    // Find current market
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let tokenId = '';
    for (const ts of [rounded, rounded + 300]) {
        const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
        const data = await resp.json();
        if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
            const tokenIds = JSON.parse(data[0].clobTokenIds || '[]');
            tokenId = tokenIds[0];
            console.log('\nMarket:', data[0].question);
            console.log('UP Token:', tokenId.slice(0, 30) + '...');
            break;
        }
    }
    if (!tokenId) { console.log('No market found'); return; }

    // Try various endpoints
    console.log('\n--- Testing endpoints ---');

    // Trades
    try {
        const url = `https://clob.polymarket.com/trades?asset_id=${tokenId}&limit=5`;
        const resp = await fetch(url, {
            headers: {
                'POLY_API_KEY': (creds as any).key,
                'POLY_SECRET': creds.secret,
                'POLY_PASSPHRASE': creds.passphrase,
            }
        });
        const data = await resp.json();
        console.log('Trades (raw fetch):', JSON.stringify(data).slice(0, 300));
    } catch (e: any) {
        console.log('Trades error:', e.message?.slice(0, 100));
    }

    // Try the client's built-in methods
    for (const method of ['getTrades', 'getTradesHistory', 'getLastTradePrice', 'getMarketTradesEvents']) {
        if (typeof (authed as any)[method] === 'function') {
            try {
                const result = await (authed as any)[method]({ asset_id: tokenId });
                console.log(`${method}:`, JSON.stringify(result).slice(0, 200));
            } catch (e: any) {
                console.log(`${method} error:`, e.message?.slice(0, 100));
            }
        }
    }

    // Price history (unauthenticated)
    try {
        const url = `https://clob.polymarket.com/prices-history?market=${tokenId}&interval=1m&fidelity=1`;
        const resp = await fetch(url);
        const data = await resp.json();
        console.log('Price history:', JSON.stringify(data).slice(0, 300));
    } catch (e: any) {
        console.log('Price history error:', e.message?.slice(0, 100));
    }

    // Tick size / market info
    try {
        const url = `https://clob.polymarket.com/tick-size?token_id=${tokenId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        console.log('Tick size:', JSON.stringify(data).slice(0, 200));
    } catch (e: any) {
        console.log('Tick size error:', e.message?.slice(0, 100));
    }

    // Midpoint
    try {
        const url = `https://clob.polymarket.com/midpoint?token_id=${tokenId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        console.log('Midpoint:', JSON.stringify(data).slice(0, 200));
    } catch (e: any) {
        console.log('Midpoint error:', e.message?.slice(0, 100));
    }

    // Spread
    try {
        const url = `https://clob.polymarket.com/spread?token_id=${tokenId}`;
        const resp = await fetch(url);
        const data = await resp.json();
        console.log('Spread:', JSON.stringify(data).slice(0, 200));
    } catch (e: any) {
        console.log('Spread error:', e.message?.slice(0, 100));
    }

    // Notifications/events websocket info
    try {
        const url = `https://clob.polymarket.com/notifications`;
        const resp = await fetch(url);
        const data = await resp.json();
        console.log('Notifications:', JSON.stringify(data).slice(0, 200));
    } catch (e: any) {
        console.log('Notifications error:', e.message?.slice(0, 100));
    }
}

main().catch(e => console.error('Fatal:', e));
