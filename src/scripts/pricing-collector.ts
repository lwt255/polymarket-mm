/**
 * Passive Pricing Data Collector for BTC 5-Minute Markets
 *
 * Captures bid/ask snapshots for both UP and DOWN outcomes at multiple
 * points during each 5-minute market window. Does NOT trade — just observes.
 *
 * Goal: Find "irregular patterns" in how the market prices outcomes.
 * - Are certain probability levels systematically mispriced?
 * - Does the market's implied probability match actual resolution rates?
 * - Are there spread/depth patterns that predict outcomes?
 *
 * Output: Appends JSONL to pricing-data.jsonl
 *
 * Usage: npx tsx src/scripts/pricing-collector.ts --duration 480
 *        (runs for 8 hours = ~96 markets)
 */

import { ChainlinkFeed } from './crypto-5min/chainlink-feed.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const OUTPUT_FILE = 'pricing-data.jsonl';
const REJECTED_OUTPUT_FILE = 'pricing-data.rejected.jsonl';
const MIN_ACCEPTABLE_SNAPSHOTS = 8;

// All crypto/timeframe combos to monitor
const MARKET_CONFIGS = [
    { crypto: 'btc', clSymbol: 'btc/usd', interval: 5 },
    { crypto: 'eth', clSymbol: 'eth/usd', interval: 5 },
    { crypto: 'sol', clSymbol: 'sol/usd', interval: 5 },
    { crypto: 'xrp', clSymbol: 'xrp/usd', interval: 5 },
    { crypto: 'btc', clSymbol: 'btc/usd', interval: 15 },
    { crypto: 'eth', clSymbol: 'eth/usd', interval: 15 },
    { crypto: 'sol', clSymbol: 'sol/usd', interval: 15 },
    { crypto: 'xrp', clSymbol: 'xrp/usd', interval: 15 },
] as const;

const log = (...args: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.error(`[${ts}]`, ...args);
};

// --- Types ---

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
    impliedUpProb: number;     // midpoint-based implied probability
    bidSumCheck: number;       // upBid + downBid (should be < 1.0)
    askSumCheck: number;       // upAsk + downAsk (should be > 1.0)
    clPrice: number;           // Chainlink BTC price at this snapshot
    clMoveFromOpen: number;    // CL price change from market open ($)
    hourUTC: number;           // hour of day (0-23) for time-of-day analysis
}

interface SimulatedTrade {
    snapshotSecBefore: number;   // which snapshot this simulates entry at
    side: 'UP' | 'DOWN';        // which underdog side we'd buy
    entryAsk: number;           // price we'd pay (ask)
    entryCostCents: number;     // cost per share in cents (ask * 100)
    takerFeeCents: number;      // 0.1% taker fee on entry
    gasCostCents: number;       // ~100 cents ($1) fixed gas
    spreadCostCents: number;    // (ask - bid) * 100 / 2 = half-spread
    totalCostCents: number;     // entryCost + takerFee + gas + spreadCost
    won: boolean;               // did this side win?
    payoutCents: number;        // 100 if won, 0 if lost
    netPnlCents: number;        // payout - totalCost
    favoriteImpliedProb: number; // what the market thought the favorite's odds were
}

interface MarketRecord {
    slug: string;
    marketEnd: number;
    snapshots: BookSnapshot[];
    resolution: 'UP' | 'DOWN' | 'UNKNOWN';
    chainlinkOpen: number;
    chainlinkClose: number;
    chainlinkMoveDollars: number;
    openUpBid: number;         // first snapshot UP bid
    openDownBid: number;       // first snapshot DOWN bid
    finalUpBid: number;        // last snapshot UP bid
    finalDownBid: number;      // last snapshot DOWN bid
    simulatedTrades: SimulatedTrade[];  // what-if analysis at each snapshot
    volume: number;            // market trading volume (from Gamma API)
    prevResolution: string;    // previous market's resolution (streak analysis)
    hourUTC: number;           // hour of day when market ended
    collectedAt: string;
    qualityWarnings?: string[];
}

// --- Helpers ---

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-collector)' },
        });
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

function isEmptyBookSnapshot(snap: Pick<BookSnapshot, 'upBid' | 'upAsk' | 'downBid' | 'downAsk'>): boolean {
    return snap.upBid === 0 && snap.upAsk === 1 && snap.downBid === 0 && snap.downAsk === 1;
}

interface MarketWithConfig {
    market: any;
    crypto: string;
    clSymbol: string;
    interval: number;
}

