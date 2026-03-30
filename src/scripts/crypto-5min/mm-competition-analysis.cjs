/**
 * Analyze the MM landscape: how many makers, depth concentration, etc.
 * Using our existing straddle study data which has book snapshots.
 */
const data = JSON.parse(require('fs').readFileSync('split-straddle-results.json', 'utf8'));

console.log('=== MM COMPETITION ANALYSIS ===\n');
console.log('Candles analyzed:', data.length);

// Collect all book data from stratB checkpoints
let totalCheckpoints = 0;
let bidSizes = [];
let bidDepths = [];
let loserBids = [];

for (const c of data) {
    for (const cp of (c.stratB_checkpoints || [])) {
        totalCheckpoints++;
        if (cp.loserBid > 0) loserBids.push(cp.loserBid);
        if (cp.loserBidSize > 0) bidSizes.push(cp.loserBidSize);
    }
}

console.log('Total checkpoints:', totalCheckpoints);
console.log('Bid sizes captured:', bidSizes.length);

if (bidSizes.length > 0) {
    bidSizes.sort((a, b) => a - b);
    const avg = bidSizes.reduce((a, b) => a + b, 0) / bidSizes.length;
    const median = bidSizes[Math.floor(bidSizes.length / 2)];
    const p90 = bidSizes[Math.floor(bidSizes.length * 0.9)];

    console.log('\n--- Loser Token Best Bid Size ---');
    console.log('  Min:', bidSizes[0].toFixed(0));
    console.log('  Median:', median.toFixed(0));
    console.log('  Mean:', avg.toFixed(0));
    console.log('  P90:', p90.toFixed(0));
    console.log('  Max:', bidSizes[bidSizes.length - 1].toFixed(0));

    // Distribution
    const buckets = [0, 50, 100, 500, 1000, 5000, 10000, 50000, 100000];
    console.log('\n  Size distribution:');
    for (let i = 0; i < buckets.length - 1; i++) {
        const count = bidSizes.filter(s => s >= buckets[i] && s < buckets[i + 1]).length;
        if (count > 0) {
            console.log('    $' + buckets[i] + '-$' + buckets[i + 1] + ': ' + count + ' (' + (count / bidSizes.length * 100).toFixed(0) + '%)');
        }
    }
    const bigOnes = bidSizes.filter(s => s >= buckets[buckets.length - 1]).length;
    if (bigOnes > 0) console.log('    $' + buckets[buckets.length - 1] + '+: ' + bigOnes + ' (' + (bigOnes / bidSizes.length * 100).toFixed(0) + '%)');
}

// Revenue analysis: what does the MM actually make?
console.log('\n--- MM Revenue Model (1c spread, both sides) ---');
console.log('Assumptions:');
console.log('  - 1c spread = buy at 49c, sell at 50c (or equivalent)');
console.log('  - Per round trip: $1 per $100 notional');
console.log('  - 288 candles/day');
console.log('  - Must exit before resolution (MM pulls book at T-15s)');
console.log();

// From our data: avg volume per candle
const volumes = data.filter(c => c.volume > 0).map(c => c.volume);
if (volumes.length > 0) {
    const avgVol = volumes.reduce((a, b) => a + b, 0) / volumes.length;
    const medVol = volumes.sort((a, b) => a - b)[Math.floor(volumes.length / 2)];
    console.log('Volume per candle:');
    console.log('  Avg: $' + avgVol.toFixed(0));
    console.log('  Median: $' + medVol.toFixed(0));

    // If MM captures 50% of volume on each side
    const mmCapture = avgVol * 0.3; // assume 30% of volume goes through MM
    const spreadCapture = mmCapture * 0.01; // 1c per dollar
    console.log('\nIf MM captures 30% of volume:');
    console.log('  Per candle: $' + spreadCapture.toFixed(2) + ' spread profit');
    console.log('  Per day (288): $' + (spreadCapture * 288).toFixed(0));
    console.log('  Per day (peak 8h, 96 candles, 3x vol): $' + (spreadCapture * 3 * 96).toFixed(0));
}

// What $50K of capital gets you
console.log('\n--- What $50K Capital Gets You ---');
console.log('Option A: Compete as MM');
console.log('  - Deploy $25K UP side + $25K DOWN side');
console.log('  - Quote 1c spread to match incumbent');
console.log('  - Problem: incumbent adjusts price 58-70% of seconds');
console.log('  - If you are slower, you get adversely selected');
console.log('  - Your stale quotes get picked off by takers');
console.log('  - You need: low-latency Chainlink feed + fast order updates');
console.log();
console.log('Option B: Quote wider (2c spread)');
console.log('  - Less adverse selection risk');
console.log('  - But incumbent fills orders before you (they are tighter)');
console.log('  - You only get filled when the move is big enough to skip the 1c book');
console.log('  - Those are exactly the directional moves = adverse selection');
console.log();
console.log('Option C: Provide depth behind incumbent');
console.log('  - Post at 48c/52c (behind the 49c/51c incumbent)');
console.log('  - Only fill when big orders eat through the top book');
console.log('  - Lower fill rate but earn liquidity rewards');
console.log('  - Capital mostly sits idle');

console.log('\n--- Key Question: How Many MMs? ---');
console.log('From book data observation:');
console.log('  - Bid/ask books show 25-30 orders per side');
console.log('  - But depth is concentrated: top 1-2 levels hold most size');
console.log('  - Mirrored books (UP asks = DOWN bids) suggest one dominant player');
console.log('  - Likely 1 dominant MM + a few smaller participants');
console.log('  - The dominant MM captures most of the spread');
