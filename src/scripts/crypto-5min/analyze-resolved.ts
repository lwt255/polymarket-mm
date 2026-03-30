/**
 * Analyze Recently Resolved 5-Min BTC Markets
 *
 * Fetches resolved markets to understand:
 * - What final prices looked like before resolution
 * - Volume distribution during the 5-min window
 * - How prices evolved from 50/50 to resolution
 * - Win/loss patterns
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

async function fetchJSON(url: string): Promise<any> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`${resp.status} ${resp.statusText}: ${url}`);
    return resp.json();
}

interface ResolvedMarket {
    question: string;
    slug: string;
    conditionId: string;
    clobTokenIds: string;
    outcomes: string;
    outcomePrices: string;
    volume: string;
    liquidity: string;
    endDate: string;
    eventStartTime?: string;
    startDate: string;
    closed: boolean;
    resolution?: string;
}

async function main() {
    console.log('=== Analysis of Resolved 5-Min BTC Markets ===\n');

    // Fetch recently closed BTC 5-min markets
    const markets: ResolvedMarket[] = await fetchJSON(
        `${GAMMA_API}/markets?closed=true&limit=100&order=endDate&ascending=false`
    );

    const btc5min = markets.filter((m: any) => {
        const q = (m.question || '').toLowerCase();
        return q.includes('bitcoin') && q.includes('up or down') &&
            !q.includes('hourly') && !q.includes('daily') && !q.includes('4h') &&
            !q.includes('15m') && !q.includes('weekly');
    });

    console.log(`Found ${btc5min.length} recently resolved BTC 5-min markets\n`);

    // Analyze outcomes
    let upWins = 0;
    let downWins = 0;
    let totalVolume = 0;
    const volumes: number[] = [];

    for (const m of btc5min) {
        const prices = JSON.parse(m.outcomePrices || '["0","0"]').map(Number);
        const vol = parseFloat(m.volume || '0');
        totalVolume += vol;
        volumes.push(vol);

        // Resolution: if Up price = 1, Up won
        if (prices[0] >= 0.95) upWins++;
        else if (prices[1] >= 0.95) downWins++;
    }

    console.log('=== Resolution Statistics ===');
    console.log(`Total markets: ${btc5min.length}`);
    console.log(`Up wins: ${upWins} (${((upWins / btc5min.length) * 100).toFixed(1)}%)`);
    console.log(`Down wins: ${downWins} (${((downWins / btc5min.length) * 100).toFixed(1)}%)`);
    console.log(`Unresolved/other: ${btc5min.length - upWins - downWins}`);
    console.log(`Total volume: $${totalVolume.toLocaleString()}`);
    if (volumes.length > 0) {
        const avgVol = totalVolume / volumes.length;
        const sortedVols = [...volumes].sort((a, b) => a - b);
        const medianVol = sortedVols[Math.floor(sortedVols.length / 2)];
        console.log(`Avg volume per market: $${avgVol.toFixed(0)}`);
        console.log(`Median volume per market: $${medianVol.toFixed(0)}`);
        console.log(`Max volume: $${Math.max(...volumes).toFixed(0)}`);
        console.log(`Min volume: $${Math.min(...volumes).toFixed(0)}`);
    }

    // Show the most recent 20 with details
    console.log('\n=== Recent 20 Resolved Markets ===');
    console.log('Time Window'.padEnd(55) + 'Result'.padEnd(8) + 'Volume'.padStart(10));
    console.log('-'.repeat(73));

    for (const m of btc5min.slice(0, 20)) {
        const prices = JSON.parse(m.outcomePrices || '["0","0"]').map(Number);
        const result = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : '???';
        const vol = parseFloat(m.volume || '0');
        console.log(`${m.question.padEnd(55)} ${result.padEnd(8)} $${vol.toFixed(0).padStart(8)}`);
    }

    // Fetch price history for a few resolved markets to see the price evolution
    console.log('\n\n=== Price Evolution During 5-Min Window ===');
    console.log('(How did odds move from open to close?)\n');

    for (const m of btc5min.slice(0, 5)) {
        const tokenIds = JSON.parse(m.clobTokenIds || '[]');
        if (tokenIds.length === 0) continue;

        const upTokenId = tokenIds[0];
        console.log(`--- ${m.question} ---`);

        // Try fetching price history from CLOB
        try {
            const eventStart = m.eventStartTime ? new Date(m.eventStartTime) : new Date(m.startDate);
            const endDate = new Date(m.endDate);
            const startTs = Math.floor(eventStart.getTime() / 1000);
            const endTs = Math.floor(endDate.getTime() / 1000);

            const history = await fetchJSON(
                `${CLOB_API}/prices-history?market=${m.conditionId}&interval=1m&fidelity=10&start_ts=${startTs}&end_ts=${endTs}`
            );

            const points = history?.history || [];
            if (points.length > 0) {
                console.log(`  ${points.length} price points during the window:`);
                for (const p of points) {
                    const time = new Date(p.t * 1000).toLocaleTimeString();
                    const price = parseFloat(p.p);
                    const bar = '|'.repeat(Math.round(price * 50));
                    console.log(`    ${time} | ${(price * 100).toFixed(1)}% ${bar}`);
                }
            } else {
                console.log('  No price history available for this window');
            }
        } catch (err) {
            console.log(`  Error fetching price history: ${(err as Error).message}`);
        }

        // Also try fetching trades
        try {
            const trades = await fetchJSON(
                `${CLOB_API}/trades?asset_id=${upTokenId}&limit=50`
            );

            const tradeList = trades || [];
            if (tradeList.length > 0) {
                console.log(`\n  Recent trades (${tradeList.length}):`);
                for (const t of tradeList.slice(0, 10)) {
                    const time = new Date(t.match_time || t.created_at).toLocaleTimeString();
                    const price = parseFloat(t.price);
                    const size = parseFloat(t.size);
                    const side = t.side;
                    console.log(`    ${time} | ${side?.padEnd(4)} | $${size.toFixed(0).padStart(6)} @ ${(price * 100).toFixed(1)}%`);
                }
                if (tradeList.length > 10) {
                    console.log(`    ... and ${tradeList.length - 10} more trades`);
                }
            }
        } catch (err) {
            console.log(`  Error fetching trades: ${(err as Error).message}`);
        }

        console.log('');
    }

    // Volume distribution analysis
    console.log('\n=== Volume Distribution ===');
    const volBuckets = [0, 100, 500, 1000, 5000, 10000, 50000, 100000, Infinity];
    for (let i = 0; i < volBuckets.length - 1; i++) {
        const count = volumes.filter(v => v >= volBuckets[i] && v < volBuckets[i + 1]).length;
        const label = volBuckets[i + 1] === Infinity
            ? `$${volBuckets[i].toLocaleString()}+`
            : `$${volBuckets[i].toLocaleString()}-$${volBuckets[i + 1].toLocaleString()}`;
        const bar = '#'.repeat(count);
        console.log(`  ${label.padEnd(20)} | ${count.toString().padStart(3)} markets | ${bar}`);
    }

    // Streak analysis (consecutive Up or Down)
    console.log('\n=== Streak Analysis ===');
    let currentStreak = 0;
    let currentResult = '';
    let maxUpStreak = 0;
    let maxDownStreak = 0;
    const streaks: { result: string; length: number }[] = [];

    for (const m of btc5min.reverse()) { // oldest first
        const prices = JSON.parse(m.outcomePrices || '["0","0"]').map(Number);
        const result = prices[0] >= 0.95 ? 'UP' : prices[1] >= 0.95 ? 'DOWN' : '';
        if (!result) continue;

        if (result === currentResult) {
            currentStreak++;
        } else {
            if (currentStreak > 0) {
                streaks.push({ result: currentResult, length: currentStreak });
            }
            currentResult = result;
            currentStreak = 1;
        }

        if (result === 'UP') maxUpStreak = Math.max(maxUpStreak, currentStreak);
        if (result === 'DOWN') maxDownStreak = Math.max(maxDownStreak, currentStreak);
    }
    if (currentStreak > 0) streaks.push({ result: currentResult, length: currentStreak });

    console.log(`Max UP streak: ${maxUpStreak}`);
    console.log(`Max DOWN streak: ${maxDownStreak}`);
    console.log(`Streak distribution:`);
    for (let len = 1; len <= Math.max(maxUpStreak, maxDownStreak); len++) {
        const upCount = streaks.filter(s => s.result === 'UP' && s.length === len).length;
        const downCount = streaks.filter(s => s.result === 'DOWN' && s.length === len).length;
        if (upCount + downCount > 0) {
            console.log(`  Length ${len}: ${upCount} UP streaks, ${downCount} DOWN streaks`);
        }
    }
}

main().catch(console.error);
