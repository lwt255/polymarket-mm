/**
 * Analyze: Does CL direction consistency across checkpoints predict accuracy?
 * If CL points the same way from T-60 through T-20, is accuracy higher?
 * And what's the loser bid difference (revenue potential)?
 */
const data = JSON.parse(require('fs').readFileSync('split-straddle-results.json', 'utf8'));

let consistent60to20 = 0, consistent60to20_correct = 0;
let consistent45to20 = 0, consistent45to20_correct = 0;
let consistent30to20 = 0, consistent30to20_correct = 0;
let only20 = 0, only20_correct = 0;
let flipped = 0, flipped_correct = 0;

// Also track with <=30c filter
let filt_consistent60 = 0, filt_consistent60_correct = 0;
let filt_consistent45 = 0, filt_consistent45_correct = 0;
let filt_only20 = 0, filt_only20_correct = 0;
let filt_flipped = 0, filt_flipped_correct = 0;

for (const c of data) {
    const cps = c.stratB_checkpoints;
    if (!cps || cps.length === 0) continue;

    const cp60 = cps.find(x => x.secondsBefore === 60);
    const cp45 = cps.find(x => x.secondsBefore === 45);
    const cp30 = cps.find(x => x.secondsBefore === 30);
    const cp20 = cps.find(x => x.secondsBefore === 20);

    if (!cp20) continue;

    only20++;
    if (cp20.wasCorrect) only20_correct++;
    if (cp20.loserBid <= 0.30) {
        filt_only20++;
        if (cp20.wasCorrect) filt_only20_correct++;
    }

    if (cp60 && cp45 && cp30 && cp20) {
        const allSame = cp60.predictedLoser === cp45.predictedLoser &&
                        cp45.predictedLoser === cp30.predictedLoser &&
                        cp30.predictedLoser === cp20.predictedLoser;
        if (allSame) {
            consistent60to20++;
            if (cp20.wasCorrect) consistent60to20_correct++;
            if (cp20.loserBid <= 0.30) {
                filt_consistent60++;
                if (cp20.wasCorrect) filt_consistent60_correct++;
            }
        } else {
            flipped++;
            if (cp20.wasCorrect) flipped_correct++;
            if (cp20.loserBid <= 0.30) {
                filt_flipped++;
                if (cp20.wasCorrect) filt_flipped_correct++;
            }
        }
    }

    if (cp45 && cp30 && cp20) {
        const same = cp45.predictedLoser === cp30.predictedLoser &&
                     cp30.predictedLoser === cp20.predictedLoser;
        if (same) {
            consistent45to20++;
            if (cp20.wasCorrect) consistent45to20_correct++;
            if (cp20.loserBid <= 0.30) {
                filt_consistent45++;
                if (cp20.wasCorrect) filt_consistent45_correct++;
            }
        }
    }

    if (cp30 && cp20) {
        const same = cp30.predictedLoser === cp20.predictedLoser;
        if (same) {
            consistent30to20++;
            if (cp20.wasCorrect) consistent30to20_correct++;
        }
    }
}

console.log('=== DIRECTION CONSISTENCY ANALYSIS (' + data.length + ' candles) ===\n');
console.log('Signal                     | Correct | Total | Accuracy');
console.log('-'.repeat(60));
console.log('T-20s alone                |  ' + only20_correct + '     |  ' + only20 + '  | ' + (only20_correct / only20 * 100).toFixed(1) + '%');
if (consistent30to20 > 0)
    console.log('T-30→T-20 consistent       |  ' + consistent30to20_correct + '     |  ' + consistent30to20 + '  | ' + (consistent30to20_correct / consistent30to20 * 100).toFixed(1) + '%');
if (consistent45to20 > 0)
    console.log('T-45→T-20 consistent       |  ' + consistent45to20_correct + '     |  ' + consistent45to20 + '  | ' + (consistent45to20_correct / consistent45to20 * 100).toFixed(1) + '%');
if (consistent60to20 > 0)
    console.log('T-60→T-20 consistent       |  ' + consistent60to20_correct + '     |  ' + consistent60to20 + '  | ' + (consistent60to20_correct / consistent60to20 * 100).toFixed(1) + '%');
