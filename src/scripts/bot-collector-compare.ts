/**
 * Bot vs Collector Real-Time Comparison
 *
 * Compares the bot's trade ledger against the collector's data to catch gaps
 * in real-time. Run periodically (or after each session) to verify alignment.
 *
 * Usage:
 *   npx tsx src/scripts/bot-collector-compare.ts                   # last hour
 *   npx tsx src/scripts/bot-collector-compare.ts --hours 4         # last 4 hours
 *   npx tsx src/scripts/bot-collector-compare.ts --since 2026-03-28T20:00
 */

import { readFileSync } from 'node:fs';

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const hours = parseFloat(getArg('--hours', '1'));
const sinceArg = getArg('--since', '');
const since = sinceArg || new Date(Date.now() - hours * 3600 * 1000).toISOString();

console.log(`\n${'='.repeat(80)}`);
console.log(`  BOT vs COLLECTOR COMPARISON`);
console.log(`  Window: since ${since.slice(0, 19)}`);
console.log(`${'='.repeat(80)}\n`);

// Load bot trades
interface BotTrade {
    timestamp: string;
    slug: string;
    crypto: string;
    underdogSide: string;
    underdogAsk: number;
    resolution: string;
    won: boolean;
    expectedPnl: number;
}

const botTrades: BotTrade[] = [];
try {
    const lines = readFileSync('underdog-snipe-trades.jsonl', 'utf-8').trim().split('\n');
    for (const line of lines) {
        const t = JSON.parse(line);
        if (t.timestamp >= since) {
            botTrades.push(t);
        }
    }
} catch {
    console.log('  No bot trade ledger found (underdog-snipe-trades.jsonl)');
}

// Load collector data
interface CollectorTrade {
    slug: string;
    crypto: string;
    underdog: string;
    ask: number;
    won: boolean;
    resolution: string;
    collected: string;
    pnl: number;
}

const collectorTrades: CollectorTrade[] = [];
try {
    const { createReadStream } = await import('node:fs');
    const { createInterface } = await import('node:readline');
    const rl = createInterface({ input: createReadStream('pricing-data.jsonl') });
    const seenCollectorSlugs = new Set<string>();
    for await (const line of rl) {
        const r = JSON.parse(line);
        if (r.collectedAt < since) continue;
        if (seenCollectorSlugs.has(r.slug)) continue; // dedup
        seenCollectorSlugs.add(r.slug);
        if (r.regimeLabels?.t60State !== 'two-sided') continue;

        const snapshots = r.snapshots || [];
        for (const s of snapshots) {
            if (s.secondsBeforeEnd !== 30) continue;

            const upAsk = s.upAsk ?? 1;
            const downAsk = s.downAsk ?? 1;
            const upMid = ((s.upBid ?? 0) + upAsk) / 2;
            const downMid = ((s.downBid ?? 0) + downAsk) / 2;
            const underdog = upMid < downMid ? 'UP' : 'DOWN';
            const underdogAsk = underdog === 'UP' ? upAsk : downAsk;
            const favBid = underdog === 'UP' ? (s.downBid ?? 0) : (s.upBid ?? 0);

            if (!(underdogAsk > 0.02 && underdogAsk <= 0.50 && favBid < 0.97)) break;

            const prev = r.prevResolution ?? '?';
            if (prev !== underdog) break;

            // Chainlink resolution
            const clMove = r.chainlinkMoveDollars;
            const resolution = clMove != null ? (clMove >= 0 ? 'UP' : 'DOWN') : (r.resolution ?? '?');
            const won = underdog === resolution;

            const shares = Math.floor(10 / underdogAsk);
            const pnl = won ? shares * 1.0 - shares * underdogAsk : -(shares * underdogAsk);

            collectorTrades.push({
                slug: r.slug,
                crypto: r.slug.split('-')[0].toUpperCase(),
                underdog,
                ask: underdogAsk,
                won,
                resolution,
                collected: r.collectedAt?.slice(0, 19) ?? '',
                pnl,
            });
            break;
        }
    }
} catch (err) {
    console.log(`  Error reading collector data: ${err}`);
}

// Compare
const botResolved = botTrades.filter(t => t.resolution !== 'UNKNOWN' && t.resolution != null);
const botWins = botResolved.filter(t => t.won).length;
const botPnl = botResolved.reduce((s, t) => s + t.expectedPnl, 0);

