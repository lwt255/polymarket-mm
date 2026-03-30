/**
 * Pricing Pattern Analyzer
 *
 * Analyzes collected pricing data to find "irregular patterns" in
 * how the market prices BTC 5-minute outcomes.
 *
 * Key questions:
 * 1. CALIBRATION: When market says 60% UP, does UP actually win 60%?
 * 2. MISPRICING ZONES: Are certain probability ranges systematically wrong?
 * 3. SPREAD SIGNALS: Do unusual spreads predict outcomes?
 * 4. BID SUM: Does upBid + downBid deviation from 1.0 predict anything?
 * 5. DRIFT: Does the direction of probability drift predict outcomes?
 * 6. DEPTH IMBALANCE: Does bid depth asymmetry predict outcomes?
 *
 * Usage: npx tsx src/scripts/pricing-analyzer.ts
 */

import { readFileSync } from 'node:fs';
import { findTradableSnapshotInWindow, isTradableSnapshot } from './pricing-data-utils.js';

const DATA_FILE = process.argv[2] || 'pricing-data.raw.jsonl';

interface BookSnapshot {
    timestamp: number;
    secondsBeforeEnd: number;
    upBid: number;
    upAsk: number;
    upSpread: number;
    upBidDepth: number;
    upAskDepth: number;
    downBid: number;
    downAsk: number;
    downSpread: number;
    downBidDepth: number;
    downAskDepth: number;
    upMid: number;
    downMid: number;
    impliedUpProb: number;
    bidSumCheck: number;
    askSumCheck: number;
}

interface MarketRecord {
    slug: string;
    marketEnd: number;
    snapshots: BookSnapshot[];
    resolution: 'UP' | 'DOWN' | 'UNKNOWN';
    chainlinkOpen: number;
    chainlinkClose: number;
    chainlinkMoveDollars: number;
    openUpBid: number;
    openDownBid: number;
    finalUpBid: number;
    finalDownBid: number;
}

function pickAnalysisSnapshot(m: MarketRecord): BookSnapshot {
    return findTradableSnapshotInWindow(m.snapshots, 55, 65)
        || m.snapshots.find(isTradableSnapshot)
        || m.snapshots[Math.floor(m.snapshots.length / 2)]
        || m.snapshots[0];
}

function loadData(): MarketRecord[] {
    let raw: string;
    try {
        raw = readFileSync(DATA_FILE, 'utf8').trim();
    } catch (err: any) {
        console.error(`Could not read ${DATA_FILE}: ${err.message}`);
        console.error('Run the collector first:');
        console.error('  nohup ./node_modules/.bin/tsx src/scripts/pricing-collector.ts --duration 480 >> pricing-collector.out 2>&1 &');
        process.exit(1);
    }
    const lines = raw.split('\n').filter(Boolean);
    const records: MarketRecord[] = [];
    for (let i = 0; i < lines.length; i++) {
        try {
            const r = JSON.parse(lines[i]);
            if (r.resolution !== 'UNKNOWN') records.push(r);
        } catch {
            console.error(`Warning: skipping malformed line ${i + 1}`);
        }
    }
    return records;
}

function pct(n: number, d: number): string {
    return d === 0 ? 'N/A' : `${(n / d * 100).toFixed(1)}%`;
}