async function findAllCurrentMarkets(): Promise<MarketWithConfig[]> {
    const now = Math.floor(Date.now() / 1000);
    const found: MarketWithConfig[] = [];
    const seenSlugs = new Set<string>();

    const promises = MARKET_CONFIGS.map(async (cfg) => {
        const step = cfg.interval * 60; // 300 for 5m, 900 for 15m
        const rounded = Math.floor(now / step) * step;
        const suffix = cfg.interval === 5 ? '5m' : '15m';

        for (const ts of [rounded, rounded + step]) {
            const slug = `${cfg.crypto}-updown-${suffix}-${ts}`;
            if (seenSlugs.has(slug)) continue;
            seenSlugs.add(slug);

            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (data && data.length > 0) {
                const m = data[0];
                const endDate = new Date(m.endDate).getTime();
                if (endDate > Date.now()) {
                    found.push({ market: m, crypto: cfg.crypto, clSymbol: cfg.clSymbol, interval: cfg.interval });
                    return; // found one for this config, move on
                }
            }
        }
    });

    await Promise.all(promises);
    return found;
}

function getTokenIds(market: any): { upToken: string; downToken: string } | null {
    try {
        const tokens = JSON.parse(market.clobTokenIds || '[]');
        const outcomes = JSON.parse(market.outcomes || '[]');
        const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
        const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
        if (upIdx === -1 || downIdx === -1 || !tokens[upIdx] || !tokens[downIdx]) return null;
        return { upToken: tokens[upIdx], downToken: tokens[downIdx] };
    } catch {
        return null;
    }
}

interface FullBookInfo {
    bestBid: number;
    bestAsk: number;
    spread: number;
    bidDepth: number;
    askDepth: number;
}

async function getFullBookInfo(tokenId: string): Promise<FullBookInfo> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, spread: 1, bidDepth: 0, askDepth: 0 };

    const bids = (raw.bids || [])
        .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || [])
        .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const bidDepth = bids.reduce((sum: number, b: any) => sum + b.size, 0);
    const askDepth = asks.reduce((sum: number, a: any) => sum + a.size, 0);

    return { bestBid, bestAsk, spread: bestAsk - bestBid, bidDepth, askDepth };
}

async function takeSnapshot(upToken: string, downToken: string, endTime: number, clPrice: number, clOpen: number): Promise<BookSnapshot> {
    const [upBook, downBook] = await Promise.all([
        getFullBookInfo(upToken),
        getFullBookInfo(downToken),
    ]);

    const upMid = (upBook.bestBid + upBook.bestAsk) / 2;
    const downMid = (downBook.bestBid + downBook.bestAsk) / 2;
    const impliedUpProb = upMid / (upMid + downMid) || 0.5;

    return {
        timestamp: Date.now(),
        secondsBeforeEnd: Math.round((endTime - Date.now()) / 1000),
        upBid: upBook.bestBid,
        upAsk: upBook.bestAsk,
        upSpread: upBook.spread,
        upBidDepth: Math.round(upBook.bidDepth),
        upAskDepth: Math.round(upBook.askDepth),
        downBid: downBook.bestBid,
        downAsk: downBook.bestAsk,
        downSpread: downBook.spread,
        downBidDepth: Math.round(downBook.bidDepth),
        downAskDepth: Math.round(downBook.askDepth),
        upMid,
        downMid,
        impliedUpProb,
        bidSumCheck: upBook.bestBid + downBook.bestBid,
        askSumCheck: upBook.bestAsk + downBook.bestAsk,
        clPrice,
        clMoveFromOpen: clPrice - clOpen,
        hourUTC: new Date().getUTCHours(),
    };
}

async function resolveOutcome(slug: string, retries = 15): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    for (let i = 0; i < retries; i++) {
        try {
            const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
            if (data?.[0]) {
                const prices = JSON.parse(data[0].outcomePrices || '[]').map(Number);
                const outcomes = JSON.parse(data[0].outcomes || '[]');
                const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
                const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
                if (upIdx !== -1 && prices[upIdx] >= 0.95) return 'UP';
                if (downIdx !== -1 && prices[downIdx] >= 0.95) return 'DOWN';
            }
        } catch {
            // API error, retry
        }
        if (i < retries - 1) await sleep(4000);
    }
    return 'UNKNOWN';
}

// --- Simulated Trade Analysis ---

const TAKER_FEE_RATE = 0.001;  // 0.1%
const GAS_COST_CENTS = 100;     // ~$1 per tx on Polygon

