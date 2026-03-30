/**
 * Favorite Snipe Bot — Live Execution
 *
 * Strategy: Buy the FAVORITE at T-30s in 5-min crypto markets when priced 50-65¢.
 * Edge: market systematically underprices the favorite in near-50/50 candles.
 *
 * Portfolio B filters:
 *   - ETH 5m: favorite 55-65¢ (always trade — strongest edge, 71% WR)
 *   - XRP 5m: favorite 55-65¢ (always trade — 66% WR)
 *   - BTC 15m: favorite 50-65¢ (always trade — 85% WR, most consistent)
 *   - BTC 5m: favorite 50-65¢ only when rising + US hours (selective)
 *   - SOL 5m: favorite 50-65¢ only when rising + prev=fav (selective)
 *
 * Validated: 10/10 winning days, 70% WR, $354/day at $50/trade on 10 days
 * of on-chain-verified data (payoutNumerators).
 *
 * Safety: same as underdog bot — on-chain balance verification, max loss halt,
 * order confirmation, append-only trade log.
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/favorite-snipe-bot.ts                     # dry run
 *   npx tsx src/scripts/crypto-5min/favorite-snipe-bot.ts --live              # live $10/trade
 *   npx tsx src/scripts/crypto-5min/favorite-snipe-bot.ts --live --size 50    # live $50/trade
 *   npx tsx src/scripts/crypto-5min/favorite-snipe-bot.ts --live --size 10 --max-loss 40
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
const MAX_LOSS_USD = parseFloat(getArg('--max-loss', '40'));
const MAX_TRADES = parseInt(getArg('--max-trades', '500'));
const STOP_ON_WIN = args.includes('--stop-on-win');

// ── Strategy Config ───────────────────────────────────────────────────

const ENTRY_SECONDS_BEFORE = 30;
const MIN_BALANCE_USD = 3;

const CRYPTOS = [
    { slug: 'btc', clSymbol: 'btc/usd', name: 'BTC' },
    { slug: 'eth', clSymbol: 'eth/usd', name: 'ETH' },
    { slug: 'sol', clSymbol: 'sol/usd', name: 'SOL' },
    { slug: 'xrp', clSymbol: 'xrp/usd', name: 'XRP' },
];

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

// On-chain contracts
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const USDC_CT = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const ZERO_BYTES32 = '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`;
const ctRedeemAbi = parseAbi([
    'function redeemPositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] indexSets)',
]);
const payoutAbi = parseAbi([
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);

// ── Logging ───────────────────────────────────────────────────────────

const log = (...a: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...a);
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-fav-bot)' } });
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

async function findCurrentMarkets(): Promise<Array<{ market: any; crypto: typeof CRYPTOS[0]; interval: number }>> {
    const now = Math.floor(Date.now() / 1000);
    const rounded5 = Math.floor(now / 300) * 300;
    const rounded15 = Math.floor(now / 900) * 900;
    const found: Array<{ market: any; crypto: typeof CRYPTOS[0]; interval: number }> = [];
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
                        found.push({ market: m, crypto, interval: 5 });
                        return;
                    }
                }
            }
        })());

        // 15-minute markets (only BTC — only one with edge)
        if (crypto.slug === 'btc') {
            searches.push((async () => {
                for (const ts of [rounded15, rounded15 + 900]) {
                    const slug = `${crypto.slug}-updown-15m-${ts}`;
                    const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                    if (data && data.length > 0) {
                        const m = data[0];
                        const endDate = new Date(m.endDate).getTime();
                        if (endDate > Date.now() && !seenSlugs.has(m.slug)) {
                            seenSlugs.add(m.slug);
                            found.push({ market: m, crypto, interval: 15 });
                            return;
                        }
                    }
                }
            })());
        }

        return searches;
    });

    await Promise.all(promises);
    return found;
}

// ── Resolution — On-chain truth ──────────────────────────────────────

async function resolveOnChain(slug: string, viemPublicClient: any, retries = 30): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    // Get conditionId from Gamma
    let conditionId: `0x${string}` | null = null;
    let outcomes: string[] = [];

    for (let attempt = 0; attempt < 5; attempt++) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data?.[0]) {
            conditionId = data[0].conditionId as `0x${string}`;
            outcomes = JSON.parse(data[0].outcomes || '[]');
            break;
        }
        await sleep(2000);
    }

    if (!conditionId || outcomes.length === 0) return 'UNKNOWN';

    // Poll on-chain payoutNumerators
    for (let i = 0; i < retries; i++) {
        try {
            const den = await viemPublicClient.readContract({
                address: CT_ADDRESS, abi: payoutAbi,
                functionName: 'payoutDenominator', args: [conditionId],
            });
            if (Number(den) > 0) {
                for (let oi = 0; oi < outcomes.length; oi++) {
                    const pn = await viemPublicClient.readContract({
                        address: CT_ADDRESS, abi: payoutAbi,
                        functionName: 'payoutNumerators', args: [conditionId, BigInt(oi)],
                    });
                    if (pn > 0n) return outcomes[oi].toUpperCase() as 'UP' | 'DOWN';
                }
                return 'UNKNOWN';
            }
        } catch { /* not resolved yet */ }
        if (i < retries - 1) await sleep(4000);
    }
    return 'UNKNOWN';
}

