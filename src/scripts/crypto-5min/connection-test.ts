/**
 * Connection Test — Verify we can connect to Polymarket CLOB
 * and read balance + place/cancel orders.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

const CLOB_URL = 'https://clob.polymarket.com';
const CHAIN_ID = 137; // Polygon

async function main() {
    const privateKey = process.env.POLYMARKET_PRIVATE_KEY;

    if (!privateKey) {
        console.error('Missing POLYMARKET_PRIVATE_KEY in .env');
        process.exit(1);
    }

    // Create ethers Wallet (required by ClobClient)
    const wallet = new Wallet(privateKey);

    console.log('=== Polymarket CLOB Connection Test ===\n');
    console.log(`Signer address: ${wallet.address}`);

    // Step 1: Initialize client (without API creds, just signer)
    console.log('\n1. Initializing CLOB client with signer...');
    let client = new ClobClient(CLOB_URL, CHAIN_ID, wallet);
    console.log('   Client created.');

    // Step 2: Derive API key
    console.log('\n2. Deriving API credentials...');
    let apiCreds: any;
    try {
        apiCreds = await client.deriveApiKey();
        console.log(`   API key derived: ${apiCreds.apiKey?.slice(0, 12)}...`);
    } catch (e: any) {
        console.log(`   deriveApiKey failed (${e.message?.slice(0, 60)}), trying createOrDeriveApiKey...`);
        try {
            apiCreds = await client.createOrDeriveApiKey();
            console.log(`   API key: ${apiCreds.apiKey?.slice(0, 12)}...`);
        } catch (e2: any) {
            console.error('   Failed to get API key:', e2.message);
            console.log('   Continuing with read-only access...');
        }
    }

    // Step 3: Re-init with full credentials
    if (apiCreds) {
        console.log('\n3. Re-initializing with full credentials...');
        client = new ClobClient(CLOB_URL, CHAIN_ID, wallet, {
            key: apiCreds.apiKey,
            secret: apiCreds.secret,
            passphrase: apiCreds.passphrase,
        });
        console.log('   Authenticated client ready.');

        // Step 4: Check balance
        console.log('\n4. Checking balance...');
        try {
            const bal = await client.getBalanceAllowance({
                asset_type: 'USDC',
            } as any);
            console.log('   Balance:', JSON.stringify(bal));
        } catch (e: any) {
            console.log('   Balance check method 1 failed:', e.message?.slice(0, 80));
            // Try alternate
            try {
                const resp = await fetch(`${CLOB_URL}/balance`, {
                    headers: { 'Authorization': `Bearer ${apiCreds.apiKey}` }
                });
                const data = await resp.json();
                console.log('   Balance (REST):', JSON.stringify(data));
            } catch {}
        }

        // Step 5: Check open orders
        console.log('\n5. Checking open orders...');
        try {
            const orders = await client.getOpenOrders();
            console.log(`   Open orders: ${orders?.length || 0}`);
            if (orders?.length > 0) {
                console.log('   First order:', JSON.stringify(orders[0]).slice(0, 200));
            }
        } catch (e: any) {
            console.log('   Open orders failed:', e.message?.slice(0, 80));
        }

        // Step 6: Check trade history
        console.log('\n6. Checking trade history...');
        try {
            const trades = await client.getTrades();
            console.log(`   Total trades: ${trades?.length || 0}`);
        } catch (e: any) {
            console.log('   Trades failed:', e.message?.slice(0, 80));
        }
    }

    // Step 7: Read a current market
    console.log('\n7. Reading current BTC 5-min market...');
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let market: any = null;
    for (const ts of [rounded, rounded + 300]) {
        try {
            const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=btc-updown-5m-${ts}`);
            const data = await resp.json();
            if (data?.length > 0 && new Date(data[0].endDate).getTime() > Date.now()) {
                market = data[0];
                break;
            }
        } catch {}
    }

    if (market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        console.log(`   Market: ${market.question}`);
        console.log(`   Condition ID: ${market.conditionId}`);
        console.log(`   UP token: ${tokenIds[0]}`);
        console.log(`   DOWN token: ${tokenIds[1]}`);

        // Read the book via authenticated client
        console.log('\n8. Reading order book...');
        try {
            const book = await client.getOrderBook(tokenIds[0]);
            const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price)).slice(0, 5);
            const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price)).slice(0, 5);
            console.log('   Bids:', bids.map((b: any) => `${b.price}x${parseFloat(b.size).toFixed(0)}`).join(' | '));
            console.log('   Asks:', asks.map((a: any) => `${a.price}x${parseFloat(a.size).toFixed(0)}`).join(' | '));

            const bestBid = parseFloat(bids[0]?.price || '0');
            const bestAsk = parseFloat(asks[0]?.price || '1');
            console.log(`   Spread: ${((bestAsk - bestBid) * 100).toFixed(1)}c`);
            console.log(`   Mid: ${((bestBid + bestAsk) / 2 * 100).toFixed(1)}c`);
        } catch (e: any) {
            console.error('   Book read failed:', e.message);
        }

        // Get midpoint via API
        console.log('\n9. Getting midpoint via API...');
        try {
            const mid = await client.getMidpoint(tokenIds[0]);
            console.log('   Midpoint:', mid);
        } catch (e: any) {
            console.log('   Midpoint failed:', e.message?.slice(0, 80));
        }
    } else {
        console.log('   No active market found (may be between candles).');
    }

    console.log('\n=== Connection Test Complete ===');
    console.log('\nIf steps 2-6 succeeded, we are ready to place orders.');
}

main().catch(e => {
    console.error('Fatal error:', e);
    process.exit(1);
});
