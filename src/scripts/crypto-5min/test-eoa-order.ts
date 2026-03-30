/**
 * Test order with Key 2 in pure EOA mode (signature type 0, no proxy).
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    console.log('EOA:', wallet.address);

    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const apiKey = (creds as any).key;
    console.log('API key:', apiKey?.slice(0, 12) + '...');

    // Pure EOA mode — signature type 0, no funder
    const authed = new ClobClient(
        'https://clob.polymarket.com', 137, wallet,
        { key: apiKey, secret: creds.secret, passphrase: creds.passphrase },
        0 // EOA
    );

    // Find market
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

    if (!market) { console.log('No market found'); return; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    console.log('Market:', market.question);

    // Read book
    const book = await authed.getOrderBook(tokenIds[0]);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    console.log(`Book: ${bids[0]?.price || '?'}/${asks[0]?.price || '?'}`);

    // Try placing tiny order
    console.log('\nPlacing test order: BUY 15 UP at 0.01...');
    try {
        const result = await authed.createAndPostOrder({
            tokenID: tokenIds[0],
            price: 0.01,
            size: 15,
            side: 'BUY' as any,
        });
        console.log('Result:', JSON.stringify(result).slice(0, 300));

        if (result?.orderID) {
            await authed.cancelOrder(result.orderID);
            console.log('ORDER PLACED AND CANCELLED SUCCESSFULLY!');
        } else if (result?.error) {
            console.log('Error:', result.error);
        } else {
            await authed.cancelAll();
        }
    } catch (e: any) {
        console.error('Failed:', e.response?.data?.error || e.message?.slice(0, 200));
    }
}

main().catch(e => console.error('Fatal:', e));