const collWins = collectorTrades.filter(t => t.won).length;
const collPnl = collectorTrades.reduce((s, t) => s + t.pnl, 0);

console.log(`  Bot:       ${botResolved.length} trades, ${botWins}W/${botResolved.length - botWins}L = ${botResolved.length ? (botWins / botResolved.length * 100).toFixed(1) : 0}%, PnL $${botPnl.toFixed(2)}`);
console.log(`  Collector: ${collectorTrades.length} trades, ${collWins}W/${collectorTrades.length - collWins}L = ${collectorTrades.length ? (collWins / collectorTrades.length * 100).toFixed(1) : 0}%, PnL $${collPnl.toFixed(2)}`);

// Slug matching
const botSlugs = new Set(botTrades.map(t => `${t.slug}|${t.crypto}`));
const collSlugs = new Set(collectorTrades.map(t => `${t.slug}|${t.crypto}`));

const both = [...botSlugs].filter(s => collSlugs.has(s));
const botOnly = [...botSlugs].filter(s => !collSlugs.has(s));
const collOnly = [...collSlugs].filter(s => !botSlugs.has(s));

console.log(`\n  Shared slugs: ${both.length}`);
console.log(`  Bot only (collector didn't qualify): ${botOnly.length}`);
console.log(`  Collector only (bot missed): ${collOnly.length}`);

// Resolution mismatches on shared trades
const botBySlug = new Map(botTrades.map(t => [`${t.slug}|${t.crypto}`, t]));
const collBySlug = new Map(collectorTrades.map(t => [`${t.slug}|${t.crypto}`, t]));

let resMismatches = 0;
for (const key of both) {
    const bt = botBySlug.get(key)!;
    const ct = collBySlug.get(key)!;
    if (bt.resolution && ct.resolution && bt.resolution !== 'UNKNOWN' && bt.resolution !== ct.resolution) {
        resMismatches++;
        console.log(`  RESOLUTION MISMATCH: ${key} — bot=${bt.resolution} collector=${ct.resolution}`);
    }
}

// Missed trades detail
if (collOnly.length > 0) {
    const missedWins = collOnly.filter(key => collBySlug.get(key)?.won).length;
    const missedLosses = collOnly.length - missedWins;
    console.log(`\n  Missed trades: ${missedWins}W/${missedLosses}L (${collOnly.length > 0 ? (missedWins / collOnly.length * 100).toFixed(0) : 0}% win)`);

    if (collOnly.length <= 20) {
        console.log(`  Detail:`);
        for (const key of collOnly) {
            const ct = collBySlug.get(key)!;
            const icon = ct.won ? 'WIN' : 'LOSS';
            console.log(`    ${ct.collected} ${ct.crypto} ${ct.underdog} @${(ct.ask * 100).toFixed(0)}¢ → ${ct.resolution} ${icon}`);
        }
    }
}

// Summary
console.log(`\n${'─'.repeat(80)}`);
const winGap = botResolved.length && collectorTrades.length
    ? Math.abs(botWins / botResolved.length * 100 - collWins / collectorTrades.length * 100)
    : 0;
const tradeGap = Math.abs(botResolved.length - collectorTrades.length);

if (resMismatches > 0) {
    console.log(`  ⚠️  RESOLUTION MISMATCHES: ${resMismatches} — bot and collector disagree on outcomes`);
}
if (winGap > 15) {
    console.log(`  ⚠️  WIN RATE GAP: ${winGap.toFixed(1)}pp — significant divergence`);
} else if (winGap > 5) {
    console.log(`  ℹ️  Win rate gap: ${winGap.toFixed(1)}pp — minor, could be variance on small sample`);
} else {
    console.log(`  ✓  Win rates aligned (gap: ${winGap.toFixed(1)}pp)`);
}
if (tradeGap > collectorTrades.length * 0.3) {
    console.log(`  ⚠️  TRADE COUNT GAP: bot ${botResolved.length} vs collector ${collectorTrades.length} — bot missing ${((1 - botResolved.length / collectorTrades.length) * 100).toFixed(0)}% of trades`);
} else {
    console.log(`  ✓  Trade counts close (bot ${botResolved.length}, collector ${collectorTrades.length})`);
}
if (resMismatches === 0 && winGap <= 15 && tradeGap <= collectorTrades.length * 0.3) {
    console.log(`  ✓  Bot and collector are aligned`);
}
console.log(`${'─'.repeat(80)}\n`);