if (flipped > 0)
    console.log('Direction FLIPPED (60→20)   |  ' + flipped_correct + '      |  ' + flipped + '  | ' + (flipped_correct / flipped * 100).toFixed(1) + '%');

console.log('\n=== WITH ≤30c LOSER BID FILTER ===\n');
console.log('Signal                     | Correct | Total | Accuracy');
console.log('-'.repeat(60));
if (filt_only20 > 0)
    console.log('T-20s alone (≤30c)         |  ' + filt_only20_correct + '     |  ' + filt_only20 + '  | ' + (filt_only20_correct / filt_only20 * 100).toFixed(1) + '%');
if (filt_consistent60 > 0)
    console.log('T-60→T-20 consistent (≤30c)|  ' + filt_consistent60_correct + '     |  ' + filt_consistent60 + '  | ' + (filt_consistent60_correct / filt_consistent60 * 100).toFixed(1) + '%');
if (filt_flipped > 0)
    console.log('Flipped (≤30c)             |  ' + filt_flipped_correct + '      |  ' + filt_flipped + '  | ' + (filt_flipped_correct / filt_flipped * 100).toFixed(1) + '%');

// Revenue analysis: what's the loser bid at different times for consistent candles?
console.log('\n=== REVENUE POTENTIAL: SELL EARLIER vs LATER ===\n');
console.log('For candles where direction was consistent (T-60 through T-20):');

let earlyBids60 = [], earlyBids45 = [], earlyBids30 = [], lateBids20 = [];
let earlyBids60_wrong = [], lateBids20_wrong = [];

for (const c of data) {
    const cps = c.stratB_checkpoints;
    if (!cps) continue;
    const cp60 = cps.find(x => x.secondsBefore === 60);
    const cp45 = cps.find(x => x.secondsBefore === 45);
    const cp30 = cps.find(x => x.secondsBefore === 30);
    const cp20 = cps.find(x => x.secondsBefore === 20);
    if (!cp60 || !cp45 || !cp30 || !cp20) continue;

    const consistent = cp60.predictedLoser === cp45.predictedLoser &&
                       cp45.predictedLoser === cp30.predictedLoser &&
                       cp30.predictedLoser === cp20.predictedLoser;
    if (!consistent) continue;

    if (cp20.wasCorrect) {
        earlyBids60.push(cp60.loserBid);
        earlyBids45.push(cp45.loserBid);
        earlyBids30.push(cp30.loserBid);
        lateBids20.push(cp20.loserBid);
    } else {
        earlyBids60_wrong.push(cp60.loserBid);
        lateBids20_wrong.push(cp20.loserBid);
    }
}

const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;

if (earlyBids60.length > 0) {
    console.log('  CORRECT predictions (n=' + earlyBids60.length + '):');
    console.log('    Sell at T-60s: avg loser bid = ' + (avg(earlyBids60) * 100).toFixed(1) + 'c → $' + (avg(earlyBids60) * 100).toFixed(2) + ' revenue per $100');
    console.log('    Sell at T-45s: avg loser bid = ' + (avg(earlyBids45) * 100).toFixed(1) + 'c → $' + (avg(earlyBids45) * 100).toFixed(2) + ' revenue per $100');
    console.log('    Sell at T-30s: avg loser bid = ' + (avg(earlyBids30) * 100).toFixed(1) + 'c → $' + (avg(earlyBids30) * 100).toFixed(2) + ' revenue per $100');
    console.log('    Sell at T-20s: avg loser bid = ' + (avg(lateBids20) * 100).toFixed(1) + 'c → $' + (avg(lateBids20) * 100).toFixed(2) + ' revenue per $100');
    console.log('    Extra revenue selling at T-60 vs T-20: $' + ((avg(earlyBids60) - avg(lateBids20)) * 100).toFixed(2) + ' per $100 split');
}

if (earlyBids60_wrong.length > 0) {
    console.log('\n  WRONG predictions (n=' + earlyBids60_wrong.length + '):');
    console.log('    Sell at T-60s: avg loser bid = ' + (avg(earlyBids60_wrong) * 100).toFixed(1) + 'c → loss = $' + ((1 - avg(earlyBids60_wrong)) * 100).toFixed(2));
    console.log('    Sell at T-20s: avg loser bid = ' + (avg(lateBids20_wrong) * 100).toFixed(1) + 'c → loss = $' + ((1 - avg(lateBids20_wrong)) * 100).toFixed(2));
}

