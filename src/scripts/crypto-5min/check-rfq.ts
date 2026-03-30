/**
 * Check RFQ system: Does Polymarket support MINT/MERGE operations
 * for the crypto 5-min markets via the RFQ client?
 *
 * This is critical: if MINT works, we can split USDC -> YES+NO tokens
 * through the SDK without raw contract calls.
 *
 * Run: npx tsx src/scripts/crypto-5min/check-rfq.ts
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

    // 1. Check RFQ config
    console.log('=== RFQ Config ===');
    try {
        const config = await authed.rfq.rfqConfig();
        console.log(JSON.stringify(config, null, 2));
    } catch (e: any) {
        console.log('RFQ config error:', e.response?.data || e.message?.slice(0, 200));
    }

    // 2. Check existing RFQ requests (see what's out there)
    console.log('\n=== Active RFQ Requests ===');
    try {
        const requests = await authed.rfq.getRfqRequests({ limit: 10, state: 'active' });
        console.log(`Found ${requests.count || requests.data?.length || 0} requests`);
        if (requests.data?.length > 0) {
            for (const req of requests.data.slice(0, 3)) {
                console.log(`  ${req.requestId}: ${req.side} ${req.sizeIn}@${req.price} (${req.state})`);
                console.log(`    Token: ${req.token?.slice(0, 30)}...`);
                console.log(`    Condition: ${req.condition?.slice(0, 30)}...`);
            }
        }
    } catch (e: any) {
        console.log('RFQ requests error:', e.response?.data || e.message?.slice(0, 200));
    }

    // 3. Find current market
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
    console.log(`\nMarket: ${market.question}`);
    console.log(`Condition: ${market.conditionId}`);
    console.log(`negRisk: ${market.negRisk}`);
    console.log(`UP token: ${tokenIds[0]?.slice(0, 30)}...`);

    // 4. Try creating an RFQ request for a small BUY
    console.log('\n=== Test RFQ Request (BUY 5 UP at 0.50) ===');
    try {
        const result = await authed.rfq.createRfqRequest({
            tokenID: tokenIds[0],
            side: 'BUY' as any,
            size: 5,
            price: 0.50,
        });
        console.log('RFQ Request created:', JSON.stringify(result, null, 2));

        // Cancel it immediately
        if (result.requestId) {
            console.log('Cancelling...');
            await authed.rfq.cancelRfqRequest({ requestId: result.requestId });
            console.log('Cancelled.');
        }
    } catch (e: any) {
        console.log('RFQ request error:', e.response?.data || e.message?.slice(0, 300));
    }

    // 5. Check market data for conditionId and neg-risk fields
    console.log('\n=== Market Fields ===');
    const interestingKeys = ['conditionId', 'questionId', 'negRisk', 'negRiskMarketId',
                             'negRiskRequestId', 'clobTokenIds', 'enableOrderBook'];
    for (const key of interestingKeys) {
        const val = market[key];
        if (val !== undefined) {
            console.log(`  ${key}: ${typeof val === 'string' ? val.slice(0, 80) : JSON.stringify(val)}`);
        }
    }

    console.log('\nDone.');
}

main().catch(e => console.error('Fatal:', e));