function simulateTrades(snapshots: BookSnapshot[], resolution: 'UP' | 'DOWN' | 'UNKNOWN'): SimulatedTrade[] {
    if (resolution === 'UNKNOWN') return [];

    return snapshots.flatMap((snap) => {
        if (isEmptyBookSnapshot(snap)) return [];

        // Identify the underdog (lower-priced side)
        const upIsUnderdog = snap.upMid < snap.downMid;
        const side: 'UP' | 'DOWN' = upIsUnderdog ? 'UP' : 'DOWN';
        const entryAsk = upIsUnderdog ? snap.upAsk : snap.downAsk;
        const entryBid = upIsUnderdog ? snap.upBid : snap.downBid;
        const favoriteImpliedProb = upIsUnderdog ? snap.downMid : snap.upMid;

        if (entryAsk <= 0 || entryAsk >= 1) return [];

        const entryCostCents = entryAsk * 100;
        const takerFeeCents = entryCostCents * TAKER_FEE_RATE;
        const spreadCostCents = ((entryAsk - entryBid) * 100) / 2;
        const totalCostCents = entryCostCents + takerFeeCents + GAS_COST_CENTS + spreadCostCents;

        const won = side === resolution;
        const payoutCents = won ? 100 : 0;
        const netPnlCents = payoutCents - totalCostCents;

        return [{
            snapshotSecBefore: snap.secondsBeforeEnd,
            side,
            entryAsk,
            entryCostCents,
            takerFeeCents,
            gasCostCents: GAS_COST_CENTS,
            spreadCostCents,
            totalCostCents,
            won,
            payoutCents,
            netPnlCents,
            favoriteImpliedProb,
        }];
    });
}

function assessRecordQuality(record: MarketRecord): { rejected: boolean; issues: string[]; warnings: string[] } {
    const issues: string[] = [];
    const warnings: string[] = [];
    const emptySnapshots = record.snapshots.filter(isEmptyBookSnapshot).length;

    if (record.snapshots.length < MIN_ACCEPTABLE_SNAPSHOTS) {
        issues.push(`only ${record.snapshots.length} snapshots captured (minimum ${MIN_ACCEPTABLE_SNAPSHOTS})`);
    }

    if (emptySnapshots === record.snapshots.length) {
        issues.push(`all ${record.snapshots.length} snapshots had empty books`);
    } else if (emptySnapshots > 0) {
        warnings.push(`${emptySnapshots}/${record.snapshots.length} snapshots had empty books`);
    }

    if (record.simulatedTrades.length === 0) {
        issues.push('no tradable snapshots were available for simulation');
    }

    return {
        rejected: issues.length > 0,
        issues,
        warnings,
    };
}

// --- Main ---

