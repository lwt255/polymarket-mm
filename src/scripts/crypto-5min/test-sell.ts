/**
 * Test: Can we BUY tokens then immediately SELL them back?
 * This validates the instant exit mechanism.
 */
import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY2!);
    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);
    const creds = await client.createOrDeriveApiKey();
    const authed = new ClobClient('https://clob.polymarket.com', 137, wallet,
        { key: (creds as any).key, secret: creds.secret, passphrase: creds.passphrase }, 0);

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
    if (!market) { console.log('No market'); return; }

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    console.log('Market:', market.question);

    // Read book
    const book = await authed.getOrderBook(upToken);
    const bids = (book.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
    const asks = (book.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
    const bestBid = parseFloat(bids[0]?.price || '0');
    const bestAsk = parseFloat(asks[0]?.price || '1');
    console.log(`Book: ${bestBid}/${bestAsk}`);

    // Step 1: BUY at the ask (taker fill, instant)
    const buyPrice = bestAsk;
    const size = 10;
    console.log(`\n1. Buying ${size} UP at ${buyPrice} (taker)...`);
    try {
        const buyResult = await authed.createAndPostOrder({
            tokenID: upToken, price: buyPrice, size, side: 'BUY' as any,
        });
        console.log('Buy result:', buyResult?.orderID ? 'FILLED' : buyResult?.error || 'unknown');
        console.log('Details:', JSON.stringify(buyResult).slice(0, 200));
    } catch (e: any) {
        console.log('Buy failed:', e.response?.data?.error || e.message?.slice(0, 100));
        return;
    }

    // Small delay
    await new Promise(r => setTimeout(r, 1000));

    // Step 2: SELL at the bid (taker fill, instant)
    const sellPrice = bestBid;
    console.log(`\n2. Selling ${size} UP at ${sellPrice} (taker)...`);
    try {
        const sellResult = await authed.createAndPostOrder({
            tokenID: upToken, price: sellPrice, size, side: 'SELL' as any,
        });
        console.log('Sell result:', sellResult?.orderID ? 'FILLED' : sellResult?.error || 'unknown');
        console.log('Details:', JSON.stringify(sellResult).slice(0, 200));

        const spreadLoss = (buyPrice - sellPrice) * size;
        console.log(`\nSpread loss: $${spreadLoss.toFixed(4)} (${((buyPrice - sellPrice) * 100).toFixed(1)}c × ${size})`);
    } catch (e: any) {
        console.log('Sell failed:', e.response?.data?.error || e.message?.slice(0, 100));
        console.log('\nSELL does not work. Need alternative exit strategy.');
    }

    // Cleanup
    await authed.cancelAll();
    console.log('\nDone.');
}

main().catch(e => console.error('Fatal:', e));
