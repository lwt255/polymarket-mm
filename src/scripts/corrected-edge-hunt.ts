/**
 * corrected-edge-hunt.ts
 *
 * Deep analysis on on-chain-corrected pricing data.
 * Looks for real edges by slicing across every dimension:
 *   - Price buckets (fine-grained)
 *   - Crypto (BTC, ETH, SOL, XRP)
 *   - Interval (5m vs 15m)
 *   - Entry timing (T-30, T-60, T-120)
 *   - Microstructure: spread, depth imbalance, momentum, book pressure
 *   - Favorite side (buy favorite vs buy underdog)
 *   - Time of day
 */
import * as fs from 'fs';
import * as readline from 'readline';

const DATA_FILE = 'pricing-data.jsonl';

interface Trade {
    slug: string;
    crypto: string;
    interval: number;
    resolution: string;
    secondsBeforeEnd: number;
    side: string;          // which side we'd buy
    entryAsk: number;
    entryBid: number;
    won: boolean;
    pnlCents: number;
    // Microstructure
    spread: number;
    favBid: number;
    underdogAsk: number;
    upBidDepth: number;
    downBidDepth: number;
    upAskDepth: number;
    downAskDepth: number;
    depthImbalance: number; // >1 means more depth on underdog side
    hourUTC: number;
    // Momentum
    impliedUpProb: number;
    chainlinkMoveDollars: number;
}

async function loadTrades(): Promise<Trade[]> {
    const trades: Trade[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE) });

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (r.resolution === 'UNKNOWN' || !r.snapshots?.length) continue;

            const crypto = r.slug.split('-')[0];
            const interval = r.slug.includes('-15m-') ? 15 : 5;
            const hour = r.hourUTC ?? new Date(r.collectedAt).getUTCHours();

            for (const snap of r.snapshots) {
                if (!snap.upAsk || !snap.downAsk || snap.upAsk <= 0 || snap.downAsk <= 0) continue;
                if (snap.upAsk >= 1 || snap.downAsk >= 1) continue;

                // Underdog = cheaper side
                const upIsUnderdog = snap.upMid < snap.downMid;
                const underdogSide = upIsUnderdog ? 'UP' : 'DOWN';
                const favoriteSide = upIsUnderdog ? 'DOWN' : 'UP';
                const underdogAsk = upIsUnderdog ? snap.upAsk : snap.downAsk;
                const underdogBid = upIsUnderdog ? snap.upBid : snap.downBid;
                const favBid = upIsUnderdog ? snap.downBid : snap.upBid;

                if (underdogAsk < 0.02 || underdogAsk > 0.98) continue;

                const spread = underdogAsk - underdogBid;

                // Depth imbalance: ratio of underdog depth to favorite depth
                const underdogBidDepth = upIsUnderdog ? snap.upBidDepth : snap.downBidDepth;
                const favBidDepth = upIsUnderdog ? snap.downBidDepth : snap.upBidDepth;
                const depthImbalance = favBidDepth > 0 ? underdogBidDepth / favBidDepth : 1;

                // Both sides: underdog and favorite
                for (const buySide of ['UNDERDOG', 'FAVORITE'] as const) {
                    const side = buySide === 'UNDERDOG' ? underdogSide : favoriteSide;
                    const ask = buySide === 'UNDERDOG' ? underdogAsk : (upIsUnderdog ? snap.downAsk : snap.upAsk);
                    const bid = buySide === 'UNDERDOG' ? underdogBid : favBid;

                    if (ask <= 0 || ask >= 1) continue;

                    const won = side === r.resolution;
                    const costCents = ask * 100;
                    const pnlCents = won ? (100 - costCents) : -costCents;

                    trades.push({
                        slug: r.slug,
                        crypto,
                        interval,
                        resolution: r.resolution,
                        secondsBeforeEnd: snap.secondsBeforeEnd,
                        side: buySide,
                        entryAsk: ask,
                        entryBid: bid,
                        won,
                        pnlCents,
                        spread,
                        favBid,
                        underdogAsk,
                        upBidDepth: snap.upBidDepth || 0,
                        downBidDepth: snap.downBidDepth || 0,
                        upAskDepth: snap.upAskDepth || 0,
                        downAskDepth: snap.downAskDepth || 0,
                        depthImbalance,
                        hourUTC: hour,
                        impliedUpProb: snap.impliedUpProb || 0.5,
                        chainlinkMoveDollars: r.chainlinkMoveDollars || 0,
                    });
                }
            }
        } catch { /* skip */ }
    }
    return trades;
}