async function collectOneMarket(chainlink: ChainlinkFeed, prevResolution: string, marketInfo?: MarketWithConfig): Promise<MarketRecord | null> {
    let market: any;
    let clSymbol = 'btc/usd';

    if (marketInfo) {
        market = marketInfo.market;
        clSymbol = marketInfo.clSymbol;
    } else {
        // Legacy: find BTC 5m market
        const all = await findAllCurrentMarkets();
        const btc5m = all.find(m => m.crypto === 'btc' && m.interval === 5);
        if (!btc5m) {
            log('No market found, waiting...');
            return null;
        }
        market = btc5m.market;
        clSymbol = btc5m.clSymbol;
    }

    const tokens = getTokenIds(market);
    if (!tokens) {
        log('Could not parse token IDs');
        return null;
    }

    const endTime = new Date(market.endDate).getTime();
    const slug = market.slug;
    const timeLeft = Math.round((endTime - Date.now()) / 1000);

    log(`\n=== ${slug} | ${timeLeft}s remaining ===`);

    const chainlinkOpen = chainlink.getPrice(clSymbol);
    const snapshots: BookSnapshot[] = [];

    // Take snapshots at key intervals before market end
    // Snapshot schedule: as early as possible, then every 30s, plus final at T-10s
    const snapshotTimesBeforeEnd = [240, 210, 180, 150, 120, 90, 60, 45, 30, 15, 10];

    for (const secBefore of snapshotTimesBeforeEnd) {
        const targetTime = endTime - secBefore * 1000;
        const waitMs = targetTime - Date.now();

        // Skip snapshots we're already well past (>5s late)
        if (waitMs < -5000) continue;

        if (waitMs > 0) {
            await sleep(waitMs);
        }

        // Stop if market is about to end
        if (Date.now() > endTime - 5000) break;

        try {
            const snap = await takeSnapshot(tokens.upToken, tokens.downToken, endTime, chainlink.getPrice(clSymbol), chainlinkOpen);
            snapshots.push(snap);

            if (isEmptyBookSnapshot(snap)) {
                log(`  T-${snap.secondsBeforeEnd}s: EMPTY BOOK on both sides`);
            } else {
                const upPct = (snap.upBid * 100).toFixed(0);
                const downPct = (snap.downBid * 100).toFixed(0);
                log(`  T-${snap.secondsBeforeEnd}s: UP=${upPct}¢ DOWN=${downPct}¢ | spread: ${(snap.upSpread * 100).toFixed(0)}¢/${(snap.downSpread * 100).toFixed(0)}¢ | implied UP: ${(snap.impliedUpProb * 100).toFixed(1)}%`);
            }
        } catch (err: any) {
            log(`  Snapshot error at T-${secBefore}s: ${err.message}`);
        }
    }

    // Need at least 2 snapshots for meaningful data
    if (snapshots.length < 2) {
        log(`  Only ${snapshots.length} snapshot(s), skipping market`);
        return null;
    }

    // Wait for market to end
    const msUntilEnd = endTime - Date.now();
    if (msUntilEnd > 0) {
        log(`  Waiting ${(msUntilEnd / 1000).toFixed(0)}s for market to end...`);
        await sleep(msUntilEnd + 3000); // +3s to ensure market is done
    } else {
        await sleep(3000);
    }

    // Capture Chainlink close price right after market ends
    const chainlinkClose = chainlink.getPrice(clSymbol);

    // Primary resolution: Chainlink (instant, reliable)
    const clResolution: 'UP' | 'DOWN' | 'UNKNOWN' =
        (chainlinkOpen > 0 && chainlinkClose > 0)
            ? (chainlinkClose >= chainlinkOpen ? 'UP' : 'DOWN')
            : 'UNKNOWN';

    // Secondary: check Gamma API for official resolution (wait longer for it)
    await sleep(15000); // 15s buffer for API to update
    const apiResolution = await resolveOutcome(slug);

    // Use API resolution if available, fall back to Chainlink
    const resolution = apiResolution !== 'UNKNOWN' ? apiResolution : clResolution;

    if (apiResolution !== 'UNKNOWN' && apiResolution !== clResolution && clResolution !== 'UNKNOWN') {
        log(`  WARNING: API says ${apiResolution} but Chainlink says ${clResolution} — using API`);
    }

    log(`  Resolution: ${resolution} (API: ${apiResolution}, CL: ${clResolution}) | $${chainlinkOpen.toFixed(2)} → $${chainlinkClose.toFixed(2)} (${chainlinkClose >= chainlinkOpen ? '+' : ''}$${(chainlinkClose - chainlinkOpen).toFixed(2)})`);

    // Simulate underdog trades at each snapshot
    const simulatedTrades = simulateTrades(snapshots, resolution);
    if (simulatedTrades.length > 0) {
        const t120 = simulatedTrades.find(t => t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130);
        const t60 = simulatedTrades.find(t => t.snapshotSecBefore >= 55 && t.snapshotSecBefore <= 65);
        const t30 = simulatedTrades.find(t => t.snapshotSecBefore >= 25 && t.snapshotSecBefore <= 35);
        const fmt = (t: SimulatedTrade | undefined) => {
            if (!t) return 'N/A';
            return `buy ${t.side} @${(t.entryAsk * 100).toFixed(0)}¢ → ${t.won ? 'WIN' : 'LOSS'} ${t.netPnlCents >= 0 ? '+' : ''}${t.netPnlCents.toFixed(1)}¢ (fav=${(t.favoriteImpliedProb * 100).toFixed(0)}%)`;
        };
        log(`  Sim trades: T-120s: ${fmt(t120)} | T-60s: ${fmt(t60)} | T-30s: ${fmt(t30)}`);
    }

    const volume = parseFloat(market.volume || '0');

    return {
        slug,
        marketEnd: endTime,
        snapshots,
        resolution,
        chainlinkOpen,
        chainlinkClose,
        chainlinkMoveDollars: chainlinkClose - chainlinkOpen,
        openUpBid: snapshots[0].upBid,
        openDownBid: snapshots[0].downBid,
        finalUpBid: snapshots[snapshots.length - 1].upBid,
        finalDownBid: snapshots[snapshots.length - 1].downBid,
        simulatedTrades,
        volume,
        prevResolution,
        hourUTC: new Date().getUTCHours(),
        collectedAt: new Date().toISOString(),
    };
}

