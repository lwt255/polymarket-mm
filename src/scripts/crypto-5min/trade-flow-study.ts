/**
 * Trade Flow Study
 *
 * Instead of just watching the book, let's look at ACTUAL TRADES.
 * The CLOB API has a /trades endpoint that shows executed trades.
 *
 * Questions:
 * 1. Who is taking liquidity (takers) vs providing (makers)?
 * 2. At what prices do trades cluster?
 * 3. Is there a pattern to when big trades happen?
 * 4. What's the average trade size?
 * 5. Does trade flow predict the outcome?
 *
 * Also checks: /rewards endpoint, market metadata for any rebate info.
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) {
        console.log(`  HTTP ${resp.status} for ${url}`);
        return null;
    }
    return resp.json();
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    for (const ts of [rounded, rounded + 300]) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
        if (data?.length > 0) {
            const m = data[0];
            if (new Date(m.endDate).getTime() > Date.now()) return m;
        }
    }
    return null;
}

async function exploreAPIs() {
    console.log('=== Exploring CLOB API Endpoints ===\n');

    const market = await findCurrentMarket();
    if (!market) {
        console.log('No active market found. Try again in a moment.');
        return;
    }

    console.log(`Market: ${market.question}`);
    console.log(`Condition ID: ${market.conditionId}`);
    console.log(`CLOB Token IDs: ${market.clobTokenIds}`);

    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];

    // 1. Check market metadata
    console.log('\n--- Market Metadata (Gamma) ---');
    const fullMarket = market;
    console.log(`  Fee schedule: ${fullMarket.feeSchedule || 'not specified'}`);
    console.log(`  Maker rebate bps: ${fullMarket.makerRebatesFeeShareBps || 'not specified'}`);
    console.log(`  Rewards: ${fullMarket.rewards || 'not specified'}`);
    console.log(`  Volume: $${fullMarket.volume || 0}`);
    console.log(`  Active: ${fullMarket.active}`);
    console.log(`  Closed: ${fullMarket.closed}`);

    // Log all market fields for discovery
    console.log('\n  All market fields:');
    for (const [key, value] of Object.entries(fullMarket)) {
        if (typeof value === 'string' && value.length > 200) {
            console.log(`    ${key}: [long string, ${value.length} chars]`);
        } else {
            console.log(`    ${key}: ${JSON.stringify(value)}`);
        }
    }

    // 2. Try CLOB trades endpoint
    console.log('\n--- CLOB /trades ---');
    const trades = await fetchJSON(`${CLOB}/trades?token_id=${upToken}`);
    if (trades) {
        console.log(`  Type: ${typeof trades}`);
        if (Array.isArray(trades)) {
            console.log(`  Count: ${trades.length}`);
            if (trades.length > 0) {
                console.log(`  Sample trade:`, JSON.stringify(trades[0], null, 2));
            }
        } else {
            console.log(`  Response:`, JSON.stringify(trades, null, 2).slice(0, 500));
        }
    }

    // 3. Try CLOB market endpoint
    console.log('\n--- CLOB /market ---');
    const clobMarket = await fetchJSON(`${CLOB}/market/${market.conditionId}`);
    if (clobMarket) {
        console.log(`  Response:`, JSON.stringify(clobMarket, null, 2).slice(0, 1000));
    }

    // 4. Try CLOB rewards endpoint
    console.log('\n--- CLOB /rewards ---');
    const rewards = await fetchJSON(`${CLOB}/rewards`);
    if (rewards) {
        console.log(`  Response:`, JSON.stringify(rewards, null, 2).slice(0, 500));
    }

    // 5. Try Gamma events endpoint for the parent event
    console.log('\n--- Gamma Event ---');
    // The 5-min markets are grouped under an event
    const events = await fetchJSON(`${GAMMA}/events?slug=btc-5-min`);
    if (events?.length > 0) {
        const event = events[0];
        console.log(`  Event: ${event.title}`);
        console.log(`  Markets count: ${event.markets?.length || 'unknown'}`);
    } else {
        // Try other slugs
        const altSlugs = ['btc-updown', 'btc-updown-5m', 'crypto-5min', 'btc-5min'];
        for (const slug of altSlugs) {
            const ev = await fetchJSON(`${GAMMA}/events?slug=${slug}`);
            if (ev?.length > 0) {
                console.log(`  Found event at slug '${slug}': ${ev[0].title}`);
                break;
            }
        }
    }

    // 6. Check the book RIGHT NOW and at recent resolved markets
    console.log('\n--- Current Book Analysis ---');
    const [upBook, downBook] = await Promise.all([
        fetchJSON(`${CLOB}/book?token_id=${upToken}`),
        fetchJSON(`${CLOB}/book?token_id=${downToken}`),
    ]);

    if (upBook && downBook) {
        const upBids = (upBook.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const downBids = (downBook.bids || []).sort((a: any, b: any) => parseFloat(b.price) - parseFloat(a.price));
        const upAsks = (upBook.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));
        const downAsks = (downBook.asks || []).sort((a: any, b: any) => parseFloat(a.price) - parseFloat(b.price));

        console.log('\n  Up token book (top 5):');
        console.log('    Bids:', upBids.slice(0, 5).map((b: any) => `${b.price}x${parseFloat(b.size).toFixed(0)}`).join(' | '));
        console.log('    Asks:', upAsks.slice(0, 5).map((a: any) => `${a.price}x${parseFloat(a.size).toFixed(0)}`).join(' | '));

        console.log('\n  Down token book (top 5):');
        console.log('    Bids:', downBids.slice(0, 5).map((b: any) => `${b.price}x${parseFloat(b.size).toFixed(0)}`).join(' | '));
        console.log('    Asks:', downAsks.slice(0, 5).map((a: any) => `${a.price}x${parseFloat(a.size).toFixed(0)}`).join(' | '));

        // Cross-token analysis
        const upBestBid = parseFloat(upBids[0]?.price || '0');
        const downBestBid = parseFloat(downBids[0]?.price || '0');
        const upBestAsk = parseFloat(upAsks[0]?.price || '1');
        const downBestAsk = parseFloat(downAsks[0]?.price || '1');

        console.log('\n  Cross-token:');
        console.log(`    Up bid + Down bid = ${(upBestBid + downBestBid).toFixed(4)} (< 1.00 = maker arb)`);
        console.log(`    Up ask + Down ask = ${(upBestAsk + downBestAsk).toFixed(4)} (> 1.00 = taker cost)`);
        console.log(`    Underround: ${((1 - upBestBid - downBestBid) * 100).toFixed(2)}c`);
        console.log(`    Overround: ${((upBestAsk + downBestAsk - 1) * 100).toFixed(2)}c`);

        // Look at ALL price levels for both tokens
        console.log('\n  Full depth:');
        console.log('  Up bids:', upBids.length, '| Up asks:', upAsks.length);
        console.log('  Down bids:', downBids.length, '| Down asks:', downAsks.length);

        // Total depth calculation
        const upBidDepth = upBids.reduce((s: number, b: any) => s + parseFloat(b.size) * parseFloat(b.price), 0);
        const upAskDepth = upAsks.reduce((s: number, a: any) => s + parseFloat(a.size) * parseFloat(a.price), 0);
        const downBidDepth = downBids.reduce((s: number, b: any) => s + parseFloat(b.size) * parseFloat(b.price), 0);
        const downAskDepth = downAsks.reduce((s: number, a: any) => s + parseFloat(a.size) * parseFloat(a.price), 0);

        console.log(`  Up: $${upBidDepth.toFixed(0)} bid / $${upAskDepth.toFixed(0)} ask`);
        console.log(`  Down: $${downBidDepth.toFixed(0)} bid / $${downAskDepth.toFixed(0)} ask`);
        console.log(`  Total: $${(upBidDepth + upAskDepth + downBidDepth + downAskDepth).toFixed(0)}`);
    }

    // 7. Check a recently RESOLVED market for trade data
    console.log('\n--- Recently Resolved Market ---');
    const prevTs = Math.floor(Date.now() / 1000 / 300) * 300 - 300;
    const prevData = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${prevTs}`);
    if (prevData?.length > 0) {
        const prev = prevData[0];
        console.log(`  ${prev.question}`);
        console.log(`  Volume: $${prev.volume}`);
        console.log(`  Outcome prices: ${prev.outcomePrices}`);

        const prevTokens = JSON.parse(prev.clobTokenIds || '[]');
        if (prevTokens[0]) {
            const prevTrades = await fetchJSON(`${CLOB}/trades?token_id=${prevTokens[0]}`);
            if (prevTrades && Array.isArray(prevTrades)) {
                console.log(`  Trades: ${prevTrades.length}`);
                if (prevTrades.length > 0) {
                    // Analyze trade sizes and prices
                    const prices = prevTrades.map((t: any) => parseFloat(t.price));
                    const sizes = prevTrades.map((t: any) => parseFloat(t.size || t.amount || '0'));
                    console.log(`  Price range: ${Math.min(...prices).toFixed(3)} - ${Math.max(...prices).toFixed(3)}`);
                    console.log(`  Avg trade size: $${(sizes.reduce((a: number, b: number) => a + b, 0) / sizes.length).toFixed(1)}`);
                    console.log(`  First 3 trades:`, prevTrades.slice(0, 3).map((t: any) => JSON.stringify(t)).join('\n    '));
                }
            }
        }
    }

    // 8. Check Gamma activity/history endpoint
    console.log('\n--- Gamma Activity ---');
    const activity = await fetchJSON(`${GAMMA}/activity?market=${market.conditionId}&limit=5`);
    if (activity) {
        console.log(`  Response type: ${typeof activity}`);
        if (Array.isArray(activity)) {
            console.log(`  Count: ${activity.length}`);
            activity.slice(0, 2).forEach((a: any, i: number) => {
                console.log(`  Activity ${i}:`, JSON.stringify(a, null, 2).slice(0, 300));
            });
        } else {
            console.log(`  Response:`, JSON.stringify(activity, null, 2).slice(0, 500));
        }
    }
}

exploreAPIs().catch(console.error);
