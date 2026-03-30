/**
 * Deep Order Book Analysis for 5-Minute Crypto Markets
 *
 * Analyzes both the Up and Down token books to understand:
 * - Where real liquidity sits
 * - What the effective spread is
 * - How maker bots are positioning
 * - Where opportunities exist to post orders
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${url}`);
    return resp.json();
}

interface BookLevel {
    price: number;
    size: number;
}

interface FullBook {
    bids: BookLevel[];
    asks: BookLevel[];
}

async function fetchFullBook(tokenId: string): Promise<FullBook> {
    const raw = await fetchJSON(`${CLOB_API}/book?token_id=${tokenId}`);
    return {
        bids: (raw.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })),
        asks: (raw.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })),
    };
}

function printBook(label: string, book: FullBook) {
    console.log(`\n  === ${label} Order Book ===`);

    // Sort asks ascending, bids descending
    const asks = [...book.asks].sort((a, b) => a.price - b.price);
    const bids = [...book.bids].sort((a, b) => b.price - a.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    console.log(`  Best Bid: ${bestBid.toFixed(2)} | Best Ask: ${bestAsk.toFixed(2)} | Spread: ${(spread * 100).toFixed(1)}c | Midpoint: ${midpoint.toFixed(3)}`);

    // Show top 10 levels each side
    console.log('\n  ASKS (selling pressure):');
    for (const level of asks.slice(0, 15)) {
        const bar = '#'.repeat(Math.min(50, Math.round(level.size / 50)));
        console.log(`    ${level.price.toFixed(2)} | $${level.size.toFixed(0).padStart(8)} | ${bar}`);
    }

    console.log('\n  BIDS (buying pressure):');
    for (const level of bids.slice(0, 15)) {
        const bar = '#'.repeat(Math.min(50, Math.round(level.size / 50)));
        console.log(`    ${level.price.toFixed(2)} | $${level.size.toFixed(0).padStart(8)} | ${bar}`);
    }

    // Liquidity summary
    const totalBidLiq = bids.reduce((sum, b) => sum + b.price * b.size, 0);
    const totalAskLiq = asks.reduce((sum, a) => sum + a.price * a.size, 0);
    const nearBidLiq = bids.filter(b => b.price >= bestBid - 0.05).reduce((sum, b) => sum + b.price * b.size, 0);
    const nearAskLiq = asks.filter(a => a.price <= bestAsk + 0.05).reduce((sum, a) => sum + a.price * a.size, 0);

    console.log(`\n  Total bid liquidity: $${totalBidLiq.toFixed(0)} | Near-touch (5c): $${nearBidLiq.toFixed(0)}`);
    console.log(`  Total ask liquidity: $${totalAskLiq.toFixed(0)} | Near-touch (5c): $${nearAskLiq.toFixed(0)}`);

    return { bestBid, bestAsk, spread, midpoint };
}

async function main() {
    console.log('=== Deep Order Book Analysis: 5-Min Crypto Markets ===\n');

    // Find the most recent BTC 5-min markets
    const markets = await fetchJSON(
        `${GAMMA_API}/markets?closed=false&limit=100&order=createdAt&ascending=false`
    );

    const btcMarkets = markets.filter((m: any) => {
        const q = (m.question || '').toLowerCase();
        return q.includes('bitcoin') && q.includes('up or down') && !q.includes('hourly') && !q.includes('daily') && !q.includes('4h');
    });

    // Also grab ETH for comparison
    const ethMarkets = markets.filter((m: any) => {
        const q = (m.question || '').toLowerCase();
        return q.includes('ethereum') && q.includes('up or down') && !q.includes('hourly') && !q.includes('daily');
    });

    console.log(`Found ${btcMarkets.length} BTC and ${ethMarkets.length} ETH 5-min markets\n`);

    // Analyze the 3 most recent BTC markets
    for (const market of btcMarkets.slice(0, 3)) {
        console.log(`\n${'='.repeat(70)}`);
        console.log(`MARKET: ${market.question}`);
        console.log(`End: ${market.endDate} | Volume: $${parseFloat(market.volume || '0').toFixed(0)}`);

        let tokenIds: string[];
        let outcomes: string[];
        try {
            tokenIds = JSON.parse(market.clobTokenIds || '[]');
            outcomes = JSON.parse(market.outcomes || '[]');
        } catch {
            console.log('  [Could not parse token IDs]');
            continue;
        }

        // Fetch both books in parallel
        const books = await Promise.all(tokenIds.map(id => fetchFullBook(id)));

        const stats: any[] = [];
        for (let i = 0; i < outcomes.length; i++) {
            const s = printBook(`${outcomes[i]} (Token ${i})`, books[i]);
            stats.push(s);
        }

        // Cross-book analysis
        if (stats.length === 2) {
            console.log('\n  === Cross-Book Analysis ===');
            const upMid = stats[0].midpoint;
            const downMid = stats[1].midpoint;
            const totalMid = upMid + downMid;
            console.log(`  Up midpoint: ${upMid.toFixed(3)} + Down midpoint: ${downMid.toFixed(3)} = ${totalMid.toFixed(3)}`);
            console.log(`  Overround: ${((totalMid - 1) * 100).toFixed(2)}% (>0 means house edge built in)`);

            // Can we buy both sides for < $1?
            const buyUpAsk = stats[0].bestAsk;
            const buyDownAsk = stats[1].bestAsk;
            const bothCost = buyUpAsk + buyDownAsk;
            console.log(`  Buy both sides: Up@${buyUpAsk.toFixed(2)} + Down@${buyDownAsk.toFixed(2)} = $${bothCost.toFixed(2)} (arb if < $1.00)`);

            // Sell both sides
            const sellUpBid = stats[0].bestBid;
            const sellDownBid = stats[1].bestBid;
            const bothSell = sellUpBid + sellDownBid;
            console.log(`  Sell both sides: Up@${sellUpBid.toFixed(2)} + Down@${sellDownBid.toFixed(2)} = $${bothSell.toFixed(2)} (arb if > $1.00)`);
        }
    }

    // Also check: what does the book look like for a market CURRENTLY in its 5-min window?
    console.log('\n\n' + '='.repeat(70));
    console.log('TIMING ANALYSIS: Which markets are currently active?');
    console.log('='.repeat(70));

    const now = new Date();
    for (const market of btcMarkets.slice(0, 20)) {
        const eventStart = market.eventStartTime ? new Date(market.eventStartTime) : null;
        const endDate = new Date(market.endDate);
        const isActive = eventStart && now >= eventStart && now <= endDate;
        const minUntilStart = eventStart ? (eventStart.getTime() - now.getTime()) / 60000 : null;
        const minUntilEnd = (endDate.getTime() - now.getTime()) / 60000;

        const status = isActive ? 'LIVE NOW' :
            (minUntilStart && minUntilStart > 0 && minUntilStart < 60) ? `Starts in ${minUntilStart.toFixed(1)}min` :
            minUntilEnd < 0 ? 'ENDED' : 'Upcoming';

        console.log(`  [${status.padEnd(20)}] ${market.question}`);
        if (eventStart) {
            console.log(`                        Event: ${eventStart.toLocaleTimeString()} - ${endDate.toLocaleTimeString()}`);
        }
    }

    // Fetch and analyze the Polymarket fee structure
    console.log('\n\n' + '='.repeat(70));
    console.log('FEE VERIFICATION');
    console.log('='.repeat(70));

    // Check a market's raw fee data
    const sampleMarket = btcMarkets[0];
    console.log(`\nRaw market fee data for: ${sampleMarket.question}`);
    const feeFields = ['makerBaseFee', 'takerBaseFee', 'feesEnabled', 'feeType',
        'rewardsMinSize', 'rewardsMaxSpread', 'makerRebatesFeeShareBps'];
    for (const field of feeFields) {
        console.log(`  ${field}: ${sampleMarket[field] ?? 'N/A'}`);
    }

    // Also dump the full market object for inspection
    console.log('\n\nFull market object (first BTC market):');
    console.log(JSON.stringify(sampleMarket, null, 2));
}

main().catch(console.error);