// --- Running Stats ---

interface RunningStats {
    markets: number;
    simWins: number;
    simLosses: number;
    simPnlCents: number;
    // By entry time bucket
    byEntry: Record<string, { wins: number; losses: number; pnlCents: number }>;
    // By favorite confidence bucket
    byConfidence: Record<string, { wins: number; losses: number; pnlCents: number }>;
}

function updateStats(stats: RunningStats, trades: SimulatedTrade[]) {
    stats.markets++;

    for (const t of trades) {
        // Bucket by entry time
        const timeBucket = `T-${t.snapshotSecBefore}s`;
        if (!stats.byEntry[timeBucket]) stats.byEntry[timeBucket] = { wins: 0, losses: 0, pnlCents: 0 };
        stats.byEntry[timeBucket].pnlCents += t.netPnlCents;
        if (t.won) { stats.byEntry[timeBucket].wins++; } else { stats.byEntry[timeBucket].losses++; }

        // Bucket by favorite confidence (the mispricing zone analysis)
        const confPct = Math.round(t.favoriteImpliedProb * 100);
        const confBucket = confPct >= 80 ? '80-100%' : confPct >= 60 ? '60-80%' : confPct >= 50 ? '50-60%' : '<50%';
        if (!stats.byConfidence[confBucket]) stats.byConfidence[confBucket] = { wins: 0, losses: 0, pnlCents: 0 };
        stats.byConfidence[confBucket].pnlCents += t.netPnlCents;
        if (t.won) { stats.byConfidence[confBucket].wins++; } else { stats.byConfidence[confBucket].losses++; }

        // Overall (use T-120s as the canonical entry)
        if (t.snapshotSecBefore >= 110 && t.snapshotSecBefore <= 130) {
            if (t.won) stats.simWins++; else stats.simLosses++;
            stats.simPnlCents += t.netPnlCents;
        }
    }
}

function printStats(stats: RunningStats) {
    const total = stats.simWins + stats.simLosses;
    const winRate = total > 0 ? (stats.simWins / total * 100).toFixed(1) : '0';
    log(`\n--- Running Summary (${stats.markets} markets) ---`);
    log(`  T-120s underdog: ${stats.simWins}W/${stats.simLosses}L (${winRate}% win) | PnL: ${stats.simPnlCents >= 0 ? '+' : ''}${stats.simPnlCents.toFixed(0)}¢`);

    log(`  By entry time:`);
    for (const [bucket, data] of Object.entries(stats.byEntry).sort()) {
        const n = data.wins + data.losses;
        const wr = n > 0 ? (data.wins / n * 100).toFixed(0) : '0';
        log(`    ${bucket}: ${data.wins}W/${data.losses}L (${wr}%) PnL: ${data.pnlCents >= 0 ? '+' : ''}${data.pnlCents.toFixed(0)}¢`);
    }

    log(`  By favorite confidence (mispricing zones):`);
    for (const [bucket, data] of Object.entries(stats.byConfidence).sort()) {
        const n = data.wins + data.losses;
        const wr = n > 0 ? (data.wins / n * 100).toFixed(0) : '0';
        log(`    Fav ${bucket}: ${data.wins}W/${data.losses}L (${wr}%) PnL: ${data.pnlCents >= 0 ? '+' : ''}${data.pnlCents.toFixed(0)}¢`);
    }
    log(`---`);
}

