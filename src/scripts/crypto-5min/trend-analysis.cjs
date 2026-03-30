const data = JSON.parse(require('fs').readFileSync('split-straddle-results.json', 'utf8'));
const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

console.log('=== SPLIT STUDY: 100 CANDLES ===\n');

// 1. Accuracy at each checkpoint (all data)
console.log('--- Accuracy by Checkpoint (all candles) ---');
console.log('Time  | Correct | Total | Accuracy | Avg Loser Bid | ≤30c Acc  | ≤30c n');
console.log('-'.repeat(75));

for (const cp of [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10]) {
    const trades = data.flatMap(r => (r.stratB_checkpoints || []).filter(c => c.secondsBefore === cp));
    if (trades.length === 0) continue;

    const correct = trades.filter(t => t.wasCorrect).length;
    const avgBid = avg(trades.filter(t => t.wasCorrect).map(t => t.loserBid));

    const filtered = trades.filter(t => t.loserBid <= 0.30);
    const filtCorrect = filtered.filter(t => t.wasCorrect).length;

    console.log(
        String(cp).padStart(4) + 's | ' +
        String(correct).padStart(7) + ' | ' +
        String(trades.length).padStart(5) + ' | ' +
        (correct / trades.length * 100).toFixed(1).padStart(7) + '% | ' +
        ((avgBid * 100).toFixed(1) + 'c').padStart(13) + ' | ' +
        (filtered.length > 0 ? (filtCorrect / filtered.length * 100).toFixed(1) + '%' : 'N/A').padStart(8) + ' | ' +
        String(filtered.length).padStart(5)
    );
}

// 2. The 9 candles with full T-180→T-10 data: consistency analysis
console.log('\n--- Early Checkpoint Data (9 candles with T-180s) ---');
const fullCandles = data.filter(c => (c.stratB_checkpoints || []).some(x => x.secondsBefore === 180));
console.log('Candles with full range:', fullCandles.length);

for (const c of fullCandles) {
    const cps = c.stratB_checkpoints || [];
    const cp180 = cps.find(x => x.secondsBefore === 180);
    const cp120 = cps.find(x => x.secondsBefore === 120);
    const cp60 = cps.find(x => x.secondsBefore === 60);
    const cp30 = cps.find(x => x.secondsBefore === 30);
    const cp20 = cps.find(x => x.secondsBefore === 20);

    if (!cp180 || !cp120 || !cp60 || !cp20) continue;

    const dirs = cps.map(x => x.predictedLoser);
    const flips = dirs.filter((d, i) => i > 0 && d !== dirs[i - 1]).length;
    const consistent = flips === 0;

    console.log(
        '  #' + c.index + ' ' + c.actualOutcome + ' | ' +
        'T-180: ' + cp180.predictedLoser + ' ' + (cp180.loserBid * 100).toFixed(0) + 'c | ' +
        'T-120: ' + cp120.predictedLoser + ' ' + (cp120.loserBid * 100).toFixed(0) + 'c | ' +
        'T-60: ' + cp60.predictedLoser + ' ' + (cp60.loserBid * 100).toFixed(0) + 'c | ' +
        'T-20: ' + cp20.predictedLoser + ' ' + (cp20.loserBid * 100).toFixed(0) + 'c | ' +
        'Flips: ' + flips + ' | ' +
        (cp20.wasCorrect ? 'CORRECT' : 'WRONG')
    );
}

// 3. Updated consistency analysis with all 100 candles (T-60 through T-20)
console.log('\n--- Updated Consistency Analysis (100 candles) ---');

let cons60 = 0, cons60_correct = 0, flip60 = 0, flip60_correct = 0;
let cons60_filt = 0, cons60_filt_correct = 0, flip60_filt = 0, flip60_filt_correct = 0;