// --- Analysis 1: Calibration ---
// When market says X% UP, does UP actually win X% of the time?
function analyzeCalibration(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('1. CALIBRATION: Market Probability vs Actual Win Rate');
    console.log('='.repeat(60));
    console.log('Does the market accurately price outcomes?\n');

    // Use the earliest snapshot's implied probability
    const buckets: Record<string, { total: number; upWins: number }> = {};
    const bucketSize = 5; // 5% buckets

    for (const m of data) {
        // Use snapshot closest to T-60s (1 min before end) if available
        const snap = pickAnalysisSnapshot(m);

        const impliedUp = snap.impliedUpProb * 100;
        const bucket = Math.floor(impliedUp / bucketSize) * bucketSize;
        const key = `${bucket}-${bucket + bucketSize}%`;

        if (!buckets[key]) buckets[key] = { total: 0, upWins: 0 };
        buckets[key].total++;
        if (m.resolution === 'UP') buckets[key].upWins++;
    }

    console.log(`${'Range'.padEnd(12)} ${'Count'.padStart(6)} ${'Actual UP%'.padStart(12)} ${'Expected'.padStart(10)} ${'Edge'.padStart(8)}`);
    console.log('-'.repeat(52));

    const sortedKeys = Object.keys(buckets).sort((a, b) => {
        return parseInt(a) - parseInt(b);
    });

    for (const key of sortedKeys) {
        const b = buckets[key];
        const actualRate = b.upWins / b.total;
        const expected = (parseInt(key) + bucketSize / 2) / 100;
        const edge = actualRate - expected;
        const edgeStr = edge > 0 ? `+${(edge * 100).toFixed(1)}%` : `${(edge * 100).toFixed(1)}%`;
        console.log(`${key.padEnd(12)} ${String(b.total).padStart(6)} ${pct(b.upWins, b.total).padStart(12)} ${(expected * 100).toFixed(0).padStart(9)}% ${edgeStr.padStart(8)}`);
    }
}

// --- Analysis 2: Bid Sum Anomalies ---
// upBid + downBid should theoretically be < 1.0 (the gap is the market's edge)
// Does the size of this gap predict anything?
function analyzeBidSum(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('2. BID SUM ANALYSIS: Does bid gap predict outcomes?');
    console.log('='.repeat(60));
    console.log('upBid + downBid gap from 1.0 — does a larger gap signal mispricing?\n');

    const buckets: Record<string, { total: number; favoriteWins: number; avgGap: number }> = {};

    for (const m of data) {
        const snap = pickAnalysisSnapshot(m);

        const bidSum = snap.upBid + snap.downBid;
        const gap = 1.0 - bidSum;
        const gapCents = Math.round(Math.abs(gap) * 100); // abs for negative gaps too

        // Who's the favorite?
        const favorite = snap.upBid > snap.downBid ? 'UP' : 'DOWN';
        const favoriteWon = m.resolution === favorite;

        // Track if sum > 1.0 (negative gap = potential arb)
        const bucketKey = gap < 0 ? 'Negative (arb)' :
                          gapCents <= 2 ? '0-2¢' :
                          gapCents <= 5 ? '3-5¢' :
                          gapCents <= 10 ? '6-10¢' :
                          gapCents <= 20 ? '11-20¢' : '21+¢';

        if (!buckets[bucketKey]) buckets[bucketKey] = { total: 0, favoriteWins: 0, avgGap: 0 };
        buckets[bucketKey].total++;
        buckets[bucketKey].avgGap += gap;
        if (favoriteWon) buckets[bucketKey].favoriteWins++;
    }

    console.log(`${'Gap'.padEnd(10)} ${'Count'.padStart(6)} ${'Favorite Wins'.padStart(15)} ${'Avg Gap'.padStart(10)}`);
    console.log('-'.repeat(45));

    for (const key of ['Negative (arb)', '0-2¢', '3-5¢', '6-10¢', '11-20¢', '21+¢']) {
        const b = buckets[key];
        if (!b) continue;
        console.log(`${key.padEnd(15)} ${String(b.total).padStart(6)} ${pct(b.favoriteWins, b.total).padStart(15)} ${(b.avgGap / b.total * 100).toFixed(1).padStart(9)}¢`);
    }
}

