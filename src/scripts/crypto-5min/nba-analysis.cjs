const data = JSON.parse(require('fs').readFileSync('nba-live-monitor-results.json', 'utf8'));

for (const game of data) {
    const ticks = game.ticks || [];
    const reprices = game.repricingLags || [];

    console.log('=== ' + game.title + ' ===');
    console.log('  ' + (game.awayTeam || '?') + ' @ ' + (game.homeTeam || '?'));
    console.log('  Ticks: ' + ticks.length + ' | Repricings: ' + reprices.length);

    if (ticks.length === 0) { console.log('  No data\n'); continue; }

    const first = ticks[0];
    const last = ticks[ticks.length - 1];
    console.log('  Start: ' + first.score.awayScore + '-' + first.score.homeScore + ' Q' + first.score.period + ' ' + first.score.clock);
    console.log('  End:   ' + last.score.awayScore + '-' + last.score.homeScore + ' Q' + last.score.period + ' ' + last.score.clock);

    // ML analysis
    const mlBids = ticks.map(t => t.moneyline.bestBid).filter(x => x > 0 && x < 1);
    const mlAsks = ticks.map(t => t.moneyline.bestAsk).filter(x => x > 0 && x < 1);
    const mlSpreads = ticks.map(t => t.moneyline.spread);

    if (mlBids.length > 0) {
        console.log('\n  MONEYLINE:');
        console.log('    Bid range: ' + (Math.min(...mlBids) * 100).toFixed(0) + 'c → ' + (Math.max(...mlBids) * 100).toFixed(0) + 'c (swing: ' + ((Math.max(...mlBids) - Math.min(...mlBids)) * 100).toFixed(0) + 'c)');
        const avgSpr = mlSpreads.reduce((a, b) => a + b, 0) / mlSpreads.length;
        console.log('    Spread: avg ' + (avgSpr * 100).toFixed(1) + 'c | mostly 1c');
    }

    // O/U analysis (filter null ouMain)
    const ouTicks = ticks.filter(t => t.ouMain);
    const ouBids = ouTicks.map(t => t.ouMain.bestBid).filter(x => x > 0);
    const ouAsks = ouTicks.map(t => t.ouMain.bestAsk).filter(x => x < 1);
    const ouSpreads = ouTicks.map(t => t.ouMain.spread);
    const ouMids = ouTicks.map(t => t.ouMain.mid).filter(x => x > 0.02 && x < 0.98);

    if (ouMids.length > 0) {
        console.log('\n  OVER/UNDER:');
        console.log('    Mid range: ' + (Math.min(...ouMids) * 100).toFixed(0) + 'c → ' + (Math.max(...ouMids) * 100).toFixed(0) + 'c (swing: ' + ((Math.max(...ouMids) - Math.min(...ouMids)) * 100).toFixed(0) + 'c)');
        const avgOU = ouSpreads.reduce((a, b) => a + b, 0) / ouSpreads.length;
        const wideOU = ouSpreads.filter(s => s >= 0.03).length;
        console.log('    Spread: avg ' + (avgOU * 100).toFixed(1) + 'c | ≥3c: ' + wideOU + '/' + ouSpreads.length + ' (' + (wideOU / ouSpreads.length * 100).toFixed(0) + '%)');
        const ouDepths = ouTicks.map(t => t.ouMain.bidDepth + t.ouMain.askDepth);
        const avgDepth = ouDepths.reduce((a, b) => a + b, 0) / ouDepths.length;
        console.log('    Avg total depth: $' + (avgDepth / 1000).toFixed(1) + 'K');
    }

    // Spread (point spread) analysis (filter null)
    const sprTicks = ticks.filter(t => t.spreadMain);
    const sprBids = sprTicks.map(t => t.spreadMain.bestBid).filter(x => x > 0);
    const sprSpreads = sprTicks.map(t => t.spreadMain.spread);
    const sprMids = sprTicks.map(t => t.spreadMain.mid).filter(x => x > 0.02 && x < 0.98);

    if (sprMids.length > 0) {
        console.log('\n  POINT SPREAD:');
        console.log('    Mid range: ' + (Math.min(...sprMids) * 100).toFixed(0) + 'c → ' + (Math.max(...sprMids) * 100).toFixed(0) + 'c (swing: ' + ((Math.max(...sprMids) - Math.min(...sprMids)) * 100).toFixed(0) + 'c)');
        const avgSS = sprSpreads.reduce((a, b) => a + b, 0) / sprSpreads.length;
        const wideSS = sprSpreads.filter(s => s >= 0.05).length;
        console.log('    Spread: avg ' + (avgSS * 100).toFixed(1) + 'c | ≥5c: ' + wideSS + '/' + sprSpreads.length + ' (' + (wideSS / sprSpreads.length * 100).toFixed(0) + '%)');
    }

    // Quarter-by-quarter ML and O/U
    const quarters = {};
    for (const t of ticks) {
        const q = t.score.period;
        if (!quarters[q]) quarters[q] = { ticks: 0, mlBids: [], mlSpreads: [], ouMids: [], ouSpreads: [], margins: [] };
        quarters[q].ticks++;
        if (t.moneyline.bestBid > 0 && t.moneyline.bestBid < 1) quarters[q].mlBids.push(t.moneyline.bestBid);
        quarters[q].mlSpreads.push(t.moneyline.spread);
        if (t.ouMain && t.ouMain.mid > 0.02 && t.ouMain.mid < 0.98) quarters[q].ouMids.push(t.ouMain.mid);
        if (t.ouMain) quarters[q].ouSpreads.push(t.ouMain.spread);
        quarters[q].margins.push(Math.abs(t.score.awayScore - t.score.homeScore));
    }

    console.log('\n  PER-QUARTER:');
    console.log('  Q | Ticks | ML Range      | ML Spr | O/U Range      | O/U Spr | Margin');
    console.log('  ' + '-'.repeat(85));
    for (const [q, d] of Object.entries(quarters).sort((a, b) => a[0] - b[0])) {
        const mlRange = d.mlBids.length > 0 ? (Math.min(...d.mlBids) * 100).toFixed(0) + '-' + (Math.max(...d.mlBids) * 100).toFixed(0) + 'c' : 'N/A';
        const mlAvgSpr = d.mlSpreads.length > 0 ? (d.mlSpreads.reduce((a, b) => a + b, 0) / d.mlSpreads.length * 100).toFixed(1) + 'c' : 'N/A';
        const ouRange = d.ouMids.length > 0 ? (Math.min(...d.ouMids) * 100).toFixed(0) + '-' + (Math.max(...d.ouMids) * 100).toFixed(0) + 'c' : 'N/A';
        const ouAvgSpr = d.ouSpreads.length > 0 ? (d.ouSpreads.reduce((a, b) => a + b, 0) / d.ouSpreads.length * 100).toFixed(1) + 'c' : 'N/A';
        const avgMargin = d.margins.length > 0 ? (d.margins.reduce((a, b) => a + b, 0) / d.margins.length).toFixed(1) : 'N/A';

        console.log('  ' + q + ' | ' + String(d.ticks).padStart(5) + ' | ' +
            mlRange.padEnd(13) + ' | ' + mlAvgSpr.padEnd(6) + ' | ' +
            ouRange.padEnd(14) + ' | ' + ouAvgSpr.padEnd(7) + ' | ' + avgMargin + ' pts');
    }

    // Repricing analysis
    if (reprices.length > 0) {
        const lags = reprices.map(r => r.lagMs || r.lag || r.delayMs || 0).filter(x => x > 0);
        if (lags.length > 0) {
            lags.sort((a, b) => a - b);
            const avg = lags.reduce((a, b) => a + b, 0) / lags.length;
            const median = lags[Math.floor(lags.length / 2)];
            const slow = lags.filter(l => l > 10000).length;
            console.log('\n  REPRICING LAG:');
            console.log('    Avg: ' + (avg / 1000).toFixed(1) + 's | Median: ' + (median / 1000).toFixed(1) + 's | >10s: ' + slow + '/' + lags.length);
        }
    }

    // Score change impact on ML
    const scoreChanges = ticks.filter(t => t.scoreChanged);
    if (scoreChanges.length > 0) {
        console.log('\n  SCORE CHANGES: ' + scoreChanges.length + ' detected');
        // Look at ML bid before/after score changes
        let bigMoves = 0;
        for (let i = 1; i < ticks.length; i++) {
            if (ticks[i].scoreChanged) {
                const before = ticks[i - 1].moneyline.bestBid;
                const after = ticks[i].moneyline.bestBid;
                const move = Math.abs(after - before) * 100;
                if (move >= 2) bigMoves++;
            }
        }
        console.log('    ML moves ≥2c on score change: ' + bigMoves + '/' + scoreChanges.length);
    }

    console.log('\n' + '='.repeat(60) + '\n');
}

// Summary insight
console.log('=== MM OPPORTUNITY ASSESSMENT ===\n');
for (const game of data) {
    const ticks = game.ticks || [];
    const mlSpreads = ticks.filter(t => t.moneyline).map(t => t.moneyline.spread);
    const ouSpreads2 = ticks.filter(t => t.ouMain).map(t => t.ouMain.spread);

    const mlTight = mlSpreads.filter(s => s <= 0.01).length / mlSpreads.length * 100;
    const ouWide = ouSpreads2.filter(s => s >= 0.05).length / (ouSpreads2.length || 1) * 100;

    console.log(game.title + ':');
    console.log('  ML spread ≤1c: ' + mlTight.toFixed(0) + '% of time — NO MM opportunity (too tight)');
    console.log('  O/U spread ≥5c: ' + ouWide.toFixed(0) + '% of time — ' + (ouWide > 30 ? 'POTENTIAL MM opportunity' : 'Limited MM opportunity'));
    console.log();
}