async function bootstrapPrevResolutions(viemPublicClient: any): Promise<Record<string, 'UP' | 'DOWN' | 'UNKNOWN'>> {
    const prevs: Record<string, 'UP' | 'DOWN' | 'UNKNOWN'> = {};

    // Wait for current candle to end
    const now = Math.floor(Date.now() / 1000);
    const nextBoundary = (Math.floor(now / 300) + 1) * 300;
    const waitSecs = nextBoundary - now;
    log(`  Waiting ${waitSecs}s for current candle to end (bootstrap)...`);
    await sleep(waitSecs * 1000 + 30000); // +30s for on-chain resolution

    const rounded5 = Math.floor(Date.now() / 1000 / 300) * 300;
    const prevCandleStart = rounded5 - 300;

    const promises = CRYPTOS.map((crypto) => (async () => {
        const slug = `${crypto.slug}-updown-5m-${prevCandleStart}`;
        const res = await resolveOnChain(slug, viemPublicClient, 15);
        prevs[crypto.name] = res;
    })());

    await Promise.all(promises);
    return prevs;
}

// ── Market Snapshot ──────────────────────────────────────────────────

interface MarketSnapshot {
    crypto: string;
    slug: string;
    interval: number;
    upToken: string;
    downToken: string;
    endTime: number;
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
    favoriteSide: 'UP' | 'DOWN';
    favoriteAsk: number;
    favoriteTokenId: string;
    favoriteMid: number;
    isTwoSided: boolean;
    conditionId: string;
}

async function snapshotMarket(market: any, crypto: typeof CRYPTOS[0], interval: number): Promise<MarketSnapshot | null> {
    const tokens = getTokenIds(market);
    if (!tokens) return null;

    const [upBook, downBook] = await Promise.all([
        getBookInfo(tokens.upToken),
        getBookInfo(tokens.downToken),
    ]);

    const upMid = (upBook.bestBid + upBook.bestAsk) / 2;
    const downMid = (downBook.bestBid + downBook.bestAsk) / 2;
    const favoriteSide: 'UP' | 'DOWN' = upMid > downMid ? 'UP' : 'DOWN';
    const favoriteAsk = favoriteSide === 'UP' ? upBook.bestAsk : downBook.bestAsk;
    const favoriteTokenId = favoriteSide === 'UP' ? tokens.upToken : tokens.downToken;
    const favoriteMid = favoriteSide === 'UP' ? upMid : downMid;

    const underdogAsk = favoriteSide === 'UP' ? downBook.bestAsk : upBook.bestAsk;
    const isTwoSided = underdogAsk > 0.03 && favoriteAsk < 0.97 && favoriteAsk > 0.03;

    return {
        crypto: crypto.name,
        slug: market.slug,
        interval,
        upToken: tokens.upToken,
        downToken: tokens.downToken,
        endTime: new Date(market.endDate).getTime(),
        upBid: upBook.bestBid,
        upAsk: upBook.bestAsk,
        downBid: downBook.bestBid,
        downAsk: downBook.bestAsk,
        favoriteSide,
        favoriteAsk,
        favoriteTokenId,
        favoriteMid,
        isTwoSided,
        conditionId: market.conditionId || '',
    };
}