// --- Analysis 3: Spread Patterns ---
// Does a wider spread on one side predict the other side winning?
function analyzeSpreadAsymmetry(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('3. SPREAD ASYMMETRY: Does spread difference predict outcomes?');
    console.log('='.repeat(60));
    console.log('If UP spread >> DOWN spread, does that signal anything?\n');

    const buckets: Record<string, { total: number; widerSpreadSideWins: number }> = {};

    for (const m of data) {
        const snap = pickAnalysisSnapshot(m);

        const spreadDiff = Math.abs(snap.upSpread - snap.downSpread) * 100;
        // Skip if spreads are identical (no signal)
        if (snap.upSpread === snap.downSpread) continue;
        const widerSide = snap.upSpread > snap.downSpread ? 'UP' : 'DOWN';
        const widerSideWon = m.resolution === widerSide;

        const key = spreadDiff < 1 ? '<1¢ diff' :
                    spreadDiff < 3 ? '1-3¢ diff' :
                    spreadDiff < 5 ? '3-5¢ diff' : '5+¢ diff';

        if (!buckets[key]) buckets[key] = { total: 0, widerSpreadSideWins: 0 };
        buckets[key].total++;
        if (widerSideWon) buckets[key].widerSpreadSideWins++;
    }

    console.log(`${'Spread Diff'.padEnd(12)} ${'Count'.padStart(6)} ${'Wider Spread Side Wins'.padStart(25)}`);
    console.log('-'.repeat(45));

    for (const key of ['<1¢ diff', '1-3¢ diff', '3-5¢ diff', '5+¢ diff']) {
        const b = buckets[key];
        if (!b) continue;
        console.log(`${key.padEnd(12)} ${String(b.total).padStart(6)} ${pct(b.widerSpreadSideWins, b.total).padStart(25)}`);
    }
}

// --- Analysis 4: Probability Drift ---
// Does the direction of probability change predict the outcome?
function analyzeDrift(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('4. PROBABILITY DRIFT: Does price movement predict outcome?');
    console.log('='.repeat(60));
    console.log('If UP bid is rising over snapshots, does UP win more?\n');

    let driftUpCorrect = 0, driftUpTotal = 0;
    let driftDownCorrect = 0, driftDownTotal = 0;
    let flatTotal = 0, flatCorrect = 0;

    for (const m of data) {
        if (m.snapshots.length < 3) continue;

        const first = m.snapshots[0];
        const last = m.snapshots[m.snapshots.length - 1];
        const drift = last.upBid - first.upBid;

        if (drift > 0.02) {
            // UP bid rising → expect UP
            driftUpTotal++;
            if (m.resolution === 'UP') driftUpCorrect++;
        } else if (drift < -0.02) {
            // UP bid falling → expect DOWN
            driftDownTotal++;
            if (m.resolution === 'DOWN') driftDownCorrect++;
        } else {
            flatTotal++;
            // For flat, check if favorite won
            const fav = last.upBid > last.downBid ? 'UP' : 'DOWN';
            if (m.resolution === fav) flatCorrect++;
        }
    }

    console.log(`${'Drift'.padEnd(20)} ${'Count'.padStart(6)} ${'Correct'.padStart(10)}`);
    console.log('-'.repeat(40));
    console.log(`${'UP bid rising >2¢'.padEnd(20)} ${String(driftUpTotal).padStart(6)} ${pct(driftUpCorrect, driftUpTotal).padStart(10)}`);
    console.log(`${'UP bid falling >2¢'.padEnd(20)} ${String(driftDownTotal).padStart(6)} ${pct(driftDownCorrect, driftDownTotal).padStart(10)}`);
    console.log(`${'Flat (±2¢)'.padEnd(20)} ${String(flatTotal).padStart(6)} ${pct(flatCorrect, flatTotal).padStart(10)}`);
}