function analyze(trades: Trade[], label: string, minN = 30) {
    if (trades.length < minN) return null;
    const wins = trades.filter(t => t.won).length;
    const wr = wins / trades.length;
    const totalPnl = trades.reduce((s, t) => s + t.pnlCents, 0);
    const avgPnl = totalPnl / trades.length;
    const avgAsk = trades.reduce((s, t) => s + t.entryAsk, 0) / trades.length;
    const breakeven = avgAsk; // need WR > ask to profit
    return { label, n: trades.length, wins, wr, avgPnl, totalPnl, avgAsk, breakeven, edge: wr - avgAsk };
}

function printTable(rows: ReturnType<typeof analyze>[], title: string) {
    const valid = rows.filter(r => r !== null) as NonNullable<ReturnType<typeof analyze>>[];
    if (valid.length === 0) return;

    console.log(`\n=== ${title} ===`);
    console.log(`${'Label'.padEnd(30)} ${'N'.padStart(6)} ${'Wins'.padStart(6)} ${'WR%'.padStart(7)} ${'AvgAsk'.padStart(7)} ${'BE%'.padStart(7)} ${'Edge'.padStart(7)} ${'PnL/tr'.padStart(8)} ${'TotalPnL'.padStart(10)}`);
    console.log('-'.repeat(100));

    // Sort by edge descending
    valid.sort((a, b) => b.edge - a.edge);

    for (const r of valid) {
        const edgeStr = r.edge > 0 ? `+${(r.edge * 100).toFixed(1)}` : `${(r.edge * 100).toFixed(1)}`;
        const pnlStr = r.avgPnl >= 0 ? `+${r.avgPnl.toFixed(1)}¢` : `${r.avgPnl.toFixed(1)}¢`;
        const totalStr = r.totalPnl >= 0 ? `+$${(r.totalPnl / 100).toFixed(0)}` : `-$${Math.abs(r.totalPnl / 100).toFixed(0)}`;
        const marker = r.edge > 0.02 ? ' ← EDGE' : r.edge > 0 ? ' ←' : '';
        console.log(`${r.label.padEnd(30)} ${String(r.n).padStart(6)} ${String(r.wins).padStart(6)} ${(r.wr * 100).toFixed(1).padStart(6)}% ${(r.avgAsk * 100).toFixed(1).padStart(6)}¢ ${(r.breakeven * 100).toFixed(1).padStart(6)}% ${edgeStr.padStart(7)} ${pnlStr.padStart(8)} ${totalStr.padStart(10)}${marker}`);
    }
}

