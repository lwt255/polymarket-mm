/**
 * Order Test — Place a tiny, safe order on a BTC 5-min market and cancel it.
 * This validates we can interact with the CLOB for real.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

// Polymarket proxy wallet address (where USDC lives)
const FUNDER_ADDRESS = '0xE00B44d2666029860e6Ac3B4D3A0DD18dC6D17B1';
const SIGNATURE_TYPE = 1; // POLY_PROXY

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
    console.log(`Wallet (EOA): ${wallet.address}`);
    console.log(`Funder (Proxy): ${FUNDER_ADDRESS}\n`);

    // Get API creds
    const tempClient = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await tempClient.createOrDeriveApiKey();
    const apiKey = (creds as any).key;

    if (!apiKey) {
        console.error('No API key! Cannot proceed.');
        return;
    }
    console.log(`API key: ${apiKey.slice(0, 12)}...`);

    // Authenticated client with POLY_PROXY signature type and funder address
    const client = new ClobClient(
        'https://clob.polymarket.com',
        137,
        wallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        SIGNATURE_TYPE,
        FUNDER_ADDRESS
    );

    // Find current market
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
        console.log('No active market. Try again in a moment.');
        return;
    }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    console.log(`\nMarket: ${market.question}`);

    // Read book
    const book = await client.getOrderBook(upToken);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    console.log(`Book: ${bestBid}/${bestAsk} (${((bestAsk-bestBid)*100).toFixed(1)}c spread)`);

    // Place a BUY order at 1c — far from market, won't fill, safe test
    // $0.10 total (10 shares at $0.01)
    const testPrice = 0.01;
    const testSize = 15; // need > $5 notional — 15 shares at 1c = $0.15... might be too small

    console.log(`\n--- Placing test order: BUY ${testSize} UP at ${testPrice} ---`);
    try {
        const result = await client.createAndPostOrder({
            tokenID: upToken,
            price: testPrice,
            size: testSize,
            side: 'BUY' as any,
        });
        console.log('Order posted!');
        console.log('Result:', JSON.stringify(result, null, 2));

        // Check open orders
        const orders = await client.getOpenOrders();
        console.log(`\nOpen orders: ${orders?.length || 0}`);

        // Cancel it
        if (result?.orderID || result?.id) {
            const orderId = result.orderID || result.id;
            console.log(`\nCancelling order ${orderId}...`);
            const cancel = await client.cancelOrder(orderId);
            console.log('Cancelled:', JSON.stringify(cancel));
        } else {
            // Try cancel all
            console.log('\nNo orderID in response. Cancelling all orders...');
            const cancelAll = await client.cancelAll();
            console.log('Cancel all:', JSON.stringify(cancelAll));
        }

        // Verify cancelled
        const afterOrders = await client.getOpenOrders();
        console.log(`Open orders after cancel: ${afterOrders?.length || 0}`);

    } catch (e: any) {
        console.error('Order failed:', e.message);
        if (e.response?.data) {
            console.error('Response:', JSON.stringify(e.response.data).slice(0, 500));
        }
    }

    console.log('\n=== Order Test Complete ===');
}

main().catch(e => console.error('Fatal:', e));