// --- Analysis 5: Depth Imbalance ---
// Does the ratio of UP bid depth to DOWN bid depth predict outcomes?
function analyzeDepthImbalance(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('5. DEPTH IMBALANCE: Does bid depth ratio predict outcomes?');
    console.log('='.repeat(60));
    console.log('If more shares on UP bids than DOWN, does UP win more?\n');

    const buckets: Record<string, { total: number; deeperSideWins: number }> = {};

    for (const m of data) {
        const snap = pickAnalysisSnapshot(m);

        if (snap.upBidDepth === 0 && snap.downBidDepth === 0) continue;

        const totalDepth = snap.upBidDepth + snap.downBidDepth;
        const ratio = totalDepth > 0 ? snap.upBidDepth / totalDepth : 0.5;
        const deeperSide = ratio > 0.5 ? 'UP' : 'DOWN';
        const deeperSideWon = m.resolution === deeperSide;

        const imbalance = Math.abs(ratio - 0.5) * 100;
        const key = imbalance < 10 ? 'Balanced (<10%)' :
                    imbalance < 25 ? 'Moderate (10-25%)' :
                    'Strong (25%+)';

        if (!buckets[key]) buckets[key] = { total: 0, deeperSideWins: 0 };
        buckets[key].total++;
        if (deeperSideWon) buckets[key].deeperSideWins++;
    }

    console.log(`${'Imbalance'.padEnd(22)} ${'Count'.padStart(6)} ${'Deeper Side Wins'.padStart(20)}`);
    console.log('-'.repeat(50));

    for (const key of ['Balanced (<10%)', 'Moderate (10-25%)', 'Strong (25%+)']) {
        const b = buckets[key];
        if (!b) continue;
        console.log(`${key.padEnd(22)} ${String(b.total).padStart(6)} ${pct(b.deeperSideWins, b.total).padStart(20)}`);
    }
}

// --- Analysis 6: Favorite Strength ---
// How does the strength of the favorite's bid correlate with win rate?
function analyzeFavoriteStrength(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('6. FAVORITE STRENGTH: Win rate by probability level');
    console.log('='.repeat(60));
    console.log('At what probability levels is selling the underdog profitable?\n');

    const buckets: Record<string, { total: number; favoriteWins: number; avgLoserBid: number }> = {};

    for (const m of data) {
        const snap = pickAnalysisSnapshot(m);

        // Skip true 50/50 ties — no meaningful favorite
        if (snap.upBid === snap.downBid) continue;

        const favorite = snap.upBid > snap.downBid ? 'UP' : 'DOWN';
        const favBid = Math.max(snap.upBid, snap.downBid);
        const loserBid = Math.min(snap.upBid, snap.downBid);
        const favoriteWon = m.resolution === favorite;

        const key = favBid >= 0.90 ? '90-100¢' :
                    favBid >= 0.80 ? '80-90¢' :
                    favBid >= 0.70 ? '70-80¢' :
                    favBid >= 0.60 ? '60-70¢' :
                    '50-60¢';

        if (!buckets[key]) buckets[key] = { total: 0, favoriteWins: 0, avgLoserBid: 0 };
        buckets[key].total++;
        buckets[key].avgLoserBid += loserBid;
        if (favoriteWon) buckets[key].favoriteWins++;
    }

    console.log(`${'Fav Bid'.padEnd(12)} ${'Count'.padStart(6)} ${'Fav Win%'.padStart(10)} ${'Avg Loser'.padStart(12)} ${'EV/trade'.padStart(12)} ${'Note'.padStart(15)}`);
    console.log('-'.repeat(70));

    for (const key of ['50-60¢', '60-70¢', '70-80¢', '80-90¢', '90-100¢']) {
        const b = buckets[key];
        if (!b) continue;
        const winRate = b.favoriteWins / b.total;
        const avgLoser = b.avgLoserBid / b.total;
        // Split straddle EV: pay $1 for both sides, sell loser at loserBid
        // If correct: profit = loserBid (you keep winner worth $1, sold loser for loserBid, paid $1)
        // If wrong: loss = (1 - loserBid) (loser was actually the winner, you sold at loserBid, lost $1 - loserBid)
        // EV = P(correct) * loserBid - P(wrong) * (1 - loserBid)
        const ev = winRate * avgLoser - (1 - winRate) * (1 - avgLoser);
        const evStr = ev >= 0 ? `+${(ev * 100).toFixed(1)}¢` : `${(ev * 100).toFixed(1)}¢`;
        const note = ev > 0 ? 'PROFITABLE' : winRate > 0.5 ? 'edge but -EV' : '';
        console.log(`${key.padEnd(12)} ${String(b.total).padStart(6)} ${pct(b.favoriteWins, b.total).padStart(10)} ${(avgLoser * 100).toFixed(1).padStart(11)}¢ ${evStr.padStart(12)} ${note.padStart(15)}`);
    }
}

