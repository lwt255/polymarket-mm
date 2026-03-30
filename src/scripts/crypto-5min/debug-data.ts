/**
 * Debug data availability for 5-min crypto markets
 * Tests different API endpoints to find trade/price data
 */

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

async function fetchJSON(url: string) {
    const resp = await fetch(url);
    if (!resp.ok) return { error: `${resp.status} ${resp.statusText}`, url };
    return resp.json();
}

async function getMarket(offset: number) {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    const ts = rounded - (offset * 300);
    const resp = await fetch(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
    const data = await resp.json();
    return data[0] || null;
}

async function main() {
    // Get a recently resolved market (offset 4 = 20 min ago, definitely resolved)
    const m = await getMarket(4);
    if (!m) {
        console.log('No market found');
        return;
    }

    console.log(`Market: ${m.question}`);
    console.log(`ConditionId: ${m.conditionId}`);
    const tokenIds = JSON.parse(m.clobTokenIds || '[]');
    const upToken = tokenIds[0];
    const downToken = tokenIds[1];
    console.log(`Up token: ${upToken}`);
    console.log(`Down token: ${downToken}`);

    const eventStart = m.eventStartTime ? new Date(m.eventStartTime) : new Date(m.endDate);
    const endDate = new Date(m.endDate);
    const startTs = Math.floor(eventStart.getTime() / 1000) - 300;
    const endTs = Math.floor(endDate.getTime() / 1000) + 60;

    console.log(`\nEvent window: ${eventStart.toLocaleString()} - ${endDate.toLocaleString()}`);
    console.log(`Query range: ${startTs} - ${endTs}`);

    // Test different price history approaches
    console.log('\n=== Test 1: prices-history with conditionId ===');
    const r1 = await fetchJSON(`${CLOB}/prices-history?market=${m.conditionId}&interval=1m&fidelity=10&start_ts=${startTs}&end_ts=${endTs}`);
    console.log(JSON.stringify(r1).slice(0, 300));

    console.log('\n=== Test 2: prices-history with Up token ID ===');
    const r2 = await fetchJSON(`${CLOB}/prices-history?market=${upToken}&interval=1m&fidelity=10&start_ts=${startTs}&end_ts=${endTs}`);
    console.log(JSON.stringify(r2).slice(0, 300));

    console.log('\n=== Test 3: prices-history with token_id param ===');
    const r3 = await fetchJSON(`${CLOB}/prices-history?token_id=${upToken}&interval=1m&fidelity=10&start_ts=${startTs}&end_ts=${endTs}`);
    console.log(JSON.stringify(r3).slice(0, 300));

    // Test midpoint endpoint
    console.log('\n=== Test 4: midpoint ===');
    const r4 = await fetchJSON(`${CLOB}/midpoint?token_id=${upToken}`);
    console.log(JSON.stringify(r4));

    // Test last-trade-price
    console.log('\n=== Test 5: last-trade-price ===');
    const r5 = await fetchJSON(`${CLOB}/last-trade-price?token_id=${upToken}`);
    console.log(JSON.stringify(r5));

    // Test tick-size (market info)
    console.log('\n=== Test 6: tick-size (market info) ===');
    const r6 = await fetchJSON(`${CLOB}/tick-size?token_id=${upToken}`);
    console.log(JSON.stringify(r6));

    // Test the simplified-markets endpoint
    console.log('\n=== Test 7: simplified-markets ===');
    const r7 = await fetchJSON(`${CLOB}/simplified-markets?market=${m.conditionId}`);
    console.log(JSON.stringify(r7).slice(0, 500));

    // Test the current open market instead (most recent)
    console.log('\n\n=== CURRENT OPEN MARKET ===');
    const openMarket = await getMarket(0);
    if (openMarket) {
        console.log(`Market: ${openMarket.question}`);
        console.log(`Prices: ${openMarket.outcomePrices}`);
        console.log(`Volume: $${parseFloat(openMarket.volume || '0').toFixed(0)}`);
        console.log(`Active: ${openMarket.active}`);
        console.log(`AcceptingOrders: ${openMarket.acceptingOrders}`);

        const openTokens = JSON.parse(openMarket.clobTokenIds || '[]');
        if (openTokens[0]) {
            console.log('\nOpen market midpoint:');
            const mid = await fetchJSON(`${CLOB}/midpoint?token_id=${openTokens[0]}`);
            console.log(JSON.stringify(mid));

            console.log('\nOpen market last trade:');
            const lt = await fetchJSON(`${CLOB}/last-trade-price?token_id=${openTokens[0]}`);
            console.log(JSON.stringify(lt));
        }
    }

    // Fetch 100 resolved markets to do statistical analysis
    console.log('\n\n=== BULK STATISTICS (100 markets) ===');
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;
    let ups = 0, downs = 0, totalVol = 0;
    const vols: number[] = [];

    for (let i = 2; i <= 101; i++) {
        const ts = rounded - (i * 300);
        try {
            const resp = await fetch(`${GAMMA}/markets?slug=btc-updown-5m-${ts}`);
            const data = await resp.json();
            if (data.length > 0) {
                const market = data[0];
                const prices = JSON.parse(market.outcomePrices || '[]').map(Number);
                const vol = parseFloat(market.volume || '0');
                if (prices[0] >= 0.95) ups++;
                else if (prices[1] >= 0.95) downs++;
                totalVol += vol;
                vols.push(vol);
            }
        } catch {}
    }

    console.log(`Markets analyzed: ${ups + downs}`);
    console.log(`Up wins: ${ups} (${((ups / (ups + downs)) * 100).toFixed(1)}%)`);
    console.log(`Down wins: ${downs} (${((downs / (ups + downs)) * 100).toFixed(1)}%)`);
    console.log(`Total volume: $${totalVol.toLocaleString()}`);
    console.log(`Avg volume/market: $${(totalVol / vols.length).toFixed(0)}`);
    console.log(`Median volume: $${vols.sort((a, b) => a - b)[Math.floor(vols.length / 2)]?.toFixed(0)}`);
    console.log(`Time span: ~${((ups + downs) * 5 / 60).toFixed(1)} hours`);
}

main().catch(console.error);
