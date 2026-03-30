import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
    console.log(`Wallet: ${wallet.address}`);

    // Get API creds
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const apiKey = (creds as any).key;

    // Authed client
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet, {
        key: apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
    });

    // Try balance with USDC contract address on Polygon
    const USDC_POLYGON = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e
    const USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359'; // Native USDC

    for (const addr of [USDC_POLYGON, USDC_NATIVE]) {
        try {
            const bal = await authed.getBalanceAllowance({
                asset_type: addr,
                signature_type: 0,
            } as any);
            console.log(`Balance (${addr.slice(0,8)}...):`, JSON.stringify(bal));
        } catch (e: any) {
            console.log(`Balance (${addr.slice(0,8)}...) failed:`, e.response?.data?.error || e.message?.slice(0, 80));
        }
    }

    // Also try the Polymarket conditional token framework address
    // The CLOB uses a specific USDC address
    const EXCHANGE_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    try {
        // Try without asset_type
        const resp = await fetch('https://clob.polymarket.com/balance-allowance?signature_type=0', {
            headers: {
                'POLY_ADDRESS': wallet.address,
                'POLY_SIGNATURE': 'test',
                'POLY_TIMESTAMP': Math.floor(Date.now()/1000).toString(),
                'POLY_API_KEY': apiKey,
                'POLY_PASSPHRASE': creds.passphrase,
            }
        });
        const data = await resp.json();
        console.log('Raw balance endpoint:', JSON.stringify(data));
    } catch {}

    // Get a market and check if we can create an order
    console.log('\n--- Order Creation Test ---');
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

    if (market) {
        const tokenIds = JSON.parse(market.clobTokenIds || '[]');
        console.log(`Market: ${market.question}`);

        // Get book to find current mid
        const book = await authed.getOrderBook(tokenIds[0]);
        const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
        const bestBid = parseFloat(bids[0]?.price || '0');
        const bestAsk = parseFloat(asks[0]?.price || '1');
        const mid = (bestBid + bestAsk) / 2;
        console.log(`Mid: ${(mid*100).toFixed(1)}c | Bid: ${bestBid} | Ask: ${bestAsk}`);

        // Try creating a tiny BUY order far from the market (won't fill, just testing)
        const testPrice = 0.01; // Buy at 1c — won't fill, basically free test
        const testSize = 10;    // Minimum size
        console.log(`\nCreating test order: BUY ${testSize} UP at ${testPrice}...`);
        try {
            const order = await authed.createOrder({
                tokenID: tokenIds[0],
                price: testPrice,
                size: testSize,
                side: 'BUY' as any,
            });
            console.log('Order result:', JSON.stringify(order, null, 2).slice(0, 500));

            // Cancel it immediately
            if (order?.orderID || order?.id) {
                const orderId = order.orderID || order.id;
                console.log(`\nCancelling order ${orderId}...`);
                const cancel = await authed.cancelOrder(orderId);
                console.log('Cancel result:', JSON.stringify(cancel));
            }
        } catch (e: any) {
            console.error('Order creation failed:', e.message?.slice(0, 200));
            if (e.response?.data) console.error('  Data:', JSON.stringify(e.response.data).slice(0, 300));
        }
    }

    console.log('\n=== Done ===');
}

main().catch(e => console.error('Fatal:', e));