// EV comparison
console.log('\n=== EXPECTED VALUE COMPARISON (per $100 split) ===\n');

for (const sellTime of [60, 45, 30, 20]) {
    const trades = [];
    for (const c of data) {
        const cps = c.stratB_checkpoints;
        if (!cps) continue;
        const cp = cps.find(x => x.secondsBefore === sellTime);
        if (!cp || cp.loserBid > 0.30) continue;
        trades.push(cp);
    }
    if (trades.length < 3) continue;

    const correct = trades.filter(t => t.wasCorrect).length;
    const accuracy = correct / trades.length;
    const avgWinBid = avg(trades.filter(t => t.wasCorrect).map(t => t.loserBid));
    const avgLossBid = avg(trades.filter(t => !t.wasCorrect).map(t => t.loserBid));
    const winRev = avgWinBid * 100;
    const lossAmt = trades.filter(t => !t.wasCorrect).length > 0 ? (1 - avgLossBid) * 100 : 95;
    const ev = accuracy * winRev - (1 - accuracy) * lossAmt;

    console.log('  Sell at T-' + String(sellTime).padStart(2) + 's (≤30c filter): ' +
        'Acc ' + (accuracy * 100).toFixed(0) + '% | ' +
        'Win: +$' + winRev.toFixed(2) + ' | Loss: -$' + lossAmt.toFixed(2) + ' | ' +
        'EV: $' + (ev >= 0 ? '+' : '') + ev.toFixed(2) + '/trade | ' +
        'n=' + trades.length);
}

// Adaptive strategy: sell at T-60 if consistent from T-60→T-45→T-30, otherwise wait to T-20
console.log('\n=== ADAPTIVE STRATEGY (your idea) ===\n');
console.log('Rule: If CL direction consistent T-60→T-30, sell at T-30 (higher bid).');
console.log('      If direction flipped, wait to T-20 (more certainty, lower bid).\n');

let adaptiveTrades = 0, adaptiveCorrect = 0, adaptivePnl = 0;
for (const c of data) {
    const cps = c.stratB_checkpoints;
    if (!cps) continue;
    const cp60 = cps.find(x => x.secondsBefore === 60);
    const cp45 = cps.find(x => x.secondsBefore === 45);
    const cp30 = cps.find(x => x.secondsBefore === 30);
    const cp20 = cps.find(x => x.secondsBefore === 20);
    if (!cp30 || !cp20) continue;

    let sellCp;
    if (cp60 && cp45 && cp30 &&
        cp60.predictedLoser === cp45.predictedLoser &&
        cp45.predictedLoser === cp30.predictedLoser &&
        cp30.loserBid <= 0.30) {
        sellCp = cp30; // consistent → sell early at T-30
    } else if (cp20.loserBid <= 0.30) {
        sellCp = cp20; // not consistent → wait for T-20
    } else {
        continue; // skip (bid too high)
    }

    adaptiveTrades++;
    if (sellCp.wasCorrect) {
        adaptiveCorrect++;
        adaptivePnl += sellCp.loserBid * 100;
    } else {
        adaptivePnl -= (1 - sellCp.loserBid) * 100;
    }
}

if (adaptiveTrades > 0) {
    console.log('Trades: ' + adaptiveTrades + ' | Correct: ' + adaptiveCorrect + ' (' + (adaptiveCorrect/adaptiveTrades*100).toFixed(1) + '%)');
    console.log('Total P&L on $100 splits: $' + (adaptivePnl >= 0 ? '+' : '') + adaptivePnl.toFixed(2));
    console.log('Per trade: $' + (adaptivePnl/adaptiveTrades >= 0 ? '+' : '') + (adaptivePnl/adaptiveTrades).toFixed(2));
    console.log('Daily est (288 candles, ~' + Math.round(adaptiveTrades/data.length * 288) + ' trades): $' + (adaptivePnl/adaptiveTrades * Math.round(adaptiveTrades/data.length * 288)).toFixed(2));
}