// --- Analysis 7: Time-of-snapshot Edge ---
// Do earlier vs later snapshots give better signals?
function analyzeTimingEdge(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('7. TIMING: Does snapshot timing affect prediction accuracy?');
    console.log('='.repeat(60));
    console.log('Is the T-60s signal more reliable than T-120s or T-15s?\n');

    const timingBuckets: Record<string, { total: number; correct: number }> = {};

    for (const m of data) {
        for (const snap of m.snapshots) {
            const favorite = snap.upBid > snap.downBid ? 'UP' : 'DOWN';
            const correct = m.resolution === favorite;

            const key = snap.secondsBeforeEnd >= 180 ? 'T-180s+' :
                        snap.secondsBeforeEnd >= 120 ? 'T-120s' :
                        snap.secondsBeforeEnd >= 60 ? 'T-60s' :
                        snap.secondsBeforeEnd >= 30 ? 'T-30s' :
                        'T-15s';

            if (!timingBuckets[key]) timingBuckets[key] = { total: 0, correct: 0 };
            timingBuckets[key].total++;
            if (correct) timingBuckets[key].correct++;
        }
    }

    console.log(`${'Timing'.padEnd(12)} ${'Count'.padStart(6)} ${'Favorite Wins'.padStart(15)}`);
    console.log('-'.repeat(35));

    for (const key of ['T-180s+', 'T-120s', 'T-60s', 'T-30s', 'T-15s']) {
        const b = timingBuckets[key];
        if (!b) continue;
        console.log(`${key.padEnd(12)} ${String(b.total).padStart(6)} ${pct(b.correct, b.total).padStart(15)}`);
    }
}