async function main() {
    console.log('Loading corrected pricing data...');
    const allTrades = await loadTrades();
    console.log(`Loaded ${allTrades.length} trade scenarios\n`);

    // Filter to T-30 for strategy relevance
    const timeBuckets = [
        { label: 'T-120s', filter: (t: Trade) => t.secondsBeforeEnd >= 110 && t.secondsBeforeEnd <= 130 },
        { label: 'T-60s', filter: (t: Trade) => t.secondsBeforeEnd >= 55 && t.secondsBeforeEnd <= 65 },
        { label: 'T-30s', filter: (t: Trade) => t.secondsBeforeEnd >= 25 && t.secondsBeforeEnd <= 35 },
        { label: 'T-15s', filter: (t: Trade) => t.secondsBeforeEnd >= 10 && t.secondsBeforeEnd <= 20 },
    ];

    // ============================================
    // 1. UNDERDOG vs FAVORITE by entry timing
    // ============================================
    printTable(
        timeBuckets.map(tb => analyze(allTrades.filter(t => t.side === 'UNDERDOG' && tb.filter(t)), `Underdog ${tb.label}`)),
        'UNDERDOG BY ENTRY TIMING'
    );
    printTable(
        timeBuckets.map(tb => analyze(allTrades.filter(t => t.side === 'FAVORITE' && tb.filter(t)), `Favorite ${tb.label}`)),
        'FAVORITE BY ENTRY TIMING'
    );

    // ============================================
    // 2. FINE-GRAINED PRICE BUCKETS (T-30, underdog)
    // ============================================
    const t30 = allTrades.filter(t => t.secondsBeforeEnd >= 25 && t.secondsBeforeEnd <= 35);

    const priceBuckets = [
        { label: '2-5¢', lo: 0.02, hi: 0.05 },
        { label: '5-10¢', lo: 0.05, hi: 0.10 },
        { label: '10-15¢', lo: 0.10, hi: 0.15 },
        { label: '15-20¢', lo: 0.15, hi: 0.20 },
        { label: '20-25¢', lo: 0.20, hi: 0.25 },
        { label: '25-30¢', lo: 0.25, hi: 0.30 },
        { label: '30-35¢', lo: 0.30, hi: 0.35 },
        { label: '35-40¢', lo: 0.35, hi: 0.40 },
        { label: '40-45¢', lo: 0.40, hi: 0.45 },
        { label: '45-50¢', lo: 0.45, hi: 0.50 },
        { label: '50-55¢ (fav)', lo: 0.50, hi: 0.55 },
        { label: '55-60¢ (fav)', lo: 0.55, hi: 0.60 },
        { label: '60-70¢ (fav)', lo: 0.60, hi: 0.70 },
        { label: '70-80¢ (fav)', lo: 0.70, hi: 0.80 },
        { label: '80-90¢ (fav)', lo: 0.80, hi: 0.90 },
        { label: '90-98¢ (fav)', lo: 0.90, hi: 0.98 },
    ];

    printTable(
        priceBuckets.map(pb => analyze(
            t30.filter(t => t.entryAsk >= pb.lo && t.entryAsk < pb.hi),
            `T-30 ${pb.label}`
        )),
        'ALL SIDES BY PRICE BUCKET (T-30)'
    );

    // ============================================
    // 3. BY CRYPTO (T-30, all prices)
    // ============================================
    const cryptos = ['btc', 'eth', 'sol', 'xrp'];
    for (const side of ['UNDERDOG', 'FAVORITE'] as const) {
        printTable(
            cryptos.map(c => analyze(
                t30.filter(t => t.crypto === c && t.side === side),
                `${c.toUpperCase()} ${side.toLowerCase()}`
            )),
            `${side} BY CRYPTO (T-30, all prices)`
        );
    }

    // ============================================
    // 4. BY INTERVAL (5m vs 15m)
    // ============================================
    for (const side of ['UNDERDOG', 'FAVORITE'] as const) {
        printTable(
            [5, 15].map(iv => analyze(
                t30.filter(t => t.interval === iv && t.side === side),
                `${iv}m ${side.toLowerCase()}`
            )),
            `${side} BY INTERVAL (T-30)`
        );
    }

    // ============================================
    // 5. SWEET SPOT: 35-50¢ underdog, sliced further
    // ============================================
    const sweetSpot = t30.filter(t => t.side === 'UNDERDOG' && t.entryAsk >= 0.35 && t.entryAsk < 0.50);
    console.log(`\n=== SWEET SPOT DEEP DIVE: 35-50¢ Underdog T-30 (N=${sweetSpot.length}) ===`);

    printTable(
        cryptos.map(c => analyze(sweetSpot.filter(t => t.crypto === c), `${c.toUpperCase()} 35-50¢`)),
        '35-50¢ UNDERDOG BY CRYPTO'
    );

    printTable(
        [5, 15].map(iv => analyze(sweetSpot.filter(t => t.interval === iv), `${iv}m 35-50¢`)),
        '35-50¢ UNDERDOG BY INTERVAL'
    );

    // Spread filter
    const spreadBuckets = [
        { label: 'Tight (≤1¢)', filter: (t: Trade) => t.spread <= 0.01 },
        { label: 'Medium (1-2¢)', filter: (t: Trade) => t.spread > 0.01 && t.spread <= 0.02 },
        { label: 'Wide (>2¢)', filter: (t: Trade) => t.spread > 0.02 },
    ];
    printTable(
        spreadBuckets.map(sb => analyze(sweetSpot.filter(sb.filter), `35-50¢ ${sb.label}`)),
        '35-50¢ UNDERDOG BY SPREAD'
    );

    // Depth imbalance
    const depthBuckets = [
        { label: 'UnderdogHeavy (>1.5x)', filter: (t: Trade) => t.depthImbalance > 1.5 },
        { label: 'Balanced (0.7-1.5x)', filter: (t: Trade) => t.depthImbalance >= 0.7 && t.depthImbalance <= 1.5 },
        { label: 'FavHeavy (<0.7x)', filter: (t: Trade) => t.depthImbalance < 0.7 },
    ];
    printTable(
        depthBuckets.map(db => analyze(sweetSpot.filter(db.filter), `35-50¢ ${db.label}`)),
        '35-50¢ UNDERDOG BY DEPTH IMBALANCE'
    );

    // ============================================
    // 6. FAVORITE SIDE: buy the favorite at 50-65¢
    // ============================================
    const favSweetSpot = t30.filter(t => t.side === 'FAVORITE' && t.entryAsk >= 0.50 && t.entryAsk < 0.65);
    console.log(`\n=== FAVORITE SWEET SPOT: 50-65¢ T-30 (N=${favSweetSpot.length}) ===`);

    printTable(
        cryptos.map(c => analyze(favSweetSpot.filter(t => t.crypto === c), `${c.toUpperCase()} fav 50-65¢`)),
        '50-65¢ FAVORITE BY CRYPTO'
    );

    printTable(
        spreadBuckets.map(sb => analyze(favSweetSpot.filter(sb.filter), `Fav 50-65¢ ${sb.label}`)),
        '50-65¢ FAVORITE BY SPREAD'
    );

    // ============================================
    // 7. TIME OF DAY
    // ============================================
    const hourBuckets = [
        { label: 'Asia (0-8 UTC)', filter: (t: Trade) => t.hourUTC >= 0 && t.hourUTC < 8 },
        { label: 'Europe (8-16 UTC)', filter: (t: Trade) => t.hourUTC >= 8 && t.hourUTC < 16 },
        { label: 'US (16-24 UTC)', filter: (t: Trade) => t.hourUTC >= 16 && t.hourUTC < 24 },
    ];
    printTable(
        hourBuckets.map(hb => analyze(sweetSpot.filter(hb.filter), `35-50¢ ${hb.label}`)),
        '35-50¢ UNDERDOG BY TIME OF DAY'
    );

    // ============================================
    // 8. COMBO FILTERS — look for real edges
    // ============================================
    console.log(`\n=== COMBO FILTER HUNT ===`);

    const combos: { label: string; filter: (t: Trade) => boolean }[] = [
        { label: 'BTC 35-50¢ 5m tight', filter: t => t.crypto === 'btc' && t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.interval === 5 && t.spread <= 0.01 && t.side === 'UNDERDOG' },
        { label: 'ETH 35-50¢ 5m tight', filter: t => t.crypto === 'eth' && t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.interval === 5 && t.spread <= 0.01 && t.side === 'UNDERDOG' },
        { label: 'BTC 40-50¢ any', filter: t => t.crypto === 'btc' && t.entryAsk >= 0.40 && t.entryAsk < 0.50 && t.side === 'UNDERDOG' },
        { label: 'ETH 40-50¢ any', filter: t => t.crypto === 'eth' && t.entryAsk >= 0.40 && t.entryAsk < 0.50 && t.side === 'UNDERDOG' },
        { label: 'Any 45-50¢ underdog', filter: t => t.entryAsk >= 0.45 && t.entryAsk < 0.50 && t.side === 'UNDERDOG' },
        { label: 'Any 50-55¢ favorite', filter: t => t.entryAsk >= 0.50 && t.entryAsk < 0.55 && t.side === 'FAVORITE' },
        { label: 'BTC 5m fav 55-65¢', filter: t => t.crypto === 'btc' && t.interval === 5 && t.entryAsk >= 0.55 && t.entryAsk < 0.65 && t.side === 'FAVORITE' },
        { label: 'ETH 5m fav 55-65¢', filter: t => t.crypto === 'eth' && t.interval === 5 && t.entryAsk >= 0.55 && t.entryAsk < 0.65 && t.side === 'FAVORITE' },
        { label: 'Any 35-50¢ UdogHeavy', filter: t => t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.side === 'UNDERDOG' && t.depthImbalance > 1.5 },
        { label: 'Any 35-50¢ FavHeavy', filter: t => t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.side === 'UNDERDOG' && t.depthImbalance < 0.7 },
        { label: 'BTC+ETH 35-50¢ 15m', filter: t => (t.crypto === 'btc' || t.crypto === 'eth') && t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.interval === 15 && t.side === 'UNDERDOG' },
        { label: 'SOL+XRP 35-50¢ 5m', filter: t => (t.crypto === 'sol' || t.crypto === 'xrp') && t.entryAsk >= 0.35 && t.entryAsk < 0.50 && t.interval === 5 && t.side === 'UNDERDOG' },
        { label: 'Any 40-50¢ tight sprd', filter: t => t.entryAsk >= 0.40 && t.entryAsk < 0.50 && t.spread <= 0.01 && t.side === 'UNDERDOG' },
        { label: 'Any fav 55-65¢ tight', filter: t => t.entryAsk >= 0.55 && t.entryAsk < 0.65 && t.spread <= 0.01 && t.side === 'FAVORITE' },
    ];

    printTable(
        combos.map(c => analyze(t30.filter(c.filter), c.label)),
        'COMBO FILTERS (T-30)'
    );

    // ============================================
    // 9. SUMMARY: Top edges
    // ============================================
    console.log(`\n=== TOP FINDINGS ===`);
    const allResults = combos.map(c => analyze(t30.filter(c.filter), c.label)).filter(r => r !== null) as NonNullable<ReturnType<typeof analyze>>[];
    const profitable = allResults.filter(r => r.edge > 0).sort((a, b) => b.edge - a.edge);

    if (profitable.length === 0) {
        console.log('No combos with positive edge found.');
    } else {
        for (const r of profitable.slice(0, 5)) {
            const dailyTrades = r.n / 10; // rough: 10 days of data
            const dailyPnl = dailyTrades * r.avgPnl / 100;
            console.log(`  ${r.label}: ${(r.wr * 100).toFixed(1)}% WR, +${(r.edge * 100).toFixed(1)}pp edge, ${r.avgPnl.toFixed(1)}¢/trade, ~$${dailyPnl.toFixed(0)}/day (${r.n} trades)`);
        }
    }
}

main().catch(e => console.error(e));
