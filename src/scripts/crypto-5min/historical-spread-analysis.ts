/**
 * Historical Spread Analysis: Look at resolved 5-min markets to find structural patterns.
 *
 * We can't get historical order books, but we CAN:
 * 1. Look at many resolved markets to find volume/outcome patterns
 * 2. Check the CURRENT open market's book structure in detail
 * 3. Analyze the fee structure mathematically
 *
 * Key math for cross-token arb:
 *   - Makers pay 0% fee (100% rebate)
 *   - If we post bids on Up at 0.48 and Down at 0.48:
 *     Total cost if both fill: $0.96, guaranteed return: $1.00
 *     Profit: $0.04 per $1 = 4.17% return per 5 minutes
 *   - But we need BOTH to fill, and the market probably won't let us bid that low
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) return null;
    return resp.json();
}

async function main() {
    console.log('=== Historical & Structural Analysis ===\n');

    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    // 1. Analyze 200 resolved markets for patterns
    console.log('--- Analyzing 200 recent resolved markets ---\n');

    let total = 0, ups = 0, downs = 0;
    const volumes: number[] = [];
    const outcomes: ('UP' | 'DOWN')[] = [];

    for (let i = 2; i <= 201; i++) {
        const ts = rounded - (i * 300);
        try {
            const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
            if (!data || data.length === 0) continue;
            const m = data[0];
            const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
            const vol = parseFloat(m.volume || '0');
            if (prices[0] >= 0.95) { ups++; outcomes.push('UP'); }
            else if (prices[1] >= 0.95) { downs++; outcomes.push('DOWN'); }
            else continue;
            total++;
            volumes.push(vol);
        } catch {}
    }

    console.log(`Markets: ${total}`);
    console.log(`UP: ${ups} (${((ups/total)*100).toFixed(1)}%) | DOWN: ${downs} (${((downs/total)*100).toFixed(1)}%)`);

    // Streak analysis — if market has momentum, consecutive outcomes should cluster
    let maxUpStreak = 0, maxDownStreak = 0;
    let currentStreak = 1;
    for (let i = 1; i < outcomes.length; i++) {
        if (outcomes[i] === outcomes[i-1]) {
            currentStreak++;
        } else {
            if (outcomes[i-1] === 'UP') maxUpStreak = Math.max(maxUpStreak, currentStreak);
            else maxDownStreak = Math.max(maxDownStreak, currentStreak);
            currentStreak = 1;
        }
    }
    console.log(`\nMax UP streak: ${maxUpStreak} | Max DOWN streak: ${maxDownStreak}`);

    // Autocorrelation: P(same outcome as previous)
    let sameCount = 0;
    for (let i = 1; i < outcomes.length; i++) {
        if (outcomes[i] === outcomes[i-1]) sameCount++;
    }
    const autocorr = sameCount / (outcomes.length - 1);
    console.log(`P(same as previous): ${(autocorr * 100).toFixed(1)}% (50% = random, >50% = momentum, <50% = mean-revert)`);

    // Volume analysis
    volumes.sort((a, b) => a - b);
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const medVol = volumes[Math.floor(volumes.length / 2)];
    console.log(`\nVolume: Avg $${avgVol.toFixed(0)} | Median $${medVol.toFixed(0)} | Min $${volumes[0]?.toFixed(0)} | Max $${volumes[volumes.length-1]?.toFixed(0)}`);

    // Volume by time of day (rough estimate from offset)
    console.log('\nVolume by recency (proxy for time of day):');
    for (let bucket = 0; bucket < 4; bucket++) {
        const start = bucket * 50;
        const end = (bucket + 1) * 50;
        const bucketVols = volumes.slice(start, end);
        if (bucketVols.length === 0) continue;
        const avg = bucketVols.reduce((a, b) => a + b, 0) / bucketVols.length;
        console.log(`  Markets ${start}-${end}: Avg vol $${avg.toFixed(0)}`);
    }

    // 2. Current market deep book analysis
    console.log('\n\n--- Current Market Deep Book ---\n');

    const currentMarket = await (async () => {
        for (const ts of [rounded, rounded + 300]) {
            const data = await fetchJSON(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
            if (data?.length > 0) {
                const m = data[0];
                if (new Date(m.endDate).getTime() > Date.now()) return m;
            }
        }
        return null;
    })();

    if (!currentMarket) {
        console.log('No active market found');
        return;
    }

    console.log(`Market: ${currentMarket.question}`);
    const tokenIds = JSON.parse(currentMarket.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];

    const [upBook, downBook] = await Promise.all([
        fetchJSON(`${CLOB}/book?token_id=${upToken}`),
        fetchJSON(`${CLOB}/book?token_id=${downToken}`),
    ]);

    const formatBook = (raw: any, label: string) => {
        if (!raw) return;
        const bids = (raw.bids || []).map((b: any) => ({ p: parseFloat(b.price), s: parseFloat(b.size) })).sort((a: any, b: any) => b.p - a.p);
        const asks = (raw.asks || []).map((a: any) => ({ p: parseFloat(a.price), s: parseFloat(a.size) })).sort((a: any, b: any) => a.p - b.p);

        console.log(`\n${label} Book:`);
        console.log('  Asks (selling pressure):');
        for (const a of asks.slice(0, 8)) {
            const bar = '#'.repeat(Math.min(50, Math.round(a.s / 20)));
            console.log(`    ${a.p.toFixed(3)} | $${a.s.toFixed(0).padStart(6)} | ${bar}`);
        }
        console.log('  --- spread ---');
        for (const b of bids.slice(0, 8)) {
            const bar = '#'.repeat(Math.min(50, Math.round(b.s / 20)));
            console.log(`    ${b.p.toFixed(3)} | $${b.s.toFixed(0).padStart(6)} | ${bar}`);
        }
        console.log('  Bids (buying pressure):');

        return { bids, asks };
    };

    const upData = formatBook(upBook, 'UP');
    const downData = formatBook(downBook, 'DOWN');

    if (upData && downData) {
        const upBestBid = upData.bids[0]?.p ?? 0;
        const upBestAsk = upData.asks[0]?.p ?? 1;
        const downBestBid = downData.bids[0]?.p ?? 0;
        const downBestAsk = downData.asks[0]?.p ?? 1;

        console.log('\n--- Cross-Token Analysis ---');
        console.log(`Up:   bid ${upBestBid.toFixed(3)} / ask ${upBestAsk.toFixed(3)} (spread ${((upBestAsk - upBestBid) * 100).toFixed(1)}c)`);
        console.log(`Down: bid ${downBestBid.toFixed(3)} / ask ${downBestAsk.toFixed(3)} (spread ${((downBestAsk - downBestBid) * 100).toFixed(1)}c)`);

        const overround = upBestAsk + downBestAsk - 1.0;
        const underround = 1.0 - upBestBid - downBestBid;
        console.log(`\nOverround (taker cost): ${(overround * 100).toFixed(2)}c`);
        console.log(`Underround (maker gap): ${(underround * 100).toFixed(2)}c`);

        // Taker arb check
        const upTakerFee = upBestAsk * (1 - upBestAsk);
        const downTakerFee = downBestAsk * (1 - downBestAsk);
        const totalTakerCost = upBestAsk + downBestAsk + upTakerFee + downTakerFee;
        console.log(`\nTaker arb (buy both asks + fees): $${totalTakerCost.toFixed(4)}`);
        console.log(`Taker arb profitable: ${totalTakerCost < 1.0 ? `YES! Profit: ${((1 - totalTakerCost) * 100).toFixed(2)}c` : `NO (cost ${((totalTakerCost - 1) * 100).toFixed(2)}c over)`}`);

        // Maker arb: post bids on both
        console.log(`\nMaker arb (post bids on both, 0% fee):`);
        console.log(`  If we bid Up@${upBestBid.toFixed(3)} + Down@${downBestBid.toFixed(3)} = $${(upBestBid + downBestBid).toFixed(4)}`);
        console.log(`  Profit if both fill: $${(1 - upBestBid - downBestBid).toFixed(4)} = ${((1 - upBestBid - downBestBid) * 100).toFixed(2)}%`);

        // What if we improve both bids by 1 tick?
        const improvedUp = upBestBid + 0.01;
        const improvedDown = downBestBid + 0.01;
        console.log(`  If we bid Up@${improvedUp.toFixed(3)} + Down@${improvedDown.toFixed(3)} = $${(improvedUp + improvedDown).toFixed(4)}`);
        console.log(`  Profit if both fill: $${(1 - improvedUp - improvedDown).toFixed(4)} = ${((1 - improvedUp - improvedDown) * 100).toFixed(2)}%`);

        // What's the maximum we can bid and still profit?
        const maxTotalBid = 0.999; // Need some profit
        const maxPerSide = maxTotalBid / 2;
        console.log(`  Max bid per side for breakeven: ${maxPerSide.toFixed(3)}`);

        // 3. Fee structure analysis
        console.log('\n\n--- Fee Structure Deep Dive ---');
        console.log('Maker fee: 0% (100% rebate)');
        console.log('Taker fee: p * (1-p) where p = price');
        console.log('\nTaker fees by price level:');
        for (const p of [0.10, 0.20, 0.30, 0.40, 0.50, 0.60, 0.70, 0.80, 0.90]) {
            const fee = p * (1 - p);
            console.log(`  Price ${(p*100).toFixed(0)}c → Fee: ${(fee * 100).toFixed(2)}c (${((fee/p)*100).toFixed(1)}% of cost)`);
        }
        console.log('\nKey insight: Taker fee is MAX at 50c (25c fee = 50% of cost!)');
        console.log('This means takers at 50/50 pay 25% effective fee.');
        console.log('Makers at 50/50 pay 0%. This is a MASSIVE structural advantage.');

        // Calculate expected returns for maker MM at 50/50
        console.log('\n\n--- Expected Returns: Symmetric Maker MM ---');
        const scenarios = [
            { bid: 0.48, ask: 0.52, label: '48/52 (4c spread)' },
            { bid: 0.49, ask: 0.51, label: '49/51 (2c spread)' },
            { bid: 0.47, ask: 0.53, label: '47/53 (6c spread)' },
            { bid: 0.45, ask: 0.55, label: '45/55 (10c spread)' },
        ];

        for (const { bid, ask, label } of scenarios) {
            const spread = ask - bid;
            // If both fill: profit = spread per $1
            // If only bid fills and UP: profit = 1 - bid
            // If only bid fills and DOWN: loss = bid
            // If only ask fills and UP: loss = 1 - ask
            // If only ask fills and DOWN: profit = ask

            // Expected PnL assuming p_both = 0.5, p_one_side = 0.25 each, p_neither = 0.0
            // (Very rough — we'll refine with live data)
            const pBoth = 0.50;
            const pBidOnly = 0.25;
            const pAskOnly = 0.25;

            const bothPnL = spread;
            // Bid-only: 50% UP → +1-bid, 50% DOWN → -bid
            const bidOnlyPnL = 0.5 * (1 - bid) + 0.5 * (-bid);
            // Ask-only: 50% UP → -(1-ask), 50% DOWN → +ask
            const askOnlyPnL = 0.5 * (-(1 - ask)) + 0.5 * ask;

            const expectedPnL = pBoth * bothPnL + pBidOnly * bidOnlyPnL + pAskOnly * askOnlyPnL;

            console.log(`  ${label}: ` +
                `Both=${(bothPnL*100).toFixed(1)}c | ` +
                `BidOnly=${(bidOnlyPnL*100).toFixed(1)}c | ` +
                `AskOnly=${(askOnlyPnL*100).toFixed(1)}c | ` +
                `Expected=${(expectedPnL*100).toFixed(2)}c per $1`
            );
        }

        console.log('\nNote: bid-only and ask-only PnL near 50c is ~0 (fair coin flip).');
        console.log('The ENTIRE edge comes from both-fill scenarios (spread capture).');
        console.log('So the key question is: what is the real P(both fill)?');
    }
}

main().catch(console.error);
