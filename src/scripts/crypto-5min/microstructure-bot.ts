/**
 * Microstructure Bot v4 — 9-Signal System
 *
 * Base filter: rising + 54-59¢/65-74¢ + two-sided (60-64¢ excluded)
 *
 * 9 signals (5 original + 4 math-derived):
 *   1. flip60:       leader changed between T-60 and T-30
 *   2. odd_flips:    leader at T-60 != leader at T-120
 *   3. US_eve:       18:00-02:00 UTC
 *   4. cross>=2:     2+ other cryptos' prev resolution matches current leader
 *   5. weekend:      Saturday or Sunday
 *   6. sweet_zone:   price in 55-60¢ or 68-75¢ (calibration edge zones)
 *   7. accelerating: price acceleration positive (2nd derivative > 2¢)
 *   8. depth>=2:     leader bid depth / ask depth >= 2.0 (strong support)
 *   9. late_flip:    leader at T-240 was different side (late momentum shift)
 *
 * Mechanics:
 *   - HOLD all trades to resolution (no stops — stops cut winners more than they save)
 *   - Stop levels logged as informational only (what stop WOULD have done)
 *   - Maker-first execution: bid+1¢, 12s; taker fallback: ask, 10s
 *   - Signal count logged per trade for position sizing analysis
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/microstructure-bot.ts                  # dry run
 *   npx tsx src/scripts/crypto-5min/microstructure-bot.ts --live           # live $10/trade
 *   npx tsx src/scripts/crypto-5min/microstructure-bot.ts --live --size 50 --max-loss 40
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

import { PositionVerifier } from '../../core/execution/position-verifier.js';
import { OrderExecutor, type FallbackResult } from '../../core/execution/order-executor.js';
import { TradeLedger, type TradeRecord } from '../../core/execution/trade-ledger.js';
import { ChainlinkFeed } from './chainlink-feed.js';

// ── CLI Args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const IS_LIVE = args.includes('--live');
const STOP_LOSS_CENTS = 5; // exit if leader bid drops this many cents below entry ask

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const TRADE_SIZE_USD = parseFloat(getArg('--size', '10'));
const MAX_LOSS_USD = parseFloat(getArg('--max-loss', '40'));
const TRAIL_USD = parseFloat(getArg('--trail', '25'));
const SWEEP_STEP_USD = parseFloat(getArg('--sweep-step', '20'));
const MAX_TRADES = parseInt(getArg('--max-trades', '500'));

// ── Constants ─────────────────────────────────────────────────────────

const ENTRY_SECONDS_BEFORE = 30;
const MIN_BALANCE_USD = 3;

const CRYPTOS = [
    { slug: 'btc', clSymbol: 'btc/usd' as const, name: 'BTC' },
    { slug: 'eth', clSymbol: 'eth/usd' as const, name: 'ETH' },
    { slug: 'sol', clSymbol: 'sol/usd' as const, name: 'SOL' },
    { slug: 'xrp', clSymbol: 'xrp/usd' as const, name: 'XRP' },
];

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

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
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-micro-bot)' } });
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
    if (!raw) return { bestBid: 0, bestAsk: 1, bestAskSize: 0, totalAskDepth: 0, totalBidDepth: 0 };
    const bids = (raw.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .filter((b: any) => Number.isFinite(b.price) && b.size > 0)
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .filter((a: any) => Number.isFinite(a.price) && a.size > 0)
        .sort((a: any, b: any) => a.price - b.price);
    return {
        bestBid: bids[0]?.price ?? 0,
        bestAsk: asks[0]?.price ?? 1,
        bestAskSize: asks[0]?.size ?? 0,
        totalAskDepth: asks.reduce((s: number, a: any) => s + a.size, 0),
        totalBidDepth: bids.reduce((s: number, b: any) => s + b.size, 0),
    };
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
        return searches;
    });

    await Promise.all(promises);
    return found;
}

// ── On-chain Resolution ──────────────────────────────────────────────

async function resolveOnChain(slug: string, viemPublicClient: any, retries = 30): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
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

// ── Market Snapshot ──────────────────────────────────────────────────

interface BookSnapshot {
    upBid: number;
    downBid: number;
    upAsk: number;
    downAsk: number;
    upAskDepth: number;
    downAskDepth: number;
    upBidDepth: number;
    downBidDepth: number;
    upAskSize: number;
    downAskSize: number;
    upToken: string;
    downToken: string;
    leader: 'UP' | 'DOWN' | 'TIE';
    timestamp: number;
}

async function takeBookSnapshot(market: any): Promise<BookSnapshot | null> {
    const tokens = getTokenIds(market);
    if (!tokens) return null;

    const [upBook, downBook] = await Promise.all([
        getBookInfo(tokens.upToken),
        getBookInfo(tokens.downToken),
    ]);

    const leader: 'UP' | 'DOWN' | 'TIE' =
        upBook.bestBid > downBook.bestBid ? 'UP' :
        downBook.bestBid > upBook.bestBid ? 'DOWN' : 'TIE';

    return {
        upBid: upBook.bestBid,
        downBid: downBook.bestBid,
        upAsk: upBook.bestAsk,
        downAsk: downBook.bestAsk,
        upAskDepth: upBook.totalAskDepth,
        downAskDepth: downBook.totalAskDepth,
        upBidDepth: upBook.totalBidDepth,
        downBidDepth: downBook.totalBidDepth,
        upAskSize: upBook.bestAskSize,
        downAskSize: downBook.bestAskSize,
        upToken: tokens.upToken,
        downToken: tokens.downToken,
        leader,
        timestamp: Date.now(),
    };
}

// ── Entry Signals ───────────────────────────────────────────────────

interface EntrySignals {
    leaderSide: 'UP' | 'DOWN';
    leaderBid: number;
    leaderAsk: number;
    leaderTokenId: string;
    leaderAskSize: number;
    leaderAskDepth: number;
    prevMatchesFav: boolean;      // previous candle resolved same direction as leader
    leaderRising: boolean | null; // leader's bid at T-30 > at T-120
    // v3 signals
    flip60: boolean;              // leader at T-60 != leader at T-30 (momentum flip)
    isUSEve: boolean;             // 18:00-02:00 UTC
    isWeekend: boolean;           // Saturday or Sunday
    crossSame: number;            // how many other cryptos' prev resolution matches leader
    // v4 math signals
    sweetZone: boolean;           // price in 55-60¢ or 68-75¢ (calibration edge zones)
    accelerating: boolean;        // final move > mid move (2nd derivative of price)
    strongDepth: boolean;         // leader bid depth / ask depth >= 2.0
    lateFlip: boolean;            // leader changed since T-240
    signalCount: number;          // how many of the 9 signals fire
    accounts: string[];           // which signals fired
    action: 'TRADE' | 'SKIP';
    reason: string;
}

function computeSignals(
    snapT30: BookSnapshot,
    snapT60: BookSnapshot | null,
    snapT120: BookSnapshot | null,
    snapT240: BookSnapshot | null,
    prevResolution: 'UP' | 'DOWN' | 'UNKNOWN' | '',
    prevResolutions: Record<string, 'UP' | 'DOWN' | 'UNKNOWN'>,
    crypto: string,
    interval: number,
): EntrySignals {
    const leaderSide = snapT30.leader as 'UP' | 'DOWN';
    const leaderBid = leaderSide === 'UP' ? snapT30.upBid : snapT30.downBid;
    const leaderAsk = leaderSide === 'UP' ? snapT30.upAsk : snapT30.downAsk;
    const leaderTokenId = leaderSide === 'UP' ? snapT30.upToken : snapT30.downToken;
    const leaderAskSize = leaderSide === 'UP' ? snapT30.upAskSize : snapT30.downAskSize;
    const leaderAskDepth = leaderSide === 'UP' ? snapT30.upAskDepth : snapT30.downAskDepth;

    // Core signal: previous candle resolved same direction as current leader
    const prevMatchesFav = prevResolution === leaderSide;

    // Momentum: is the T-30 leader's bid higher than at T-120?
    let leaderRising: boolean | null = null;
    if (snapT120) {
        const leaderBidT120 = leaderSide === 'UP' ? snapT120.upBid : snapT120.downBid;
        if (leaderBidT120 > 0) {
            leaderRising = leaderBid > leaderBidT120;
        }
    }

    // v3 signal: flip60 — leader changed between T-60 and T-30
    const flip60 = snapT60 !== null && snapT60.leader !== 'TIE' && snapT60.leader !== leaderSide;

    // v3 signal: US evening (18:00-02:00 UTC)
    const hourUTC = new Date().getUTCHours();
    const isUSEve = hourUTC >= 18 || hourUTC < 2;

    // v3 signal: weekend
    const dow = new Date().getUTCDay(); // 0=Sun, 6=Sat
    const isWeekend = dow === 0 || dow === 6;

    // v3 signal: cross-crypto — how many other cryptos' prev resolution matches current leader
    let crossSame = 0;
    for (const [c, res] of Object.entries(prevResolutions)) {
        if (c !== crypto && res === leaderSide) crossSame++;
    }

    // v4 math signal: sweet_zone — price in calibration edge zones (55-60¢ or 68-75¢)
    const sweetZone = (leaderAsk >= 0.55 && leaderAsk < 0.60) || (leaderAsk >= 0.68 && leaderAsk <= 0.75);

    // v4 math signal: accelerating — final move (T-60→T-30) > mid move (T-120→T-60)
    let accelerating = false;
    if (snapT60 && snapT120) {
        const leaderBidT60 = leaderSide === 'UP' ? snapT60.upBid : snapT60.downBid;
        const leaderBidT120 = leaderSide === 'UP' ? snapT120.upBid : snapT120.downBid;
        const midMove = leaderBidT60 - leaderBidT120;
        const finalMove = leaderBid - leaderBidT60;
        accelerating = (finalMove - midMove) > 0.02;
    }

    // v4 math signal: strong_depth — leader bid depth / ask depth >= 2.0
    const leaderBidDepth = leaderSide === 'UP' ? snapT30.upBidDepth : snapT30.downBidDepth;
    const strongDepth = leaderAskDepth > 0 && (leaderBidDepth / leaderAskDepth) >= 2.0;

    // v4 math signal: late_flip — leader at T-240 was different from leader at T-30
    let lateFlip = false;
    if (snapT240 && snapT240.leader !== 'TIE') {
        lateFlip = snapT240.leader !== leaderSide;
    }

    // Count all signals (9 total)
    const accounts: string[] = [];
    if (flip60) accounts.push('flip60');
    if (snapT60 && snapT120 && snapT60.leader !== snapT120.leader) accounts.push('odd_flips');
    if (isUSEve) accounts.push('US_eve');
    if (crossSame >= 2) accounts.push('cross>=2');
    if (isWeekend) accounts.push('weekend');
    if (sweetZone) accounts.push('sweet_zone');
    if (accelerating) accounts.push('accelerating');
    if (strongDepth) accounts.push('depth>=2');
    if (lateFlip) accounts.push('late_flip');
    const signalCount = accounts.length;

    let action: 'TRADE' | 'SKIP' = 'SKIP';
    let reason = '';

    // Two-sided check
    const followerBid = leaderSide === 'UP' ? snapT30.downBid : snapT30.upBid;
    const isTwoSided = followerBid >= 0.05 && leaderAsk < 0.97 && leaderAsk > 0.03;

    const isWeakMiddleZone = leaderAsk >= 0.60 && leaderAsk < 0.65;

    // Time-of-day filter: skip hours where the 9-signal filter has no edge or is net-negative
    //   - 12-14 UTC (8-10am ET): 64.6% WR at 64.5¢ → breakeven; -$0.11/tr over 79 sim trades
    //   - 18-20 UTC (2-4pm ET): 58.8% WR at 64.6¢ → 5.9pp below breakeven; -$0.92/tr over 80 sim trades
    // Both buckets are tracked in monitoring; revisit if 2+ weeks of fresh data shows them flipping positive.
    const nowUtcHour = new Date().getUTCHours();
    const isDeadHour = (nowUtcHour >= 12 && nowUtcHour < 15) || (nowUtcHour >= 18 && nowUtcHour < 21);

    if (!isTwoSided) {
        reason = `one-sided`;
    } else if (leaderAsk < 0.54 || leaderAsk >= 0.75) {
        reason = `price ${(leaderAsk * 100).toFixed(0)}¢ outside 54-75¢`;
    } else if (isWeakMiddleZone) {
        reason = `price ${(leaderAsk * 100).toFixed(0)}¢ in excluded 60-64¢ bucket`;
    } else if (isDeadHour) {
        reason = `dead hour ${nowUtcHour}:00 UTC (12-14 or 18-20 UTC has no edge in sim)`;
    } else if (!leaderRising) {
        reason = `not rising`;
    } else if (signalCount < 2) {
        // 1-signal trades: 66 trades, 64% WR, -$0.30/tr in sim (net losing sub-strategy)
        // "rising" alone is not enough edge; need at least one other signal confirming.
        reason = `sigs=${signalCount} < 2 (1-sig trades lose money)`;
    } else if (crypto === 'BTC' && leaderSide === 'DOWN') {
        // BTC has a severe directional bias in sim: UP leaders +$1.50/tr (59t, 76% WR),
        // DOWN leaders -$0.78/tr (63t, 60% WR). Likely regime-dependent (current bull tape).
        // Revisit if BTC regime changes. SOL/ETH/XRP show no such split.
        reason = `BTC DOWN leader (-$0.78/tr in sim; regime-dependent filter)`;
    } else if (crypto === 'ETH' && leaderAsk >= 0.65 && leaderAsk < 0.75) {
        // ETH 65-74¢ was +$0.25/tr in sim (marginal) and the weakest zone in the crypto
        // breakdown. Deployed after 2026-04-11 overnight drawdown where ETH 65-74¢ trades
        // took the bulk of the damage (5-6 losses out of ~13 ETH fills). Real-money risk
        // beats marginal sim edge.
        reason = `ETH 65-74¢ filtered (marginal sim edge, concentrated live losses)`;
    } else {
        action = 'TRADE';
        const parts: string[] = [prevMatchesFav ? 'prev=fav' : 'prev=dog', 'rising'];
        if (flip60) parts.push('flip60');
        if (accounts.includes('odd_flips')) parts.push('odd_flips');
        if (isUSEve) parts.push('US_eve');
        if (crossSame >= 2) parts.push(`cross=${crossSame}`);
        if (isWeekend) parts.push('weekend');
        if (sweetZone) parts.push('sweet');
        if (accelerating) parts.push('accel');
        if (strongDepth) parts.push('depth');
        if (lateFlip) parts.push('flip240');
        reason = parts.join('+');
    }

    // Liquidity check
    if (action === 'TRADE') {
        const sharesNeeded = Math.floor(TRADE_SIZE_USD / leaderAsk);
        if (leaderAskDepth < sharesNeeded) {
            action = 'SKIP';
            reason = `thin(${leaderAskDepth.toFixed(0)}sh total < ${sharesNeeded}sh needed)`;
        }
    }

    return {
        leaderSide, leaderBid, leaderAsk, leaderTokenId, leaderAskSize, leaderAskDepth,
        prevMatchesFav, leaderRising,
        flip60, isUSEve, isWeekend, crossSame,
        sweetZone, accelerating, strongDepth, lateFlip,
        signalCount, accounts,
        action, reason,
    };
}

// ── Auto-Redeem ───────────────────────────────────────────────────────

async function redeemPosition(conditionId: string, viemWalletClient: any, viemPublicClient: any): Promise<boolean> {
    if (!conditionId) return false;
    const maxWaitMs = 120000;
    const pollInterval = 10000;
    const deadline = Date.now() + maxWaitMs;

    while (Date.now() < deadline) {
        try {
            const den = await viemPublicClient.readContract({
                address: CT_ADDRESS, abi: payoutAbi,
                functionName: 'payoutDenominator', args: [conditionId as `0x${string}`],
            });
            if (Number(den) > 0) break;
        } catch {}
        log(`  Waiting for on-chain resolution (${Math.round((deadline - Date.now()) / 1000)}s remaining)...`);
        await sleep(pollInterval);
    }

    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const hash = await viemWalletClient.writeContract({
                address: CT_ADDRESS, abi: ctRedeemAbi,
                functionName: 'redeemPositions',
                args: [USDC_CT, ZERO_BYTES32, conditionId as `0x${string}`, [1n, 2n]],
            });
            const receipt = await viemPublicClient.waitForTransactionReceipt({ hash });
            if (receipt.status === 'success') {
                log(`  Redeemed (tx: ${hash.slice(0, 14)}...)`);
                return true;
            }
            log(`  Redeem tx REVERTED (attempt ${attempt}/3, tx: ${hash.slice(0, 14)}...)`);
        } catch (err: any) {
            log(`  Redeem failed (attempt ${attempt}/3): ${err.message?.slice(0, 60)}`);
        }
        if (attempt < 3) await sleep(3000);
    }

    return false;
}

// ── Main ──────────────────────────────────────────────────────────────

async function main() {
    log('='.repeat(60));
    log(`MICROSTRUCTURE BOT v4 — 9-Signal System`);
    log(`Mode: ${IS_LIVE ? '🔴 LIVE TRADING 🔴' : 'DRY RUN'}`);
    log(`Trade size: $${TRADE_SIZE_USD} | Max loss: $${MAX_LOSS_USD} | Trail: $${TRAIL_USD} from peak | Max trades: ${MAX_TRADES}`);
    log(`Sweep alert step: $${SWEEP_STEP_USD} above starting balance`);
    log(`Execution: maker-first (bid+1¢, 12s) → taker fallback (ask, 10s)`);
    log(`Filters: 54-59¢ + 65-74¢ | rising + sigs>=2 | skip 12-14,18-20 UTC | no BTC-DOWN | no ETH 65-74¢ | HOLD all`);
    log(`Signals: flip60, odd_flips, US_eve, cross>=2, weekend, sweet_zone, accelerating, depth>=2, late_flip`);
    log('='.repeat(60));

    // ── Setup ──
    let client: ClobClient | null = null;
    let executor: OrderExecutor | null = null;
    let verifier: PositionVerifier | null = null;
    let viemWalletClient: any = null;
    const viemPublicClient = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

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
        const initOk = await verifier.initialize(MAX_LOSS_USD, TRAIL_USD);
        if (!initOk) { log('FATAL: Could not read balance. Aborting.'); process.exit(1); }
        log(`Balance: $${verifier.getStartingBalance().toFixed(2)} | Floor: $${verifier.getFloorBalance().toFixed(2)} | Trail: $${TRAIL_USD} from peak`);
        if (verifier.getStartingBalance() < MIN_BALANCE_USD) { log('Balance too low.'); process.exit(1); }
    }

    const ledger = new TradeLedger('microstructure-trades.jsonl');

    // Chainlink (used for logging, not entry decision)
    log('Connecting to Chainlink...');
    const chainlink = new ChainlinkFeed();
    await chainlink.connect();
    let clWait = 0;
    while (chainlink.getPrice('btc/usd') === 0 && clWait < 30) { await sleep(1000); clWait++; }
    await sleep(3000);
    const clPrices = chainlink.getAllPrices();
    log(`CL: ${Object.entries(clPrices).map(([k, v]) => `${k}=$${v.toFixed(2)}`).join(' | ')}`);

    // Bootstrap previous resolutions via on-chain
    log('Bootstrapping previous resolutions (on-chain)...');
    const prevResolutions: Record<string, 'UP' | 'DOWN' | 'UNKNOWN'> = {};
    {
        // Wait for current candle to end so we can resolve the previous one
        const now = Math.floor(Date.now() / 1000);
        const nextBoundary = (Math.floor(now / 300) + 1) * 300;
        const waitSecs = nextBoundary - now;
        log(`  Waiting ${waitSecs}s for current candle to end (bootstrap)...`);
        await sleep(waitSecs * 1000 + 30000); // +30s for on-chain resolution

        const rounded5 = Math.floor(Date.now() / 1000 / 300) * 300;
        const prevCandleStart = rounded5 - 300;

        const bootPromises = CRYPTOS.map((crypto) => (async () => {
            const slug = `${crypto.slug}-updown-5m-${prevCandleStart}`;
            const res = await resolveOnChain(slug, viemPublicClient, 15);
            prevResolutions[crypto.name] = res;
        })());
        await Promise.all(bootPromises);
    }
    log(`Prev: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

    // ── State ──
    const snapshots: Map<string, { t240?: BookSnapshot; t120?: BookSnapshot; t60?: BookSnapshot }> = new Map();
    let evaluatedEndTimes = new Set<number>();
    let tradesExecuted = 0;
    let halted = false;
    let nextSweepAlertLevel = SWEEP_STEP_USD; // next $ above starting balance to trigger sweep alert
    const sessionTradedSlugs = new Set<string>();
    const pendingRedeems = new Set<string>();
    let lastRedeemRetryAt = 0;

    // L1 bracket trade state
    interface L1BracketTrade {
        crypto: string;
        interval: number;
        slug: string;
        market: any;
        leaderSide: 'UP' | 'DOWN';
        entryAsk: number;
        entryBid: number;
        entrySpread: number;
        shares: number;
        stopLevel: number;   // entry - 3¢
        targetLevel: number; // entry + 20¢
        status: 'OPEN' | 'STOPPED' | 'TARGET' | 'EXPIRED';
        pnl: number;
        candleEnd: number;
    }
    const l1Trades: L1BracketTrade[] = [];
    const l1EnteredThisCandle = new Set<string>(); // track crypto-interval to prevent re-entry
    let l1SessionPnl = 0;
    let l1SessionTrades = 0;
    let l1SessionStops = 0;
    let l1SessionTargets = 0;

    interface PendingTrade {
        signals: EntrySignals;
        crypto: string;
        interval: number;
        slug: string;
        conditionId: string;
        execResult: any;
        candleEnd: number;
        balanceBefore: number;
        market: any;          // for stop loss book polling
        stoppedOut: boolean;  // was this trade stopped out? (always false now — holds to resolution)
        wouldHaveStopped: boolean;  // would the stop have triggered? (informational)
        stopPnl: number;      // P&L if stopped out
    }
    let pendingTrades: PendingTrade[] = [];

    // ── Main Loop ──
    while (tradesExecuted < MAX_TRADES && !halted) {
        if (IS_LIVE && viemWalletClient && viemPublicClient && pendingRedeems.size > 0 && Date.now() - lastRedeemRetryAt >= 30000) {
            lastRedeemRetryAt = Date.now();
            log(`Retrying ${pendingRedeems.size} pending redeem(s)...`);
            for (const conditionId of [...pendingRedeems]) {
                const redeemed = await redeemPosition(conditionId, viemWalletClient, viemPublicClient);
                if (redeemed) pendingRedeems.delete(conditionId);
            }
        }

        const markets = await findCurrentMarkets();
        if (markets.length === 0) { await sleep(10000); continue; }

        const endTimes = new Set(markets.map(m => new Date(m.market.endDate).getTime()));
        const soonestEnd = Math.min(...endTimes);
        const secsLeft = Math.round((soonestEnd - Date.now()) / 1000);

        // ── Phase 1: Monitoring — capture snapshots + L1 bracket trading ──
        if (secsLeft > ENTRY_SECONDS_BEFORE + 5) {
            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);

            for (const { market, crypto, interval } of soonestMarkets) {
                const key = `${crypto.name}-${interval}`;
                if (!snapshots.has(key)) snapshots.set(key, {});
                const snaps = snapshots.get(key)!;

                // L1 bracket system disabled — v4 uses 9-signal entry at T-30 only

                // T-240 capture (230-250s before end)
                if (!snaps.t240 && secsLeft >= 230 && secsLeft <= 250) {
                    const snap = await takeBookSnapshot(market);
                    if (snap) {
                        snaps.t240 = snap;
                    }
                }

                // T-120 capture (100-140s before end)
                if (!snaps.t120 && secsLeft >= 100 && secsLeft <= 140) {
                    const snap = await takeBookSnapshot(market);
                    if (snap) {
                        snaps.t120 = snap;
                        log(`  T-${secsLeft}s ${key}: T-120 snap | ${snap.leader} leads | UP=${snap.upBid.toFixed(2)} DOWN=${snap.downBid.toFixed(2)}`);
                    }
                }

                // T-60 capture (55-70s before end)
                if (!snaps.t60 && secsLeft >= 55 && secsLeft <= 70) {
                    const snap = await takeBookSnapshot(market);
                    if (snap) {
                        snaps.t60 = snap;
                        const t120Leader = snaps.t120?.leader || '?';
                        const flipped = snaps.t120 && snap.leader !== snaps.t120.leader;
                        log(`  T-${secsLeft}s ${key}: T-60 snap | ${snap.leader} leads${flipped ? ' (FLIPPED from ' + t120Leader + ')' : ''}`);
                    }
                }
            }

            // L1 bracket system disabled

            // Status log every 30s
            if (secsLeft % 30 < 12) {
                const snapStr = [...snapshots.entries()]
                    .map(([k, s]) => {
                        const parts: string[] = [];
                        if (s.t240) parts.push(`t240:${s.t240.leader}`);
                        if (s.t120) parts.push(`t120:${s.t120.leader}`);
                        if (s.t60) parts.push(`t60:${s.t60.leader}`);
                        return parts.length ? `${k}[${parts.join(',')}]` : '';
                    })
                    .filter(Boolean).join(' ');
                const prevStr = Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' ');
                log(`T-${secsLeft}s | prev: ${prevStr} | ${snapStr || 'waiting for snapshots'}`);
            }

            await sleep(Math.min((secsLeft - ENTRY_SECONDS_BEFORE - 3) * 1000, 10000));
            continue;
        }

        // ── Phase 2: Entry at ~T-30s ──
        if (secsLeft <= ENTRY_SECONDS_BEFORE + 5 && secsLeft > 5 && !evaluatedEndTimes.has(soonestEnd)) {
            evaluatedEndTimes.add(soonestEnd);
            log(`\n--- T-${secsLeft}s ENTRY WINDOW ---`);

            if (IS_LIVE && verifier) {
                const lossCheck = await verifier.checkMaxLoss();
                if (!lossCheck.safe) { log(`HALT: ${lossCheck.reason}`); halted = true; break; }
                const startBal = verifier.getStartingBalance();
                const gain = lossCheck.currentBalance - startBal;
                const peakGain = lossCheck.peakBalance - startBal;
                const floorStr = lossCheck.trailActive
                    ? `trail floor $${lossCheck.floorBalance.toFixed(2)} (peak $${lossCheck.peakBalance.toFixed(2)} - $${TRAIL_USD})`
                    : `floor $${lossCheck.floorBalance.toFixed(2)} (max loss $${MAX_LOSS_USD})`;
                log(`Balance: $${lossCheck.currentBalance.toFixed(2)} | session ${gain >= 0 ? '+' : ''}$${gain.toFixed(2)} | peak +$${peakGain.toFixed(2)} | ${floorStr}`);

                // Sweep alert: each time session gain clears the next $SWEEP_STEP threshold, log once.
                while (gain >= nextSweepAlertLevel) {
                    log(`  💰 SWEEP READY: session +$${gain.toFixed(2)} ≥ $${nextSweepAlertLevel} — consider withdrawing $${SWEEP_STEP_USD} to cold wallet`);
                    nextSweepAlertLevel += SWEEP_STEP_USD;
                }
            }

            const soonestMarkets = markets.filter(m => new Date(m.market.endDate).getTime() === soonestEnd);

            let batchBalanceBefore = -1;
            if (IS_LIVE && verifier) {
                const check = await verifier.getBalance();
                batchBalanceBefore = check.balance;
            }

            for (const { market, crypto, interval } of soonestMarkets) {
                const key = `${crypto.name}-${interval}`;
                const snapT30 = await takeBookSnapshot(market);
                if (!snapT30) continue;

                if (snapT30.leader === 'TIE') {
                    log(`  ${key}: TIE at T-30 (UP=${snapT30.upBid.toFixed(2)} DOWN=${snapT30.downBid.toFixed(2)}) -> SKIP`);
                    continue;
                }

                const snaps = snapshots.get(key);
                const snapT60 = snaps?.t60 || null;
                const snapT120 = snaps?.t120 || null;
                const snapT240 = snaps?.t240 || null;

                // Use prev resolution for this crypto (5m resolution drives the signal)
                const prevRes = prevResolutions[crypto.name] || 'UNKNOWN';

                const signals = computeSignals(snapT30, snapT60, snapT120, snapT240, prevRes, prevResolutions, crypto.name, interval);

                // Log signal details
                const sideStr = `${signals.leaderSide} leads @${(signals.leaderAsk * 100).toFixed(0)}¢`;
                const sigStr = `prev=${prevRes} rising=${signals.leaderRising} flip60=${signals.flip60} sigs=${signals.signalCount}`;
                const acctStr = signals.accounts.length > 0 ? ` [${signals.accounts.join(',')}]` : '';
                log(`  ${key}: ${sideStr} | ${sigStr} -> ${signals.action} ${signals.reason}${acctStr}`);

                if (signals.action !== 'TRADE') continue;

                // Execute — use maker order (bid+1¢) for better entry price
                const makerPrice = Math.min(signals.leaderBid + 0.01, signals.leaderAsk); // bid+1¢, capped at ask
                log(`  >> BUY ${signals.leaderSide}: ${crypto.name} ${interval}m | ask=${(signals.leaderAsk * 100).toFixed(0)}¢ maker=${(makerPrice * 100).toFixed(0)}¢`);

                let execResult;
                if (IS_LIVE && executor) {
                    const tokenId = signals.leaderTokenId;
                    execResult = await executor.executeWithFallback(
                        tokenId, makerPrice, TRADE_SIZE_USD,
                        async () => (await getBookInfo(tokenId)).bestAsk,
                        log,
                        0.75, // max taker price — never pay outside the sweet zone
                    );
                    log(`    Order: ${execResult.status} (${execResult.fillType}) | ${execResult.fillSize} shares @${execResult.fillPrice}`);
                    if (execResult.status === 'ERROR') log(`    Error: ${execResult.error}`);
                } else {
                    const shares = Math.floor(TRADE_SIZE_USD / makerPrice);
                    log(`    DRY RUN: would buy ${shares} shares of ${signals.leaderSide} @${(makerPrice * 100).toFixed(0)}¢ ($${(shares * makerPrice).toFixed(2)}) [saved ${((signals.leaderAsk - makerPrice) * 100).toFixed(0)}¢/sh vs ask]`);
                    execResult = {
                        status: 'FILLED' as const,
                        orderId: 'dry-run',
                        fillPrice: makerPrice,
                        fillSize: shares,
                        fillCost: shares * makerPrice,
                        requestedPrice: makerPrice,
                        requestedShares: shares,
                        timestamps: { orderPlaced: Date.now(), confirmationReceived: Date.now() },
                    };
                }

                if (execResult.status === 'FILLED') {
                    tradesExecuted++;
                    sessionTradedSlugs.add(market.slug);
                }

                pendingTrades.push({
                    signals, crypto: crypto.name, interval,
                    slug: market.slug, conditionId: market.conditionId || '',
                    execResult, candleEnd: soonestEnd, balanceBefore: batchBalanceBefore,
                    market, stoppedOut: false, wouldHaveStopped: false, stopPnl: 0,
                });
            }

            if (pendingTrades.length > 0) {
                log(`  ${pendingTrades.length} trade(s) queued for resolution`);
            } else {
                log('  No qualifying trades this candle');
            }
        }

        // Wait phase — monitor stop levels on pending trades (informational only, hold all to resolution)
        // Stops disabled: tracking what would have happened for analysis.
        if (evaluatedEndTimes.has(soonestEnd) && secsLeft > 5) {
            for (const pending of pendingTrades) {
                if (pending.wouldHaveStopped) continue;

                const entryAsk = pending.signals.leaderAsk;
                const stopLevel = entryAsk - (STOP_LOSS_CENTS / 100);

                try {
                    const snap = await takeBookSnapshot(pending.market);
                    if (snap) {
                        const currentBid = pending.signals.leaderSide === 'UP' ? snap.upBid : snap.downBid;
                        if (currentBid > 0 && currentBid <= stopLevel) {
                            pending.wouldHaveStopped = true;
                            const shares = pending.execResult.fillSize;
                            pending.stopPnl = shares * (currentBid - entryAsk);
                            log(`  [info] STOP WOULD HIT: ${pending.crypto} ${pending.interval}m | entry=${(entryAsk*100).toFixed(0)}¢ bid=${(currentBid*100).toFixed(0)}¢ | hypothetical PnL: $${pending.stopPnl.toFixed(2)} [${pending.signals.signalCount} sigs]`);
                        }
                    }
                } catch {}
            }
            await sleep(5000);
            continue;
        }

        // ── Phase 3: Resolution ──
        if (secsLeft <= 5) {
            const waitForEnd = soonestEnd - Date.now();
            if (waitForEnd > 0) await sleep(waitForEnd + 5000);
            await sleep(30000);

            if (pendingTrades.length > 0) {
                log(`  Resolving ${pendingTrades.length} pending trade(s)...`);
                const filledTradesThisBatch = pendingTrades.filter(p => p.execResult.status === 'FILLED');
                const canReconcileIndividually = IS_LIVE && verifier && filledTradesThisBatch.length === 1;

                if (IS_LIVE && filledTradesThisBatch.length > 1) {
                    log(`  Note: ${filledTradesThisBatch.length} fills in one candle — skipping per-trade balance reconciliation because positions overlap`);
                }

                for (const pending of pendingTrades) {
                    const { signals, crypto, interval, slug, conditionId, execResult, balanceBefore } = pending;
                    const resolution = await resolveOnChain(slug, viemPublicClient, 20);

                    if (resolution === 'UNKNOWN') {
                        log(`  ${crypto} ${interval}m: UNKNOWN`);
                        const record: TradeRecord = {
                            timestamp: new Date().toISOString(), tradeNumber: 0,
                            slug, crypto,
                            underdogSide: signals.leaderSide, underdogAsk: signals.leaderAsk,
                            filters: { neverOneSided: true, prevResMatch: true, twoSidedAtT60: true },
                            signals: {
                                signalCount: signals.signalCount,
                                accounts: signals.accounts,
                                flip60: signals.flip60,
                                isUSEve: signals.isUSEve,
                                isWeekend: signals.isWeekend,
                                crossSame: signals.crossSame,
                                leaderRising: signals.leaderRising,
                                prevMatchesFav: signals.prevMatchesFav,
                                stoppedOut: false,
                                holdPnl: 0,
                            },
                            execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                            resolution: 'UNKNOWN', won: false, expectedPnl: 0,
                            balanceBefore, balanceAfter: -1, reconciliation: null,
                            sessionPnl: 0, sessionTrades: 0, sessionWins: 0,
                        };
                        ledger.recordTrade(record);
                        continue;
                    }

                    const won = signals.leaderSide === resolution;
                    const holdPnl = won ? execResult.fillSize * (1 - execResult.fillPrice) : -(execResult.fillCost);

                    // Always hold to resolution — track what stop would have done
                    const expectedPnl = holdPnl;

                    const resultStr = won ? 'WIN' : 'LOSS';
                    const stopStr = pending.wouldHaveStopped ? ` (stop would've been $${pending.stopPnl.toFixed(2)})` : '';
                    const acctStr = signals.accounts.length > 0 ? ` accts=[${signals.accounts.join(',')}]` : '';
                    log(`  ${crypto} ${interval}m: ${resultStr} — bought ${signals.leaderSide} @${(signals.leaderAsk * 100).toFixed(0)}¢, resolved ${resolution} | PnL: $${expectedPnl.toFixed(2)} [${signals.reason}] ${signals.signalCount}sig${stopStr}${acctStr}`);

                    if (IS_LIVE && viemWalletClient && conditionId) {
                        const redeemed = await redeemPosition(conditionId, viemWalletClient, viemPublicClient);
                        if (redeemed) {
                            pendingRedeems.delete(conditionId);
                        } else {
                            pendingRedeems.add(conditionId);
                            log(`  Queued redeem retry for ${conditionId.slice(0, 14)}...`);
                        }
                        await sleep(2000); // wait for RPC to reflect redeemed USDC
                    }

                    let balanceAfter = -1;
                    if (IS_LIVE && verifier) {
                        const postCheck = await verifier.getBalance();
                        balanceAfter = postCheck.success ? postCheck.balance : -1;
                    }

                    const reconciliation = (canReconcileIndividually && execResult.status === 'FILLED' && balanceBefore > 0 && balanceAfter > 0 && verifier)
                        ? verifier.reconcile(expectedPnl, balanceBefore, balanceAfter)
                        : null;

                    const record: TradeRecord = {
                        timestamp: new Date().toISOString(), tradeNumber: 0,
                        slug, crypto,
                        underdogSide: signals.leaderSide, underdogAsk: signals.leaderAsk,
                        filters: { neverOneSided: true, prevResMatch: true, twoSidedAtT60: true },
                        signals: {
                            signalCount: signals.signalCount,
                            accounts: signals.accounts,
                            flip60: signals.flip60,
                            isUSEve: signals.isUSEve,
                            isWeekend: signals.isWeekend,
                            crossSame: signals.crossSame,
                            leaderRising: signals.leaderRising,
                            prevMatchesFav: signals.prevMatchesFav,
                            stoppedOut: pending.wouldHaveStopped, // hypothetical — trade held to resolution
                            holdPnl: holdPnl,
                        },
                        execution: { status: execResult.status, orderId: execResult.orderId, fillPrice: execResult.fillPrice, fillSize: execResult.fillSize, fillCost: execResult.fillCost, latencyMs: execResult.timestamps.confirmationReceived - execResult.timestamps.orderPlaced },
                        resolution, won, expectedPnl,
                        balanceBefore, balanceAfter, reconciliation,
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

            // Update prev resolutions from all resolved 5m markets this candle
            const soonestMarkets5m = markets.filter(m => {
                const endMs = new Date(m.market.endDate).getTime();
                return Math.abs(endMs - soonestEnd) < 30000 && m.market.slug?.includes('-5m-');
            });
            for (const { market, crypto } of soonestMarkets5m) {
                const res = await resolveOnChain(market.slug, viemPublicClient, 15);
                if (res !== 'UNKNOWN') {
                    prevResolutions[crypto.name] = res;
                }
            }
            log(`  Prev updated: ${Object.entries(prevResolutions).map(([k, v]) => `${k}=${v}`).join(' | ')}`);

            // Reset for next candle
            snapshots.clear();
            await sleep(2000);
            continue;
        }

        await sleep(5000);
    }

    // ── Session Summary ──
    const stats = ledger.getStats();
    log('\n' + '='.repeat(60));
    log('SESSION SUMMARY — MICROSTRUCTURE BOT v4');
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
                    const redeemed = await redeemPosition(data[0].conditionId, viemWalletClient, viemPublicClient);
                    if (redeemed) pendingRedeems.delete(data[0].conditionId);
                }
            } catch {}
        }
        if (verifier) {
            const swept = await verifier.getBalance();
            if (swept.success) log(`Post-sweep balance: $${swept.balance.toFixed(2)}`);
        }
    }
}

main().catch(err => { log(`FATAL: ${err.message}`); process.exit(1); });