// --- Analysis 8: Time of Day ---
// Are certain hours better for predicting outcomes / finding edge?
function analyzeTimeOfDay(data: MarketRecord[]) {
    console.log('\n' + '='.repeat(60));
    console.log('8. TIME OF DAY: Which hours have the best win rate / edge?');
    console.log('='.repeat(60));
    console.log('Grouped by UTC hour. Look for hours with higher favorite win rate.\n');

    const hours: Record<number, { total: number; favoriteWins: number; avgLoserBid: number }> = {};

    for (const m of data) {
        const snap = pickAnalysisSnapshot(m);

        const hour = new Date(m.marketEnd).getUTCHours();
        if (snap.upBid === snap.downBid) continue;

        const favorite = snap.upBid > snap.downBid ? 'UP' : 'DOWN';
        const loserBid = Math.min(snap.upBid, snap.downBid);
        const favoriteWon = m.resolution === favorite;

        if (!hours[hour]) hours[hour] = { total: 0, favoriteWins: 0, avgLoserBid: 0 };
        hours[hour].total++;
        hours[hour].avgLoserBid += loserBid;
        if (favoriteWon) hours[hour].favoriteWins++;
    }

    console.log(`${'Hour (UTC)'.padEnd(12)} ${'Count'.padStart(6)} ${'Fav Win%'.padStart(10)} ${'Avg Loser'.padStart(12)} ${'EV/trade'.padStart(12)}`);
    console.log('-'.repeat(55));

    const sortedHours = Object.keys(hours).map(Number).sort((a, b) => a - b);
    for (const h of sortedHours) {
        const b = hours[h];
        const winRate = b.favoriteWins / b.total;
        const avgLoser = b.avgLoserBid / b.total;
        const ev = winRate * avgLoser - (1 - winRate) * (1 - avgLoser);
        const evStr = ev >= 0 ? `+${(ev * 100).toFixed(1)}¢` : `${(ev * 100).toFixed(1)}¢`;
        const label = `${String(h).padStart(2, '0')}:00`;
        console.log(`${label.padEnd(12)} ${String(b.total).padStart(6)} ${pct(b.favoriteWins, b.total).padStart(10)} ${(avgLoser * 100).toFixed(1).padStart(11)}¢ ${evStr.padStart(12)}`);
    }

    // Also show grouped by session
    console.log('\nBy trading session:');
    const sessions: Record<string, { total: number; favoriteWins: number; avgLoserBid: number }> = {
        'Asia (00-08 UTC)': { total: 0, favoriteWins: 0, avgLoserBid: 0 },
        'Europe (08-16 UTC)': { total: 0, favoriteWins: 0, avgLoserBid: 0 },
        'US (16-24 UTC)': { total: 0, favoriteWins: 0, avgLoserBid: 0 },
    };

    for (const h of sortedHours) {
        const sessionKey = h < 8 ? 'Asia (00-08 UTC)' :
                           h < 16 ? 'Europe (08-16 UTC)' :
                           'US (16-24 UTC)';
        sessions[sessionKey].total += hours[h].total;
        sessions[sessionKey].favoriteWins += hours[h].favoriteWins;
        sessions[sessionKey].avgLoserBid += hours[h].avgLoserBid;
    }

    console.log(`${'Session'.padEnd(22)} ${'Count'.padStart(6)} ${'Fav Win%'.padStart(10)} ${'EV/trade'.padStart(12)}`);
    console.log('-'.repeat(52));
    for (const [name, s] of Object.entries(sessions)) {
        if (s.total === 0) continue;
        const winRate = s.favoriteWins / s.total;
        const avgLoser = s.avgLoserBid / s.total;
        const ev = winRate * avgLoser - (1 - winRate) * (1 - avgLoser);
        const evStr = ev >= 0 ? `+${(ev * 100).toFixed(1)}¢` : `${(ev * 100).toFixed(1)}¢`;
        console.log(`${name.padEnd(22)} ${String(s.total).padStart(6)} ${pct(s.favoriteWins, s.total).padStart(10)} ${evStr.padStart(12)}`);
    }
}

// --- Main ---

function main() {
    const data = loadData();
    console.log(`\nLoaded ${data.length} resolved markets from ${DATA_FILE}`);
    console.log(`UP wins: ${data.filter(d => d.resolution === 'UP').length} | DOWN wins: ${data.filter(d => d.resolution === 'DOWN').length}`);

    if (data.length < 10) {
        console.log('\nNeed at least 10 resolved markets for meaningful analysis.');
        console.log('Run the collector for a few hours first:');
        console.log('  nohup ./node_modules/.bin/tsx src/scripts/pricing-collector.ts --duration 480 >> pricing-collector.out 2>&1 &');
        return;
    }

    analyzeCalibration(data);
    analyzeBidSum(data);
    analyzeSpreadAsymmetry(data);
    analyzeDrift(data);
    analyzeDepthImbalance(data);
    analyzeFavoriteStrength(data);
    analyzeTimingEdge(data);
    analyzeTimeOfDay(data);

    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    console.log('Look for:');
    console.log('  - Calibration: Probability ranges where actual win rate != implied');
    console.log('  - Bid sum gaps: Large gaps that correlate with favorite winning');
    console.log('  - Spread asymmetry: One side having wider spread = signal');
    console.log('  - Depth imbalance: More liquidity on one side = signal');
    console.log('  - Favorite strength: EV positive zones for selling the loser');
    console.log('  - Timing: Which snapshot timing gives the best signal');
    console.log('  - Time of day: Which hours/sessions have the best edge');
}

main();