for (const c of data) {
    const cps = c.stratB_checkpoints || [];
    const cp60 = cps.find(x => x.secondsBefore === 60);
    const cp45 = cps.find(x => x.secondsBefore === 45);
    const cp30 = cps.find(x => x.secondsBefore === 30);
    const cp20 = cps.find(x => x.secondsBefore === 20);
    if (!cp60 || !cp30 || !cp20) continue;

    const consistent = cp60.predictedLoser === cp30.predictedLoser && cp30.predictedLoser === cp20.predictedLoser;

    if (consistent) {
        cons60++;
        if (cp20.wasCorrect) cons60_correct++;
        if (cp20.loserBid <= 0.30) {
            cons60_filt++;
            if (cp20.wasCorrect) cons60_filt_correct++;
        }
    } else {
        flip60++;
        if (cp20.wasCorrect) flip60_correct++;
        if (cp20.loserBid <= 0.30) {
            flip60_filt++;
            if (cp20.wasCorrect) flip60_filt_correct++;
        }
    }
}

console.log('T-60→T-20 consistent: ' + cons60_correct + '/' + cons60 + ' (' + (cons60_correct/cons60*100).toFixed(1) + '%)');
console.log('T-60→T-20 flipped:    ' + flip60_correct + '/' + flip60 + ' (' + (flip60 > 0 ? (flip60_correct/flip60*100).toFixed(1) : 'N/A') + '%)');
console.log('With ≤30c filter:');
console.log('  Consistent: ' + cons60_filt_correct + '/' + cons60_filt + ' (' + (cons60_filt > 0 ? (cons60_filt_correct/cons60_filt*100).toFixed(1) : 'N/A') + '%)');
console.log('  Flipped:    ' + flip60_filt_correct + '/' + flip60_filt + ' (' + (flip60_filt > 0 ? (flip60_filt_correct/flip60_filt*100).toFixed(1) : 'N/A') + '%)');

// 4. EV at each sell time with ≤30c filter (updated)
console.log('\n--- EV Comparison (≤30c filter, per $100 split) ---');
for (const cp of [180, 150, 120, 90, 60, 50, 40, 30, 20, 15, 10]) {
    const trades = data.flatMap(r => (r.stratB_checkpoints || []).filter(c => c.secondsBefore === cp && c.loserBid <= 0.30));
    if (trades.length < 3) continue;

    const correct = trades.filter(t => t.wasCorrect).length;
    const accuracy = correct / trades.length;
    const avgWinBid = avg(trades.filter(t => t.wasCorrect).map(t => t.loserBid));
    const wrongTrades = trades.filter(t => !t.wasCorrect);
    const avgLossBid = wrongTrades.length > 0 ? avg(wrongTrades.map(t => t.loserBid)) : 0;
    const winRev = avgWinBid * 100;
    const lossAmt = wrongTrades.length > 0 ? (1 - avgLossBid) * 100 : 95;
    const ev = accuracy * winRev - (1 - accuracy) * lossAmt;

    console.log(
        '  T-' + String(cp).padStart(3) + 's: ' +
        'Acc ' + (accuracy * 100).toFixed(0) + '% (' + correct + '/' + trades.length + ') | ' +
        'Win: +$' + winRev.toFixed(2) + ' | Loss: -$' + lossAmt.toFixed(2) + ' | ' +
        'EV: $' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '/trade'
    );
}

// 5. Check the last 20 candles specifically (recent performance)
console.log('\n--- Last 20 Candles Performance ---');
const last20 = data.slice(-20);
for (const cp of [60, 30, 20]) {
    const trades = last20.flatMap(r => (r.stratB_checkpoints || []).filter(c => c.secondsBefore === cp));
    if (trades.length === 0) continue;
    const correct = trades.filter(t => t.wasCorrect).length;
    const filtered = trades.filter(t => t.loserBid <= 0.30);
    const filtCorrect = filtered.filter(t => t.wasCorrect).length;
    console.log(
        '  T-' + cp + 's: ' + correct + '/' + trades.length + ' (' + (correct/trades.length*100).toFixed(0) + '%) all | ' +
        filtCorrect + '/' + filtered.length + ' (' + (filtered.length > 0 ? (filtCorrect/filtered.length*100).toFixed(0) : 'N/A') + '%) ≤30c'
    );
}