// ── Portfolio B Filter ───────────────────────────────────────────────

interface FilterResult {
    pass: boolean;
    reason: string;
    snapshot: MarketSnapshot;
}

function evaluatePortfolioB(
    snapshot: MarketSnapshot,
    prevResolutions: Record<string, string>,
    earlySnapshot: MarketSnapshot | null, // T-120 snapshot for drift
): FilterResult {
    const { crypto, interval, favoriteSide, favoriteAsk, isTwoSided } = snapshot;
    const base = { snapshot };

    if (!isTwoSided) {
        return { ...base, pass: false, reason: `SKIP ${crypto}: one-sided` };
    }

    // Price must be in the sweet spot (50-65¢)
    if (favoriteAsk < 0.50 || favoriteAsk >= 0.65) {
        return { ...base, pass: false, reason: `SKIP ${crypto} ${interval}m: fav @${(favoriteAsk * 100).toFixed(0)}¢ (outside 50-65¢)` };
    }

    // Calculate drift if we have early snapshot
    const drift = earlySnapshot ? snapshot.favoriteMid - earlySnapshot.favoriteMid : 0;
    const rising = drift > 0.02;
    const prevRes = prevResolutions[crypto] || 'UNKNOWN';
    const prevMatchesFav = prevRes === favoriteSide;
    const hourUTC = new Date().getUTCHours();
    const usHours = hourUTC >= 16 && hourUTC < 24;

    // ── Portfolio B Rules ──

    // ETH 5m: always trade at 55-65¢ (strongest edge: 71% WR)
    if (crypto === 'ETH' && interval === 5 && favoriteAsk >= 0.55) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 5m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [ETH always-on]` };
    }

    // ETH 5m: 50-55¢ also positive but weaker — still include in Portfolio B
    if (crypto === 'ETH' && interval === 5 && favoriteAsk >= 0.50) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 5m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [ETH 50-55¢]` };
    }

    // XRP 5m: always trade at 55-65¢ (66% WR)
    if (crypto === 'XRP' && interval === 5 && favoriteAsk >= 0.55) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 5m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [XRP always-on]` };
    }

    // BTC 15m: always trade at 50-65¢ (85% WR, 10/10 days)
    if (crypto === 'BTC' && interval === 15) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 15m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [BTC 15m always-on]` };
    }

    // BTC 5m: only when rising + US hours (71% WR with filters)
    if (crypto === 'BTC' && interval === 5 && rising && usHours) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 5m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [BTC rising+US] drift=${(drift * 100).toFixed(1)}¢` };
    }

    // SOL 5m: only when rising + prev matches favorite (70% WR with filters)
    if (crypto === 'SOL' && interval === 5 && rising && prevMatchesFav) {
        return { ...base, pass: true, reason: `TRADE ${crypto} 5m: fav ${favoriteSide} @${(favoriteAsk * 100).toFixed(0)}¢ [SOL rising+prev=${prevRes}] drift=${(drift * 100).toFixed(1)}¢` };
    }

    // Default: skip
    const skipReason = [];
    if (crypto === 'BTC' && interval === 5) {
        if (!rising) skipReason.push('not rising');
        if (!usHours) skipReason.push(`hour=${hourUTC} not US`);
    } else if (crypto === 'SOL') {
        if (!rising) skipReason.push('not rising');
        if (!prevMatchesFav) skipReason.push(`prev=${prevRes}≠fav=${favoriteSide}`);
    } else if (crypto === 'XRP' && favoriteAsk < 0.55) {
        skipReason.push(`ask ${(favoriteAsk*100).toFixed(0)}¢ < 55¢`);
    }

    return { ...base, pass: false, reason: `SKIP ${crypto} ${interval}m: fav @${(favoriteAsk * 100).toFixed(0)}¢ (${skipReason.join(', ') || 'no rule matched'})` };
}

// ── Auto-Redeem ───────────────────────────────────────────────────────

async function redeemPosition(conditionId: string, viemWalletClient: any, viemPublicClient: any) {
    if (!conditionId) return;

    const maxWaitMs = 120000;
    const pollInterval = 10000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        try {
            const den = await viemPublicClient.readContract({
                address: CT_ADDRESS, abi: payoutAbi,
                functionName: 'payoutDenominator',
                args: [conditionId as `0x${string}`],
            });
            if (Number(den) > 0) break;
        } catch { /* keep trying */ }
        log(`  Waiting for on-chain resolution (${Math.round((deadline - Date.now()) / 1000)}s remaining)...`);
        await sleep(pollInterval);
    }

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
            log(`  Redeem tx REVERTED (tx: ${hash.slice(0, 14)}...)`);
        }
    } catch (err: any) {
        log(`  Redeem failed: ${err.message?.slice(0, 60)}`);
    }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
    log('='.repeat(60));
    log('FAVORITE SNIPE BOT — Portfolio B');
    log(`Mode: ${IS_LIVE ? '🔴 LIVE TRADING' : '⚪ DRY RUN'}`);
    log(`Trade size: $${TRADE_SIZE_USD} | Max loss: $${MAX_LOSS_USD}`);
    log(`Strategy: Buy favorite 50-65¢ | ETH+XRP always, BTC 15m always, BTC 5m+SOL filtered`);
    log('='.repeat(60));

    // ── Setup ──
    let client: ClobClient | null = null;
    let executor: OrderExecutor | null = null;
    let verifier: PositionVerifier | null = null;
    let viemWalletClient: any = null;
    let viemPublicClient: any = null;

    // Always need viemPublicClient for on-chain resolution
    viemPublicClient = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

    if (IS_LIVE) {
        const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY;
        if (!privateKey) { log('ERROR: No private key in .env'); process.exit(1); }
        const formattedKey = (privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`) as `0x${string}`;
        const wallet = new Wallet(formattedKey);
        log(`Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`);

        log('Authenticating...');
        const publicClobClient = new ClobClient(CLOB, 137, wallet);
        const creds = await publicClobClient.createOrDeriveApiKey();
        client = new ClobClient(CLOB, 137, wallet, creds);
        executor = new OrderExecutor(client);
        log('CLOB authenticated');

        const viemAccount = privateKeyToAccount(formattedKey);
        viemWalletClient = createWalletClient({ account: viemAccount, chain: polygon, transport: http('https://polygon.drpc.org') });

        verifier = new PositionVerifier(wallet.address);
        const initOk = await verifier.initialize(MAX_LOSS_USD);
        if (!initOk) { log('FATAL: Could not read balance. Aborting.'); process.exit(1); }
        log(`Balance: $${verifier.getStartingBalance().toFixed(2)} | Floor: $${verifier.getFloorBalance().toFixed(2)}`);

        if (verifier.getStartingBalance() < MIN_BALANCE_USD) {
            log(`Balance too low. Aborting.`); process.exit(1);
        }
    }

    const ledger = new TradeLedger('favorite-snipe-trades.jsonl');

    // Bootstrap prev resolutions via on-chain
    log('Bootstrapping previous resolutions (on-chain)...');
    const prevResolutions = await bootstrapPrevResolutions(viemPublicClient);
    log(`Prev: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

    // Track early snapshots for drift calculation
    let earlySnapshots: Map<string, MarketSnapshot> = new Map(); // crypto+interval -> first snapshot
    let evaluatedEndTimes = new Set<number>();
    let tradesExecuted = 0;
    let halted = false;
    const sessionTradedSlugs = new Set<string>();

    interface PendingTrade {
        candidate: FilterResult;
        snap: MarketSnapshot;
        execResult: any;
        candleEnd: number;
        balanceBefore: number;
    }
    let pendingTrades: PendingTrade[] = [];

    // ── Main Loop ──
    while (tradesExecuted < MAX_TRADES && !halted) {
        const markets = await findCurrentMarkets();
        if (markets.length === 0) { await sleep(10000); continue; }

        const endTimes = new Set(markets.map(m => new Date(m.market.endDate).getTime()));
        const soonestEnd = Math.min(...endTimes);
        const secsLeft = Math.round((soonestEnd - Date.now()) / 1000);

        // Phase 1: Monitoring — capture early snapshots for drift
        if (secsLeft > ENTRY_SECONDS_BEFORE + 5) {
            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);
            for (const { market, crypto, interval } of soonestMarkets) {
                const key = `${crypto.name}-${interval}`;
                // Capture first snapshot around T-120 for drift baseline
                if (!earlySnapshots.has(key) && secsLeft >= 100 && secsLeft <= 140) {
                    const snap = await snapshotMarket(market, crypto, interval);
                    if (snap) {
                        earlySnapshots.set(key, snap);
                    }
                }
            }

            // Log every 30s
            if (secsLeft % 30 < 12) {
                const driftStr = [...earlySnapshots.entries()].map(([k, s]) =>
                    `${k}:${s.favoriteSide}@${(s.favoriteMid * 100).toFixed(0)}¢`
                ).join(' ');
                log(`T-${secsLeft}s | prev: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' ')} | early: ${driftStr || 'waiting'}`);
            }

            await sleep(Math.min((secsLeft - ENTRY_SECONDS_BEFORE - 3) * 1000, 10000));
            continue;
        }

        // Phase 2: Entry at ~T-30s
        if (secsLeft <= ENTRY_SECONDS_BEFORE + 5 && secsLeft > 5 && !evaluatedEndTimes.has(soonestEnd)) {
            evaluatedEndTimes.add(soonestEnd);
            log(`\n--- T-${secsLeft}s ENTRY WINDOW ---`);

            if (IS_LIVE && verifier) {
                const lossCheck = await verifier.checkMaxLoss();
                if (!lossCheck.safe) { log(`HALT: ${lossCheck.reason}`); halted = true; break; }
                log(`Balance: $${lossCheck.currentBalance.toFixed(2)} (loss: $${lossCheck.loss.toFixed(2)} / max $${MAX_LOSS_USD})`);
            }

            const candidates: FilterResult[] = [];
            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);

            for (const { market, crypto, interval } of soonestMarkets) {
                const snap = await snapshotMarket(market, crypto, interval);
                if (!snap) continue;

                const key = `${crypto.name}-${interval}`;
                const early = earlySnapshots.get(key) || null;
                const result = evaluatePortfolioB(snap, prevResolutions, early);
                log(`  ${result.reason}`);
                if (result.pass) candidates.push(result);
            }

            if (candidates.length > 0) {
                log(`\n  ${candidates.length} qualifying trade(s)`);

                let balanceBefore = -1;
                if (IS_LIVE && verifier) {
                    const check = await verifier.getBalance();
                    balanceBefore = check.balance;
                }

                for (const candidate of candidates) {
                    const snap = candidate.snapshot;
                    log(`  >> BUY FAV: ${snap.crypto} ${snap.interval}m ${snap.favoriteSide} @${(snap.favoriteAsk * 100).toFixed(0)}¢`);

                    let execResult;
                    if (IS_LIVE && executor) {
                        execResult = await executor.executeAndConfirm(
                            snap.favoriteTokenId,
                            snap.favoriteAsk,
                            TRADE_SIZE_USD,
                        );
                        log(`    Order: ${execResult.status} | ${execResult.fillSize} shares @${execResult.fillPrice}`);
                        if (execResult.status === 'ERROR') log(`    Error: ${execResult.error}`);
                    } else {
                        const shares = Math.floor(TRADE_SIZE_USD / snap.favoriteAsk);
                        log(`    DRY RUN: would buy ${shares} shares of ${snap.favoriteSide} @${(snap.favoriteAsk * 100).toFixed(0)}¢ ($${(shares * snap.favoriteAsk).toFixed(2)})`);
                        execResult = {
                            status: 'FILLED' as const,
                            orderId: 'dry-run',
                            fillPrice: snap.favoriteAsk,
                            fillSize: shares,
                            fillCost: shares * snap.favoriteAsk,
                            requestedPrice: snap.favoriteAsk,
                            requestedShares: shares,
                            timestamps: { orderPlaced: Date.now(), confirmationReceived: Date.now() },
                        };
                    }

                    if (execResult.status === 'FILLED') {
                        tradesExecuted++;
                        sessionTradedSlugs.add(snap.slug);
                    }

                    pendingTrades.push({ candidate, snap, execResult, candleEnd: soonestEnd, balanceBefore });
                }
                log(`  ${candidates.length} trade(s) queued for resolution`);
            } else {
                log('  No qualifying trades this candle');
            }
        }

        // Wait phase
        if (evaluatedEndTimes.has(soonestEnd) && secsLeft > 5) {
            await sleep(5000);
            continue;
        }

        // Phase 4: Resolution — on-chain truth
        if (secsLeft <= 5) {
            const waitForEnd = soonestEnd - Date.now();
            if (waitForEnd > 0) await sleep(waitForEnd + 5000);
            await sleep(30000); // wait for on-chain resolution

            // Resolve via on-chain for prev tracking
            const soonestMarkets = markets.filter(m => {
                const endMs = new Date(m.market.endDate).getTime();
                return Math.abs(endMs - soonestEnd) < 30000;
            });

            log(`  Resolving via on-chain payoutNumerators...`);
            for (const { market, crypto } of soonestMarkets) {
                if (market.slug.includes('-5m-')) {
                    const res = await resolveOnChain(market.slug, viemPublicClient, 15);
                    if (res !== 'UNKNOWN') {
                        prevResolutions[crypto.name] = res;
                    }
                }
            }
            log(`Resolutions: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

            // Resolve pending trades
            if (pendingTrades.length > 0) {
                log(`  Resolving ${pendingTrades.length} pending trade(s)...`);

                for (const pending of pendingTrades) {
                    const { candidate, snap, execResult, balanceBefore } = pending;
                    const resolution = await resolveOnChain(snap.slug, viemPublicClient, 20);

                    if (resolution === 'UNKNOWN') {
                        log(`  ${snap.crypto} ${snap.interval}m: UNKNOWN — logged, not counted`);
                        const record: TradeRecord = {
                            timestamp: new Date().toISOString(), tradeNumber: 0,
                            slug: snap.slug, crypto: snap.crypto,
                            underdogSide: snap.favoriteSide, underdogAsk: snap.favoriteAsk,
                            filters: { neverOneSided: true, prevResMatch: true, twoSidedAtT60: true },
                            execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                            resolution: 'UNKNOWN', won: false, expectedPnl: 0,
                            balanceBefore, balanceAfter: -1, reconciliation: null,
                            sessionPnl: 0, sessionTrades: 0, sessionWins: 0,
                        };
                        ledger.recordTrade(record);
                        continue;
                    }

                    const won = snap.favoriteSide === resolution;
                    const expectedPnl = won ? execResult.fillSize * (1 - execResult.fillPrice) : -(execResult.fillCost);
                    log(`  ${snap.crypto} ${snap.interval}m: ${won ? 'WIN' : 'LOSS'} — resolved ${resolution}, bought ${snap.favoriteSide} @${(snap.favoriteAsk * 100).toFixed(0)}¢ | PnL: $${expectedPnl.toFixed(2)}`);

                    if (IS_LIVE && viemWalletClient && snap.conditionId) {
                        await redeemPosition(snap.conditionId, viemWalletClient, viemPublicClient);
                    }

                    if (won && STOP_ON_WIN && IS_LIVE && verifier) {
                        await sleep(3000);
                        const winCheck = await verifier.getBalance();
                        if (winCheck.success) {
                            log(`\n  === STOP ON WIN ===`);
                            log(`  Won: ${snap.crypto} ${snap.interval}m ${snap.favoriteSide} @${(snap.favoriteAsk * 100).toFixed(0)}¢`);
                            log(`  Balance: $${winCheck.balance.toFixed(2)}`);
                            log(`  === Stopping bot ===\n`);
                        }
                        halted = true;
                    }

                    const record: TradeRecord = {
                        timestamp: new Date().toISOString(), tradeNumber: 0,
                        slug: snap.slug, crypto: snap.crypto,
                        underdogSide: snap.favoriteSide, underdogAsk: snap.favoriteAsk,
                        filters: { neverOneSided: true, prevResMatch: true, twoSidedAtT60: true },
                        execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                        resolution, won, expectedPnl,
                        balanceBefore, balanceAfter: -1, reconciliation: null,
                        sessionPnl: 0, sessionTrades: 0, sessionWins: 0,
                    };
                    ledger.recordTrade(record);
                }

                if (IS_LIVE && verifier) {
                    const postCheck = await verifier.checkMaxLoss();
                    if (!postCheck.safe) { log(`HALT: ${postCheck.reason}`); halted = true; }
                }

                const stats = ledger.getStats();
                log(`  Session: ${stats.trades}T | ${stats.wins}W/${stats.trades - stats.wins}L | ${(stats.winRate * 100).toFixed(0)}% | PnL: $${stats.pnl.toFixed(2)}`);
                pendingTrades = [];
            }

            // Reset for next candle
            earlySnapshots.clear();
            await sleep(2000);
            continue;
        }

        await sleep(5000);
    }

    // ── Session Summary ──
    const stats = ledger.getStats();
    log('\n' + '='.repeat(60));
    log('SESSION SUMMARY — FAVORITE SNIPE BOT');
    log(`Trades: ${stats.trades} | Wins: ${stats.wins} | WR: ${(stats.winRate * 100).toFixed(0)}%`);
    log(`PnL: $${stats.pnl.toFixed(2)}`);
    if (IS_LIVE && verifier) {
        const finalBalance = await verifier.getBalance();
        if (finalBalance.success) {
            const change = finalBalance.balance - verifier.getStartingBalance();
            log(`Final balance: $${finalBalance.balance.toFixed(2)} (${change >= 0 ? '+' : ''}$${change.toFixed(2)})`);
        }
    }
    log('='.repeat(60));

    // Redeem sweep
    if (IS_LIVE && viemWalletClient && viemPublicClient && sessionTradedSlugs.size > 0) {
        log(`Redeem sweep: ${sessionTradedSlugs.size} markets...`);
        for (const slug of sessionTradedSlugs) {
            try {
                const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
                if (data?.[0]?.conditionId) {
                    await redeemPosition(data[0].conditionId, viemWalletClient, viemPublicClient);
                }
            } catch {}
        }
        const swept = await verifier!.getBalance();
        if (swept.success) log(`Post-sweep balance: $${swept.balance.toFixed(2)}`);
    }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