async function main() {
    const args = process.argv.slice(2);
    const durIdx = args.indexOf('--duration');
    const continuous = args.includes('--continuous');
    const durationMinutes = continuous ? Infinity : (durIdx !== -1 ? parseInt(args[durIdx + 1] || '60') : 60);
    const endTime = continuous ? Infinity : Date.now() + durationMinutes * 60 * 1000;

    log(`=== Pricing Data Collector (Multi-Crypto) ===`);
    log(`Mode: ${continuous ? 'CONTINUOUS (runs until stopped)' : `${durationMinutes} minutes`}`);
    log(`Watching: ${MARKET_CONFIGS.map(c => `${c.crypto.toUpperCase()}-${c.interval}m`).join(', ')}`);
    log(`Output: ${OUTPUT_FILE}`);
    log(`Simulated trades: enabled (taker fee: ${TAKER_FEE_RATE * 100}%, gas: ${GAS_COST_CENTS}¢)`);

    // Connect to Chainlink for ALL crypto feeds
    const chainlink = new ChainlinkFeed(); // subscribes to all by default
    await chainlink.connect();

    // Wait for at least BTC price
    let waitCount = 0;
    while (chainlink.getPrice('btc/usd') === 0 && waitCount < 30) {
        await sleep(1000);
        waitCount++;
    }
    if (chainlink.getPrice('btc/usd') === 0) {
        log('ERROR: Could not get Chainlink BTC price after 30s');
        process.exit(1);
    }
    // Wait a bit more for other feeds to connect
    await sleep(3000);
    const prices = chainlink.getAllPrices();
    log(`Chainlink prices: ${Object.entries(prices).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(' | ')}`);

    const { appendFileSync } = await import('node:fs');
    let marketsCollected = 0;
    let rejectedMarkets = 0;
    const collectedSlugs = new Set<string>(); // dedup across all markets
    let prevResolution = 'UNKNOWN'; // track previous market outcome

    const stats: RunningStats = {
        markets: 0, simWins: 0, simLosses: 0, simPnlCents: 0,
        byEntry: {}, byConfidence: {},
    };

    // Print summary every N markets
    const SUMMARY_INTERVAL = 20; // more markets now, so bump the interval

    while (Date.now() < endTime || continuous) {
        try {
            // Find ALL active markets across cryptos and timeframes
            const activeMarkets = await findAllCurrentMarkets();

            if (activeMarkets.length === 0) {
                log('No markets found, waiting...');
            } else {
                // Find the soonest-ending market group (5m markets end before 15m)
                // Group by end time and process the soonest group together
                const byEndTime = new Map<number, MarketWithConfig[]>();
                for (const m of activeMarkets) {
                    const endMs = new Date(m.market.endDate).getTime();
                    // Round to nearest 10s to group markets ending at ~same time
                    const bucket = Math.round(endMs / 10000) * 10000;
                    if (!byEndTime.has(bucket)) byEndTime.set(bucket, []);
                    byEndTime.get(bucket)!.push(m);
                }

                // Process the soonest-ending batch
                const soonestEnd = Math.min(...byEndTime.keys());
                const batch = byEndTime.get(soonestEnd) || [];

                log(`\n--- Batch: ${batch.length} markets ending at ${new Date(soonestEnd).toISOString().slice(11, 19)} ---`);

                // Collect all markets in this batch in parallel
                const results = await Promise.all(
                    batch.map(async (mInfo) => {
                        if (collectedSlugs.has(mInfo.market.slug)) return null;
                        try {
                            return await collectOneMarket(chainlink, prevResolution, mInfo);
                        } catch (err: any) {
                            log(`ERROR collecting ${mInfo.market.slug}: ${err.message}`);
                            return null;
                        }
                    })
                );

                // Save results
                for (const record of results) {
                    if (record && record.snapshots.length > 0 && !collectedSlugs.has(record.slug)) {
                        const quality = assessRecordQuality(record);
                        record.prevResolution = prevResolution;
                        if (quality.warnings.length > 0) {
                            record.qualityWarnings = quality.warnings;
                            log(`  DATA WARNING ${record.slug}: ${quality.warnings.join('; ')}`);
                        }

                        collectedSlugs.add(record.slug);
                        prevResolution = record.resolution;

                        if (quality.rejected) {
                            rejectedMarkets++;
                            appendFileSync(REJECTED_OUTPUT_FILE, JSON.stringify({
                                ...record,
                                qualityIssues: quality.issues,
                                rejectedAt: new Date().toISOString(),
                            }) + '\n');
                            log(`  REJECTED ${record.slug}: ${quality.issues.join('; ')}`);
                            continue;
                        }

                        appendFileSync(OUTPUT_FILE, JSON.stringify(record) + '\n');
                        marketsCollected++;
                        log(`  Saved ${record.slug} (${marketsCollected} accepted, ${rejectedMarkets} rejected)`);

                        if (record.simulatedTrades.length > 0) {
                            updateStats(stats, record.simulatedTrades);
                        }

                        if (marketsCollected % SUMMARY_INTERVAL === 0) {
                            printStats(stats);
                        }
                    }
                }
            }
        } catch (err: any) {
            log(`ERROR in collection loop: ${err.message}`);
            await sleep(15000);
        }
    }

    // Final summary
    printStats(stats);
    chainlink.disconnect();
    log(`\n=== Collection Complete ===`);
    log(`Markets collected: ${marketsCollected} accepted, ${rejectedMarkets} rejected`);
    log(`Data file: ${OUTPUT_FILE}`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
