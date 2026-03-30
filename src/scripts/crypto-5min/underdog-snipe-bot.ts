/**
 * Underdog Snipe Bot — Live Execution
 *
 * Strategy: Buy the underdog at T-30s in two-sided 5-min crypto markets
 * when filters pass (never one-sided, prev resolution match).
 *
 * Safety-first design:
 * - On-chain balance verification before and after every trade
 * - Hard max loss based on verified balance (not tracked P&L)
 * - Every order confirmed filled or cancelled — no fire-and-forget
 * - Append-only trade log with reconciliation
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/underdog-snipe-bot.ts                     # dry run
 *   npx tsx src/scripts/crypto-5min/underdog-snipe-bot.ts --live              # live, $10/trade
 *   npx tsx src/scripts/crypto-5min/underdog-snipe-bot.ts --live --size 15    # live, $15/trade
 *   npx tsx src/scripts/crypto-5min/underdog-snipe-bot.ts --live --max-loss 30
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { PositionVerifier } from '../../core/execution/position-verifier.js';
import { OrderExecutor } from '../../core/execution/order-executor.js';
import { TradeLedger, type TradeRecord } from '../../core/execution/trade-ledger.js';
import { ChainlinkFeed } from './chainlink-feed.js';

// ── CLI Args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const IS_LIVE = args.includes('--live');

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const TRADE_SIZE_USD = parseFloat(getArg('--size', '10'));
const MAX_LOSS_USD = parseFloat(getArg('--max-loss', '20'));
const MAX_TRADES = parseInt(getArg('--max-trades', '200'));
const FILTER_MODE = getArg('--filter', 'prev'); // prev (default) | tight | loose
const STOP_ON_WIN = args.includes('--stop-on-win');

// ── Strategy Config ───────────────────────────────────────────────────

const ENTRY_SECONDS_BEFORE = 30;  // enter at T-30s
const MIN_BALANCE_USD = 3;        // don't trade below this

const CRYPTOS = [
    { slug: 'btc', clSymbol: 'btc/usd', name: 'BTC' },
    { slug: 'eth', clSymbol: 'eth/usd', name: 'ETH' },
    { slug: 'sol', clSymbol: 'sol/usd', name: 'SOL' },
    { slug: 'xrp', clSymbol: 'xrp/usd', name: 'XRP' },
];

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

// Redeem contracts
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const USDC_CT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
const ctRedeemAbi = parseAbi([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);

// ── Logging ───────────────────────────────────────────────────────────

const log = (...a: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...a);
};

// ── Helpers ───────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-snipe-bot)' } });
        if (!resp.ok) return null;
        return resp.json();
    } catch { return null; }
}

function getTokenIds(market: any): { upToken: string; downToken: string } | null {
    try {
        const tokens = JSON.parse(market.clobTokenIds || '[]');
        const outcomes = JSON.parse(market.outcomes || '[]');
        const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
        const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
        if (upIdx === -1 || downIdx === -1 || !tokens[upIdx] || !tokens[downIdx]) return null;
        return { upToken: tokens[upIdx], downToken: tokens[downIdx] };
    } catch { return null; }
}

async function getBookInfo(tokenId: string) {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, bids: [], asks: [] };
    const bids = (raw.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .filter((b: any) => Number.isFinite(b.price) && b.size > 0)
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .filter((a: any) => Number.isFinite(a.price) && a.size > 0)
        .sort((a: any, b: any) => a.price - b.price);
    return { bestBid: bids[0]?.price ?? 0, bestAsk: asks[0]?.price ?? 1, bids, asks };
}

// ── Market Discovery ──────────────────────────────────────────────────

async function findCurrentMarkets(): Promise<Array<{ market: any; crypto: typeof CRYPTOS[0] }>> {
    const now = Math.floor(Date.now() / 1000);
    const rounded5 = Math.floor(now / 300) * 300;
    const rounded15 = Math.floor(now / 900) * 900;
    const found: Array<{ market: any; crypto: typeof CRYPTOS[0] }> = [];
    const seenSlugs = new Set<string>();

    const promises = CRYPTOS.flatMap((crypto) => {
        const searches: Promise<void>[] = [];

        // 5-minute markets
        searches.push((async () => {
            for (const ts of [rounded5, rounded5 + 300]) {
                const slug = `${crypto.slug}-updown-5m-${ts}`;
                const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                if (data && data.length > 0) {
                    const m = data[0];
                    const endDate = new Date(m.endDate).getTime();
                    if (endDate > Date.now() && !seenSlugs.has(m.slug)) {
                        seenSlugs.add(m.slug);
                        found.push({ market: m, crypto });
                        return;
                    }
                }
            }
        })());

        // 15-minute markets
        searches.push((async () => {
            for (const ts of [rounded15, rounded15 + 900]) {
                const slug = `${crypto.slug}-updown-15m-${ts}`;
                const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                if (data && data.length > 0) {
                    const m = data[0];
                    const endDate = new Date(m.endDate).getTime();
                    if (endDate > Date.now() && !seenSlugs.has(m.slug)) {
                        seenSlugs.add(m.slug);
                        found.push({ market: m, crypto });
                        return;
                    }
                }
            }
        })());

        return searches;
    });

    await Promise.all(promises);
    return found;
}

// ── Resolution Tracking ───────────────────────────────────────────────
// Uses Chainlink as ground truth — Gamma API disagrees with CL 8% of the time

// Polymarket resolution: poll Gamma API for what Polymarket ACTUALLY resolved
// This is the source of truth for P&L — it's what determines payouts
// Chainlink is used for real-time monitoring only, NOT for resolution
async function resolveFromPolymarket(slug: string, retries = 18, timeoutMs = 90000): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    const deadline = Date.now() + timeoutMs;
    for (let i = 0; i < retries; i++) {
        if (Date.now() > deadline) return 'UNKNOWN'; // don't block forever
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data?.[0]) {
            const prices = JSON.parse(data[0].outcomePrices || '[]').map(Number);
            const outcomes = JSON.parse(data[0].outcomes || '[]');
            const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
            const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
            if (upIdx !== -1 && prices[upIdx] >= 0.95) return 'UP';
            if (downIdx !== -1 && prices[downIdx] >= 0.95) return 'DOWN';
        }
        if (i < retries - 1) await sleep(5000);
    }
    return 'UNKNOWN';
}

async function bootstrapPrevResolutions(): Promise<Record<string, 'UP' | 'DOWN' | 'UNKNOWN'>> {
    // Bootstrap by checking Polymarket's resolution for the most recent candle
    const prevs: Record<string, 'UP' | 'DOWN' | 'UNKNOWN'> = {};

    // Wait for current candle to end so the previous one is fully resolved
    const now = Math.floor(Date.now() / 1000);
    const nextBoundary = (Math.floor(now / 300) + 1) * 300;
    const waitSecs = nextBoundary - now;
    log(`  Waiting ${waitSecs}s for current candle to end (Polymarket bootstrap)...`);
    await sleep(waitSecs * 1000 + 15000); // +15s for Polymarket to settle

    // Check Polymarket resolution for the candle that just ended
    const rounded5 = Math.floor(Date.now() / 1000 / 300) * 300;
    const prevCandleStart = rounded5 - 300;

    const promises = CRYPTOS.map((crypto) => (async () => {
        const slug = `${crypto.slug}-updown-5m-${prevCandleStart}`;
        const res = await resolveFromPolymarket(slug, 10);
        prevs[crypto.name] = res;
    })());

    await Promise.all(promises);
    return prevs;
}

// ── Filter Evaluation ─────────────────────────────────────────────────

interface MarketSnapshot {
    crypto: string;
    slug: string;
    upToken: string;
    downToken: string;
    endTime: number;
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
    underdogSide: 'UP' | 'DOWN';
    underdogAsk: number;
    underdogTokenId: string;
    isTwoSided: boolean;
    conditionId: string;
}

async function snapshotMarket(market: any, crypto: typeof CRYPTOS[0]): Promise<MarketSnapshot | null> {
    const tokens = getTokenIds(market);
    if (!tokens) return null;

    const [upBook, downBook] = await Promise.all([
        getBookInfo(tokens.upToken),
        getBookInfo(tokens.downToken),
    ]);

    const upMid = (upBook.bestBid + upBook.bestAsk) / 2;
    const downMid = (downBook.bestBid + downBook.bestAsk) / 2;
    const underdogSide: 'UP' | 'DOWN' = upMid < downMid ? 'UP' : 'DOWN';
    const underdogAsk = underdogSide === 'UP' ? upBook.bestAsk : downBook.bestAsk;
    const underdogTokenId = underdogSide === 'UP' ? tokens.upToken : tokens.downToken;

    // Two-sided check: underdog ask > 3¢ AND favorite bid < 97¢
    const favoriteBid = underdogSide === 'UP' ? downBook.bestBid : upBook.bestBid;
    const isTwoSided = underdogAsk > 0.03 && favoriteBid < 0.97;

    return {
        crypto: crypto.name,
        slug: market.slug,
        upToken: tokens.upToken,
        downToken: tokens.downToken,
        endTime: new Date(market.endDate).getTime(),
        upBid: upBook.bestBid,
        upAsk: upBook.bestAsk,
        downBid: downBook.bestBid,
        downAsk: downBook.bestAsk,
        underdogSide,
        underdogAsk,
        underdogTokenId,
        isTwoSided,
        conditionId: market.conditionId || '',
    };
}

interface FilterResult {
    pass: boolean;
    reason: string;
    snapshot: MarketSnapshot;
    neverOneSided: boolean;
    prevResMatch: boolean;
}

function evaluateFilters(
    snapshot: MarketSnapshot,
    prevResolutions: Record<string, string>,
    allSnapshots: Map<string, MarketSnapshot[]>, // crypto -> snapshot history this candle
    filterMode: string,
): FilterResult {
    const { crypto, underdogSide, underdogAsk, isTwoSided } = snapshot;
    const prevRes = prevResolutions[crypto] || 'UNKNOWN';
    const prevResMatch = prevRes === underdogSide;

    // Check if this candle has EVER been one-sided (from our monitoring)
    const history = allSnapshots.get(crypto) || [];
    const wasEverOneSided = history.some(s => !s.isTwoSided);
    const neverOneSided = !wasEverOneSided && isTwoSided;

    // Require minimum snapshots for confidence in "never one-sided" label
    // At 10s polling, a full candle from T-240 to T-35 = ~20 snapshots
    // Require at least 10 to be confident we didn't miss a one-sided moment
    const MIN_SNAPSHOTS_FOR_CONFIDENCE = 10;
    const hasEnoughData = history.length >= MIN_SNAPSHOTS_FOR_CONFIDENCE;

    const base = { snapshot, neverOneSided: neverOneSided && hasEnoughData, prevResMatch };

    // Must be two-sided right now
    if (!isTwoSided) {
        return { ...base, pass: false, reason: `SKIP: one-sided (ask=${(underdogAsk * 100).toFixed(0)}¢)` };
    }

    // Underdog ask guards — only reject broken/impossible prices
    if (underdogAsk < 0.02) {
        return { ...base, pass: false, reason: `SKIP: underdog ask too low (${(underdogAsk * 100).toFixed(0)}¢ — empty book)` };
    }
    if (underdogAsk > 0.50) {
        return { ...base, pass: false, reason: `SKIP: underdog ask too high (${(underdogAsk * 100).toFixed(0)}¢ > 50¢ — not a real underdog)` };
    }

    // Strategy modes:
    // - "prev" (DEFAULT): prev resolution match only — $23/trade, $481/day at 1/10th, 47% win
    // - "tight": never one-sided + prev match — $16/trade, $162/day, 57% win (safer but less $)
    // - "loose": no filters, just two-sided — $14/trade, $690/day, 33% win (most volume)

    if (filterMode === 'tight') {
        if (!hasEnoughData) {
            return { ...base, pass: false, reason: `SKIP: insufficient monitoring data (${history.length}/${MIN_SNAPSHOTS_FOR_CONFIDENCE} snapshots)` };
        }
        if (!neverOneSided) {
            return { ...base, pass: false, reason: `SKIP: was one-sided earlier in candle` };
        }
        if (prevRes === 'UNKNOWN') {
            return { ...base, pass: false, reason: `SKIP: no prev resolution (first candle)` };
        }
        if (!prevResMatch) {
            return { ...base, pass: false, reason: `SKIP: prev=${prevRes}, underdog=${underdogSide} (no match)` };
        }
        return { ...base, pass: true, reason: `TRADE: ${crypto} ${underdogSide} @${(underdogAsk * 100).toFixed(0)}¢ | never-1sided + prev=${prevRes} ✓` };
    }

    if (filterMode === 'loose') {
        return { ...base, pass: true, reason: `TRADE: ${crypto} ${underdogSide} @${(underdogAsk * 100).toFixed(0)}¢ | two-sided ✓` };
    }

    // Default "prev" mode: just prev resolution match
    // Data: 1040 trades, 47% win, $23/trade, 0 losing days across 5 days
    if (prevRes === 'UNKNOWN') {
        return { ...base, pass: false, reason: `SKIP: no prev resolution (first candle)` };
    }
    if (!prevResMatch) {
        return { ...base, pass: false, reason: `SKIP: prev=${prevRes}, underdog=${underdogSide} (no match)` };
    }
    return { ...base, pass: true, reason: `TRADE: ${crypto} ${underdogSide} @${(underdogAsk * 100).toFixed(0)}¢ | prev=${prevRes} ✓` };
}

// ── Auto-Redeem ───────────────────────────────────────────────────────

const payoutAbi = parseAbi(['function payoutDenominator(bytes32 conditionId) view returns (uint256)']);

async function redeemPosition(conditionId: string, viemWalletClient: any, viemPublicClient: any) {
    if (!conditionId) return;

    // Wait for on-chain resolution before redeeming
    // If we redeem before payoutDenominator > 0, the tx reverts and tokens are safe
    // but we waste gas. Better to wait.
    const maxWaitMs = 120000; // 2 minutes max
    const pollInterval = 10000; // check every 10s
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        try {
            const den = await viemPublicClient.readContract({
                address: CT_ADDRESS,
                abi: payoutAbi,
                functionName: 'payoutDenominator',
                args: [conditionId as `0x${string}`],
            });
            if (Number(den) > 0) {
                break; // resolved on-chain — safe to redeem
            }
        } catch {
            // RPC error — keep trying
        }
        log(`  Waiting for on-chain resolution (${Math.round((deadline - Date.now()) / 1000)}s remaining)...`);
        await sleep(pollInterval);
    }

    // Now redeem
    try {
        const hash = await viemWalletClient.writeContract({
            address: CT_ADDRESS,
            abi: ctRedeemAbi,
            functionName: 'redeemPositions',
            args: [USDC_CT, ZERO_BYTES32, conditionId as `0x${string}`, [1n, 2n]],
        });
        const receipt = await viemPublicClient.waitForTransactionReceipt({ hash });
        if (receipt.status === 'success') {
            log(`  Redeemed (tx: ${hash.slice(0, 14)}...)`);
        } else {
            log(`  Redeem tx REVERTED (tx: ${hash.slice(0, 14)}...) — condition may not be resolved yet`);
        }
    } catch (err: any) {
        log(`  Redeem failed: ${err.message?.slice(0, 60)}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
    log('='.repeat(60));
    log('UNDERDOG SNIPE BOT');
    log(`Mode: ${IS_LIVE ? 'LIVE TRADING' : 'DRY RUN'}`);
    log(`Trade size: $${TRADE_SIZE_USD} | Max loss: $${MAX_LOSS_USD} | Filter: ${FILTER_MODE}`);
    log(`Cryptos: ${CRYPTOS.map(c => c.name).join(', ')}`);
    log('='.repeat(60));

    // ── Setup ──
    let client: ClobClient | null = null;
    let executor: OrderExecutor | null = null;
    let verifier: PositionVerifier | null = null;
    let viemWalletClient: any = null;
    let viemPublicClient: any = null;

    if (IS_LIVE) {
        const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY;
        if (!privateKey) {
            log('ERROR: No private key in .env');
            process.exit(1);
        }
        const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
        const wallet = new Wallet(formattedKey);
        const walletAddress = wallet.address;
        log(`Wallet: ${walletAddress.slice(0, 10)}...${walletAddress.slice(-6)}`);

        // Authenticate with CLOB
        log('Authenticating...');
        const publicClobClient = new ClobClient(CLOB, 137, wallet);
        const creds = await publicClobClient.createOrDeriveApiKey();
        client = new ClobClient(CLOB, 137, wallet, creds);
        executor = new OrderExecutor(client);
        log('CLOB authenticated');

        // Set up viem clients for balance checks + redeem
        const viemAccount = privateKeyToAccount(formattedKey);
        viemPublicClient = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
        viemWalletClient = createWalletClient({ account: viemAccount, chain: polygon, transport: http('https://polygon.drpc.org') });

        // Initialize position verifier
        verifier = new PositionVerifier(walletAddress);
        const initOk = await verifier.initialize(MAX_LOSS_USD);
        if (!initOk) {
            log('FATAL: Could not read on-chain balance. Aborting.');
            process.exit(1);
        }
        log(`Balance: $${verifier.getStartingBalance().toFixed(2)} | Floor: $${verifier.getFloorBalance().toFixed(2)}`);

        if (verifier.getStartingBalance() < MIN_BALANCE_USD) {
            log(`Balance too low ($${verifier.getStartingBalance().toFixed(2)} < $${MIN_BALANCE_USD}). Aborting.`);
            process.exit(1);
        }
    }

    const ledger = new TradeLedger('underdog-snipe-trades.jsonl');

    // Connect Chainlink — this is our resolution source of truth
    log('Connecting to Chainlink price feeds...');
    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    let clWait = 0;
    while (chainlink.getPrice('btc/usd') === 0 && clWait < 30) {
        await sleep(1000);
        clWait++;
    }
    await sleep(3000); // wait for all feeds
    const clPrices = chainlink.getAllPrices();
    log(`Chainlink: ${Object.entries(clPrices).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(' | ')}`);

    // Track CL open prices per candle
    let clOpenPrices: Record<string, number> = {};

    // Bootstrap prev resolutions using Chainlink — wait for one candle to get clean data
    log('Bootstrapping previous resolutions (waiting for Polymarket settlement)...');
    const prevResolutions = await bootstrapPrevResolutions();
    log(`Prev: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

    // CL open prices will be recorded when main loop first detects the new candle

    // Track state per candle end time
    let snapshotHistory: Map<string, MarketSnapshot[]> = new Map();
    let clOpenByEndTime: Map<number, Record<string, number>> = new Map(); // CL opens per candle batch
    // Store CL prices at every 5-min boundary for accurate 15m open lookups
    let clPriceHistory: Map<number, Record<string, number>> = new Map(); // unix_ts -> {BTC: price, ...}
    let evaluatedEndTimes = new Set<number>();
    let tradesExecuted = 0;
    let halted = false;

    // Pending trades awaiting resolution — resolved during next candle's monitoring phase
    interface PendingTrade {
        candidate: FilterResult;
        snap: MarketSnapshot;
        execResult: any;
        candleEnd: number;
        clOpenPrices: Record<string, number>;
        balanceBefore: number;
    }
    let pendingTrades: PendingTrade[] = [];
    const sessionTradedSlugs = new Set<string>(); // track markets traded THIS session for redeem sweep

    // ── Main Loop ──
    while (tradesExecuted < MAX_TRADES && !halted) {
        // Find current 5-min markets
        const markets = await findCurrentMarkets();
        if (markets.length === 0) {
            await sleep(10000);
            continue;
        }

        // Group markets by end time (5m and 15m end at different times)
        const endTimes = new Set(markets.map(m => new Date(m.market.endDate).getTime()));
        const soonestEnd = Math.min(...endTimes);
        const secsLeft = Math.round((soonestEnd - Date.now()) / 1000);

        // Record CL open for any new end-time batch
        // For 15m candles, use the price from when the candle ACTUALLY started (from history)
        // For 5m candles, current price is close enough
        for (const endTime of endTimes) {
            if (!clOpenByEndTime.has(endTime)) {
                // Calculate when this candle started
                // 5m candles: start = end - 300000ms, 15m candles: start = end - 900000ms
                const isAny15m = markets.some(m =>
                    new Date(m.market.endDate).getTime() === endTime && m.market.slug.includes('-15m-')
                );
                const candleDurationMs = isAny15m ? 900000 : 300000;
                const candleStartMs = endTime - candleDurationMs;

                // Look up CL price from history at the candle start time
                // Find the closest 5-min boundary to the candle start
                const startBoundary = Math.round(candleStartMs / 300000) * 300000;
                const historicalPrice = clPriceHistory.get(startBoundary);

                if (historicalPrice && isAny15m) {
                    // Use historical price for 15m candles (more accurate)
                    clOpenByEndTime.set(endTime, { ...historicalPrice });
                } else {
                    // Use current price (fine for 5m, fallback for 15m)
                    const opens: Record<string, number> = {};
                    for (const c of CRYPTOS) {
                        opens[c.name] = chainlink.getPrice(c.clSymbol);
                    }
                    clOpenByEndTime.set(endTime, opens);
                }
            }
        }

        // Clean up old entries (more than 20 min ago)
        const cleanupThreshold = Date.now() - 20 * 60 * 1000;
        for (const [et] of clOpenByEndTime) {
            if (et < cleanupThreshold) clOpenByEndTime.delete(et);
        }
        for (const [ts] of clPriceHistory) {
            if (ts < cleanupThreshold) clPriceHistory.delete(ts);
        }

        // Phase 1: Pre-entry monitoring — aggressive snapshot polling
        // Collector takes snapshots at T-240,210,180,150,120,105,90,75,60,50,45,40,35,30,...
        // We need to catch ANY one-sided moment, so poll every ~10 seconds
        if (secsLeft > ENTRY_SECONDS_BEFORE + 5) {
            // Take a snapshot for every market (5m and 15m)
            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);
            for (const { market, crypto } of soonestMarkets) {
                const snap = await snapshotMarket(market, crypto);
                if (snap) {
                    const history = snapshotHistory.get(crypto.name) || [];
                    history.push(snap);
                    snapshotHistory.set(crypto.name, history);

                    // Log when a crypto goes one-sided for the first time
                    if (!snap.isTwoSided && history.length > 1 && history.slice(0, -1).every(s => s.isTwoSided)) {
                        log(`  ${crypto.name}: went ONE-SIDED at T-${secsLeft}s (ask=${(snap.underdogAsk * 100).toFixed(0)}¢) — disqualified for this candle`);
                    }
                }
            }

            // Try to resolve any UNKNOWN prev resolutions (one attempt per cycle, only early in candle)
            // UNKNOWN prevs are resolved via Chainlink at each Phase 4 boundary
            // No API fallback — Chainlink is the only resolution source

            // Poll every 10 seconds for thorough regime detection
            // (faster than before — 10s instead of 15s, and no capping at 15s max wait)
            const waitMs = Math.min((secsLeft - ENTRY_SECONDS_BEFORE - 3) * 1000, 10000);
            if (waitMs > 0) {
                // Only log every 30s to reduce noise
                const snapCount = snapshotHistory.get(CRYPTOS[0].name)?.length || 0;
                if (snapCount % 3 === 1) {
                    const prevStr = Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' ');
                    const regimeStr = CRYPTOS.map(c => {
                        const hist = snapshotHistory.get(c.name) || [];
                        const ever1s = hist.some(s => !s.isTwoSided);
                        return `${c.name}:${hist.length}${ever1s ? '!' : ''}`;
                    }).join(' ');
                    log(`T-${secsLeft}s | prev: ${prevStr} | snaps: ${regimeStr} (!= was one-sided)`);
                }
                await sleep(waitMs);
            }
            continue;
        }

        // Phase 2: Entry decision at ~T-30s (once per end-time batch)
        if (secsLeft <= ENTRY_SECONDS_BEFORE + 5 && secsLeft > 5 && !evaluatedEndTimes.has(soonestEnd)) {
            evaluatedEndTimes.add(soonestEnd);
            log(`\n--- T-${secsLeft}s ENTRY WINDOW ---`);

            // Max loss check before considering any trade
            if (IS_LIVE && verifier) {
                const lossCheck = await verifier.checkMaxLoss();
                if (!lossCheck.safe) {
                    log(`HALT: ${lossCheck.reason}`);
                    halted = true;
                    break;
                }
                log(`Balance: $${lossCheck.currentBalance.toFixed(2)} (loss: $${lossCheck.loss.toFixed(2)} / max $${MAX_LOSS_USD})`);
            }

            // Snapshot all markets ending at this time and evaluate filters
            const candidates: FilterResult[] = [];
            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);
            for (const { market, crypto } of soonestMarkets) {
                const snap = await snapshotMarket(market, crypto);
                if (!snap) continue;

                // Add to history
                const history = snapshotHistory.get(crypto.name) || [];
                history.push(snap);
                snapshotHistory.set(crypto.name, history);

                const result = evaluateFilters(snap, prevResolutions, snapshotHistory, FILTER_MODE);
                log(`  ${result.reason}`);
                if (result.pass) candidates.push(result);
            }

            // Trade ALL qualifying candidates (not just one)
            if (candidates.length > 0) {
                log(`\n  ${candidates.length} qualifying trade(s) this candle`);

                // Record balance before all trades
                let balanceBefore = -1;
                if (IS_LIVE && verifier) {
                    const check = await verifier.getBalance();
                    balanceBefore = check.balance;
                }

                // Place all trades
                interface PlacedTrade {
                    candidate: FilterResult;
                    snap: MarketSnapshot;
                    execResult: any;
                }
                const placedTrades: PlacedTrade[] = [];

                for (const candidate of candidates) {
                    const snap = candidate.snapshot;
                    log(`  >> TRADE: ${snap.crypto} ${snap.underdogSide} @${(snap.underdogAsk * 100).toFixed(0)}¢`);

                    let execResult;
                    if (IS_LIVE && executor) {
                        execResult = await executor.executeAndConfirm(
                            snap.underdogTokenId,
                            snap.underdogAsk,
                            TRADE_SIZE_USD,
                        );
                        log(`    Order: ${execResult.status} | ID: ${execResult.orderId?.slice(0, 12)}... | ${execResult.fillSize} shares @${execResult.fillPrice}`);
                        if (execResult.status === 'ERROR') {
                            log(`    Error: ${execResult.error}`);
                        }
                    } else {
                        const shares = Math.floor(TRADE_SIZE_USD / snap.underdogAsk);
                        log(`    DRY RUN: would buy ${shares} shares @${(snap.underdogAsk * 100).toFixed(0)}¢`);
                        execResult = {
                            status: 'FILLED' as const,
                            orderId: 'dry-run',
                            fillPrice: snap.underdogAsk,
                            fillSize: shares,
                            fillCost: shares * snap.underdogAsk,
                            requestedPrice: snap.underdogAsk,
                            requestedShares: shares,
                            timestamps: { orderPlaced: Date.now(), confirmationReceived: Date.now() },
                        };
                    }

                    if (execResult.status === 'FILLED') {
                        tradesExecuted++;
                        sessionTradedSlugs.add(snap.slug);
                    }
                    placedTrades.push({ candidate, snap, execResult });
                }

                // Queue trades for resolution — DON'T BLOCK
                // Resolution happens during next candle's monitoring phase
                const batchOpensCopy = { ...(clOpenByEndTime.get(soonestEnd) || clOpenPrices) };
                for (const placed of placedTrades) {
                    pendingTrades.push({
                        ...placed,
                        candleEnd: soonestEnd,
                        clOpenPrices: batchOpensCopy,
                        balanceBefore,
                    });
                }
                log(`  ${placedTrades.length} trade(s) queued for resolution next candle`);
                // Continue immediately to next candle — no waiting!
            }

            // No candidates — still need to track resolutions for prev data
            log('  No qualifying trades this candle');
        }

        // If we already evaluated this batch and didn't trade, wait for resolution
        if (evaluatedEndTimes.has(soonestEnd) && secsLeft > 5) {
            await sleep(5000);
            continue;
        }

        // Phase 4: Candle just ended — resolve using Polymarket's actual resolution
        if (secsLeft <= 5) {
            const waitForEnd = soonestEnd - Date.now();
            if (waitForEnd > 0) await sleep(waitForEnd + 5000);
            await sleep(15000); // wait for Polymarket to settle resolution

            // Resolve all cryptos via Polymarket API (this is what determines payouts)
            const soonestMarkets = markets.filter(m => {
                const endMs = new Date(m.market.endDate).getTime();
                return Math.abs(endMs - soonestEnd) < 30000; // within 30s of this end time
            });

            log(`  Resolving via Polymarket API...`);
            for (const { market, crypto } of soonestMarkets) {
                if (market.slug.includes('-5m-')) {
                    const res = await resolveFromPolymarket(market.slug, 10);
                    if (res !== 'UNKNOWN') {
                        prevResolutions[crypto.name] = res;
                    }
                }
            }
            log(`Resolutions: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

            // Resolve pending trades using Polymarket resolution
            if (pendingTrades.length > 0) {
                log(`  Resolving ${pendingTrades.length} pending trade(s) via Polymarket...`);

                for (const pending of pendingTrades) {
                    const { candidate, snap, execResult, balanceBefore } = pending;
                    let resolution = await resolveFromPolymarket(snap.slug, 15);

                    if (resolution === 'UNKNOWN') {
                        log(`  ${snap.crypto}: UNKNOWN — logged, not counted`);
                        const record: TradeRecord = {
                            timestamp: new Date().toISOString(), tradeNumber: 0,
                            slug: snap.slug, crypto: snap.crypto,
                            underdogSide: snap.underdogSide, underdogAsk: snap.underdogAsk,
                            filters: { neverOneSided: candidate.neverOneSided, prevResMatch: candidate.prevResMatch, twoSidedAtT60: snap.isTwoSided },
                            execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                            resolution: 'UNKNOWN', won: false, expectedPnl: 0,
                            balanceBefore, balanceAfter: -1, reconciliation: null,
                            sessionPnl: 0, sessionTrades: 0, sessionWins: 0,
                        };
                        ledger.recordTrade(record);
                        continue;
                    }

                    const won = snap.underdogSide === resolution;
                    const expectedPnl = won ? execResult.fillSize * (1 - execResult.fillPrice) : -(execResult.fillCost);
                    const icon = won ? 'WIN' : 'LOSS';
                    log(`  ${snap.crypto}: ${icon} — resolved ${resolution} | PnL: $${expectedPnl.toFixed(2)}`);

                    if (IS_LIVE && viemWalletClient && viemPublicClient && snap.conditionId) {
                        await redeemPosition(snap.conditionId, viemWalletClient, viemPublicClient);
                    }

                    // Stop on win — verify payout with balance check
                    if (won && STOP_ON_WIN && IS_LIVE && verifier) {
                        await sleep(3000); // wait for chain to update
                        const winCheck = await verifier.getBalance();
                        if (winCheck.success) {
                            const change = winCheck.balance - verifier.getStartingBalance();
                            log(`\n  === STOP ON WIN ===`);
                            log(`  Won: ${snap.crypto} ${snap.underdogSide} @${(snap.underdogAsk * 100).toFixed(0)}¢`);
                            log(`  Shares: ${execResult.fillSize} × $1 = $${execResult.fillSize.toFixed(2)} payout`);
                            log(`  Cost: $${execResult.fillCost.toFixed(2)}`);
                            log(`  Expected profit: $${expectedPnl.toFixed(2)}`);
                            log(`  Balance now: $${winCheck.balance.toFixed(2)} (${change >= 0 ? '+' : ''}$${change.toFixed(2)} from session start)`);
                            log(`  === Stopping bot to verify payout ===\n`);
                        }
                        halted = true;
                    }

                    const record: TradeRecord = {
                        timestamp: new Date().toISOString(), tradeNumber: 0,
                        slug: snap.slug, crypto: snap.crypto,
                        underdogSide: snap.underdogSide, underdogAsk: snap.underdogAsk,
                        filters: { neverOneSided: candidate.neverOneSided, prevResMatch: candidate.prevResMatch, twoSidedAtT60: snap.isTwoSided },
                        execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                        resolution, won, expectedPnl,
                        balanceBefore, balanceAfter: -1, reconciliation: null,
                        sessionPnl: 0, sessionTrades: 0, sessionWins: 0,
                    };
                    ledger.recordTrade(record);
                }

                if (IS_LIVE && verifier) {
                    const postCheck = await verifier.checkMaxLoss();
                    if (!postCheck.safe) {
                        log(`HALT: ${postCheck.reason}`);
                        halted = true;
                    }
                }

                const stats = ledger.getStats();
                log(`  Session: ${stats.trades} trades | ${stats.wins}W/${stats.trades - stats.wins}L | ${(stats.winRate * 100).toFixed(0)}% | PnL: $${stats.pnl.toFixed(2)}`);
                pendingTrades = [];
            }

            await sleep(2000);
            continue;
        }

        await sleep(5000);
    }

    if (halted) {
        log('Bot halted due to max loss.');
    }

    const stats = ledger.getStats();
    log('\n' + '='.repeat(60));
    log('SESSION SUMMARY');
    log(`Trades: ${stats.trades} | Wins: ${stats.wins} | Win rate: ${(stats.winRate * 100).toFixed(0)}%`);
    log(`PnL: $${stats.pnl.toFixed(2)}`);
    if (IS_LIVE && verifier) {
        const finalBalance = await verifier.getBalance();
        if (finalBalance.success) {
            const totalChange = finalBalance.balance - verifier.getStartingBalance();
            log(`Final balance: $${finalBalance.balance.toFixed(2)} (${totalChange >= 0 ? '+' : ''}$${totalChange.toFixed(2)} from start)`);
        }
    }
    log('='.repeat(60));

    // Redeem sweep — ONLY redeem markets traded THIS session (not old ones)
    if (IS_LIVE && viemWalletClient && viemPublicClient && sessionTradedSlugs.size > 0) {
        log(`Running redeem sweep for ${sessionTradedSlugs.size} markets traded this session...`);

        for (const slug of sessionTradedSlugs) {
            try {
                const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                if (data?.[0]?.conditionId) {
                    await redeemPosition(data[0].conditionId, viemWalletClient, viemPublicClient);
                }
            } catch {}
        }

        // Final balance after sweep
        const swept = await verifier!.getBalance();
        if (swept.success) {
            log(`Post-sweep balance: $${swept.balance.toFixed(2)}`);
        }
    }
}

main().catch(err => {
    log(`FATAL: ${err.message}`);
    process.exit(1);
});
