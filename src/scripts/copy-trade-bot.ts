#!/usr/bin/env npx tsx
/**
 * Copy-Trade Bot v2 — Direct Polymarket API
 *
 * Polls Polymarket's data API directly for trades from followed wallets.
 * Executes via our existing CLOB client (uses our Polymarket EOA).
 * No Bullpen dependency for the main loop. Bullpen leaderboard used only
 * for periodic discovery of new traders.
 *
 * Usage:
 *   npx tsx src/scripts/copy-trade-bot.ts                  # dry run (default)
 *   npx tsx src/scripts/copy-trade-bot.ts --live            # real money
 *   npx tsx src/scripts/copy-trade-bot.ts --size 10         # $10 per trade
 *   npx tsx src/scripts/copy-trade-bot.ts --poll 30         # poll every 30s
 *   npx tsx src/scripts/copy-trade-bot.ts --max-loss 30     # stop after $30 loss
 */

import { execSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { request } from 'node:https';

// ── CLI args ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const param = (name: string, fallback: string) => {
    const idx = args.indexOf(`--${name}`);
    return idx >= 0 && args[idx + 1] ? args[idx + 1] : fallback;
};

const LIVE = flag('live');
const TRADE_SIZE_USD = parseFloat(param('size', '5'));
const POLL_INTERVAL_S = parseInt(param('poll', '15'), 10);
const MAX_LOSS_USD = parseFloat(param('max-loss', '40'));
const LEDGER_PATH = 'copy-trades.jsonl';
const STATE_PATH = 'state/copy-trade-seen.json';
const FOLLOWED_PATH = 'state/copy-trade-followed.json';

// ── Followed traders (managed dynamically) ──────────────────────────────
interface FollowedTrader {
    address: string;
    name: string;
    addedAt: string;
    reason?: string;
}

const DEFAULT_FOLLOWED: FollowedTrader[] = [
    { address: '0xc2e7800b5af46e6093872b177b7a5e7f0563be51', name: 'beachboy4', addedAt: '2026-04-06', reason: 'Conviction sports bettor, $3.5M PnL, 161 trades' },
    { address: '0x59a0744db1f39ff3afccd175f80e6e8dfc239a09', name: 'Blessed-Sunshine', addedAt: '2026-04-06', reason: 'NBA spreads, $1.2M PnL' },
    { address: '0x204f72f35326db932158cba6adff0b9a1da95e14', name: 'swisstony', addedAt: '2026-04-06', reason: 'Live sports bot, 73K trades' },
    { address: '0xee613b3fc183ee44f9da9c05f53e2da107e3debf', name: 'sovereign2013', addedAt: '2026-04-06', reason: 'Live sports bot, 38K trades' },
    { address: '0x507e52ef684ca2dd91f90a9d26d149dd3288beae', name: 'GamblingIsAllYouNeed', addedAt: '2026-04-06', reason: 'Esports/CS:GO specialist' },
    { address: '0x37c1874a60d348903594a96703e0507c518fc53a', name: 'CemeterySun', addedAt: '2026-04-06', reason: 'Daily #1, diverse sports' },
    { address: '0x63a51cbb37341837b873bc29d05f482bc2988e33', name: 'mhh29', addedAt: '2026-04-06', reason: 'Big concentrated MLB bets' },
    { address: '0xa5ea13a81d2b7e8e424b182bdc1db08e756bd96a', name: 'bossoskil1', addedAt: '2026-04-06', reason: 'Esports specialist' },
];

function loadFollowed(): FollowedTrader[] {
    try {
        if (existsSync(FOLLOWED_PATH)) {
            return JSON.parse(readFileSync(FOLLOWED_PATH, 'utf-8'));
        }
    } catch { /* fallback */ }
    // First run — write defaults
    saveFollowed(DEFAULT_FOLLOWED);
    return DEFAULT_FOLLOWED;
}

function saveFollowed(list: FollowedTrader[]): void {
    try {
        const dir = FOLLOWED_PATH.substring(0, FOLLOWED_PATH.lastIndexOf('/'));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(FOLLOWED_PATH, JSON.stringify(list, null, 2));
    } catch (e: any) {
        console.log(`[WARN] Failed to save followed list: ${e.message}`);
    }
}

// ── Death/harm exclusion filter ─────────────────────────────────────────
const EXCLUDED_PATTERNS = [
    /\bdeath\b/i, /\bdie\b/i, /\bdies\b/i, /\bdead\b/i, /\bdying\b/i,
    /\bassassinat/i, /\bkilled\b/i, /\bkill\b/i, /\bmurder/i,
    /\bexecuted\b/i, /\blethal\b/i,
    /\bsuicide\b/i, /\boverdose\b/i, /\bfatal\b/i,
];

function isExcludedMarket(title: string): boolean {
    return EXCLUDED_PATTERNS.some(pat => pat.test(title));
}

// ── Types ───────────────────────────────────────────────────────────────
interface PolymarketTrade {
    proxyWallet: string;
    side: 'BUY' | 'SELL';
    asset: string;             // token ID
    conditionId: string;
    size: number;              // shares
    price: number;
    timestamp: number;         // unix seconds
    title: string;             // market title
    slug: string;              // market slug
    eventSlug: string;
    outcome: string;           // outcome name (e.g. "Yes", "Hornets")
    outcomeIndex: number;
    name: string;              // trader name
    pseudonym: string;
    transactionHash: string;
}

interface CopyTradeRecord {
    timestamp: string;
    tradeNumber: number;
    mode: 'DRY_RUN' | 'LIVE';
    sourceTrader: string;
    sourceTraderAddress: string;
    sourceTxHash: string;
    sourceSize: number;
    sourcePrice: number;
    marketTitle: string;
    marketSlug: string;
    conditionId: string;
    asset: string;
    outcome: string;
    side: 'BUY' | 'SELL';
    copySize: number;
    status: 'COPIED' | 'SKIPPED' | 'FAILED' | 'EXCLUDED';
    skipReason?: string;
    error?: string;
    fillPrice?: number;
    fillShares?: number;
    sessionPnl: number;
    sessionTrades: number;
}

// ── HTTP helper ─────────────────────────────────────────────────────────
function httpsGet(url: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const req = request(url, { method: 'GET', timeout: 15000 }, (res) => {
            let data = '';
            res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
            res.on('end', () => {
                if (res.statusCode === 200) resolve(data);
                else reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 100)}`));
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.end();
    });
}

// ── Polymarket Data API ─────────────────────────────────────────────────
const POLY_DATA_BASE = 'https://data-api.polymarket.com';

async function fetchTraderTrades(address: string, limit: number = 20): Promise<PolymarketTrade[]> {
    try {
        const url = `${POLY_DATA_BASE}/trades?user=${address}&limit=${limit}`;
        const body = await httpsGet(url);
        const trades = JSON.parse(body);
        return Array.isArray(trades) ? trades : [];
    } catch (e: any) {
        // Don't spam errors
        return [];
    }
}

// ── State management ────────────────────────────────────────────────────
function tradeKey(t: PolymarketTrade): string {
    // tx hash is the cleanest unique identifier
    return t.transactionHash || `${t.timestamp}|${t.proxyWallet}|${t.asset}|${t.side}`;
}

function loadSeenTrades(): Set<string> {
    try {
        if (existsSync(STATE_PATH)) {
            const data = JSON.parse(readFileSync(STATE_PATH, 'utf-8'));
            return new Set(data.seen || []);
        }
    } catch { /* fresh */ }
    return new Set();
}

function saveSeenTrades(seen: Set<string>): void {
    const arr = [...seen];
    const trimmed = arr.slice(Math.max(0, arr.length - 5000));
    try {
        const dir = STATE_PATH.substring(0, STATE_PATH.lastIndexOf('/'));
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(STATE_PATH, JSON.stringify({ seen: trimmed, updated: new Date().toISOString() }));
    } catch (e: any) {
        console.log(`[WARN] Failed to save seen state: ${e.message}`);
    }
}

// ── Ledger ──────────────────────────────────────────────────────────────
let tradeCount = 0;
let sessionPnl = 0;

function loadTradeCount(): number {
    try {
        if (existsSync(LEDGER_PATH)) {
            const content = readFileSync(LEDGER_PATH, 'utf-8').trim();
            if (content) return content.split('\n').length;
        }
    } catch { /* start at 0 */ }
    return 0;
}

function archiveLedgerIfNeeded(): void {
    if (!existsSync(LEDGER_PATH)) return;
    const content = readFileSync(LEDGER_PATH, 'utf-8').trim();
    if (!content) return;
    const lines = content.split('\n').length;
    console.log(`[INIT] Existing ledger found with ${lines} trades — preserving and appending`);
}

function recordTrade(record: CopyTradeRecord): void {
    appendFileSync(LEDGER_PATH, JSON.stringify(record) + '\n');
}

// ── Position tracking ───────────────────────────────────────────────────
interface Position {
    asset: string;
    marketSlug: string;
    outcome: string;
    shares: number;
    entryPrice: number;
    sourceTrader: string;
    timestamp: string;
}

const positions = new Map<string, Position>();  // key: asset (token id)

// ── Execution (CLOB) ────────────────────────────────────────────────────
let clobExecutor: any = null;

async function getExecutor() {
    if (clobExecutor) return clobExecutor;
    if (!LIVE) return null;
    // Lazy import — only loaded if --live
    const { getAuthenticatedClient } = await import('../core/clob-client.js');
    const { OrderExecutor } = await import('../core/execution/order-executor.js');
    const client = await getAuthenticatedClient();
    clobExecutor = new OrderExecutor(client);
    console.log('[INIT] CLOB executor ready');
    return clobExecutor;
}

async function executeBuy(asset: string, price: number, sizeUsd: number): Promise<{ success: boolean; fillPrice?: number; fillShares?: number; error?: string }> {
    try {
        const executor = await getExecutor();
        if (!executor) return { success: false, error: 'No executor (dry run)' };
        const result = await executor.executeAndConfirm(asset, price, sizeUsd);
        if (result.status === 'FILLED') {
            return { success: true, fillPrice: result.fillPrice, fillShares: result.fillSize };
        }
        return { success: false, error: result.error || result.status };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

async function executeSell(asset: string, shares: number): Promise<{ success: boolean; fillPrice?: number; error?: string }> {
    try {
        const executor = await getExecutor();
        if (!executor) return { success: false, error: 'No executor (dry run)' };
        // For sells, we use a market sell at current bid via the executor
        // Note: existing executor only does buys via executeAndConfirm — we'd need to add sell support
        // For now, return not-implemented and we'll add sell logic when going live
        return { success: false, error: 'Live sell not yet implemented' };
    } catch (e: any) {
        return { success: false, error: e.message };
    }
}

// ── Trader discovery (Bullpen leaderboard, unauthenticated) ─────────────
async function discoverNewTraders(currentFollowed: FollowedTrader[]): Promise<void> {
    try {
        // Bullpen leaderboard call doesn't require auth
        const output = execSync('bullpen pm data leaderboard --period day --limit 25 --output json', {
            timeout: 30000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            killSignal: 'SIGKILL',
        });
        const lb = JSON.parse(output);
        if (!Array.isArray(lb)) return;

        const followedAddrs = new Set(currentFollowed.map(t => t.address.toLowerCase()));
        const newOnes = lb.filter((entry: any) => {
            const addr = entry.address?.toLowerCase();
            const pnl = parseFloat(entry.pnl || '0');
            const volume = parseFloat(entry.volume || '0');
            // Suggest if not already followed, has volume (not just resolved positions), and decent PnL
            return addr && !followedAddrs.has(addr) && volume > 100000 && pnl > 50000;
        });

        if (newOnes.length > 0) {
            console.log(`\n[DISCOVERY] ${newOnes.length} new high-PnL active traders detected:`);
            for (const t of newOnes.slice(0, 5)) {
                console.log(`  - ${t.username || t.address.slice(0, 10)}: $${parseFloat(t.pnl).toLocaleString()} PnL, $${parseFloat(t.volume).toLocaleString()} volume`);
            }
            console.log('  (Manually add to followed list if desired)');
        }
    } catch (e: any) {
        // Discovery is optional — silent fail
    }
}

// ── Main loop ───────────────────────────────────────────────────────────
async function main() {
    console.log('='.repeat(60));
    console.log(`  COPY-TRADE BOT v2 — ${LIVE ? '🔴 LIVE' : '🟡 DRY RUN'}`);
    console.log('='.repeat(60));
    console.log(`  Trade size:     $${TRADE_SIZE_USD}`);
    console.log(`  Poll interval:  ${POLL_INTERVAL_S}s`);
    console.log(`  Max loss:       $${MAX_LOSS_USD}`);
    console.log(`  Ledger:         ${LEDGER_PATH}`);
    console.log(`  Mode:           ${LIVE ? 'LIVE — REAL MONEY' : 'DRY RUN — paper only'}`);
    console.log(`  Data source:    Polymarket API (no Bullpen auth needed)`);
    console.log('='.repeat(60));

    archiveLedgerIfNeeded();
    tradeCount = loadTradeCount();
    const seen = loadSeenTrades();
    const followed = loadFollowed();
    console.log(`[INIT] Following ${followed.length} traders, ${seen.size} seen trades, ${tradeCount} recorded trades`);
    console.log(`[INIT] Followed: ${followed.map(t => t.name).join(', ')}`);

    // Initialize executor if live
    if (LIVE) {
        await getExecutor();
    }

    // Seed seen trades on first run
    if (seen.size === 0) {
        console.log('[INIT] First run — seeding existing trades as seen...');
        for (const trader of followed) {
            const trades = await fetchTraderTrades(trader.address, 20);
            for (const t of trades) seen.add(tradeKey(t));
        }
        saveSeenTrades(seen);
        console.log(`[INIT] Seeded ${seen.size} existing trades. Will only copy NEW trades from now on.`);
    }

    console.log(`\n[RUNNING] Polling every ${POLL_INTERVAL_S}s for new trades...\n`);

    let pollCount = 0;
    let lastDiscovery = 0;
    const DISCOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

    while (true) {
        try {
            pollCount++;
            let newCount = 0;

            // Fetch trades from each followed trader in parallel
            const allTrades = await Promise.all(
                followed.map(async (trader) => {
                    const trades = await fetchTraderTrades(trader.address, 20);
                    return trades.map(t => ({ ...t, _traderName: trader.name }));
                })
            );

            // Flatten and process
            const flat: (PolymarketTrade & { _traderName: string })[] = [];
            for (const arr of allTrades) flat.push(...arr);

            // Sort by timestamp ascending so we process in order
            flat.sort((a, b) => a.timestamp - b.timestamp);

            for (const trade of flat) {
                const key = tradeKey(trade);
                if (seen.has(key)) continue;
                seen.add(key);
                newCount++;

                const now = new Date().toISOString();
                const traderName = trade._traderName || trade.name;
                console.log(`\n[NEW] ${traderName} | ${trade.side} ${trade.outcome} @ ${trade.price} ($${(trade.size * trade.price).toFixed(0)}) — ${trade.title.slice(0, 60)}`);

                // Death/harm filter
                if (isExcludedMarket(trade.title)) {
                    console.log(`  → EXCLUDED (death/harm keyword)`);
                    tradeCount++;
                    recordTrade({
                        timestamp: now, tradeNumber: tradeCount, mode: LIVE ? 'LIVE' : 'DRY_RUN',
                        sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                        sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                        marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                        asset: trade.asset, outcome: trade.outcome, side: trade.side, copySize: 0,
                        status: 'EXCLUDED', skipReason: 'Death/harm keyword',
                        sessionPnl, sessionTrades: tradeCount,
                    });
                    continue;
                }

                // SELL handling
                if (trade.side === 'SELL') {
                    const pos = positions.get(trade.asset);
                    if (!pos) {
                        console.log(`  → SKIP SELL (no position in ${trade.asset.slice(0, 12)}…)`);
                        tradeCount++;
                        recordTrade({
                            timestamp: now, tradeNumber: tradeCount, mode: LIVE ? 'LIVE' : 'DRY_RUN',
                            sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                            sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                            marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                            asset: trade.asset, outcome: trade.outcome, side: 'SELL', copySize: 0,
                            status: 'SKIPPED', skipReason: 'No position to sell',
                            sessionPnl, sessionTrades: tradeCount,
                        });
                        continue;
                    }

                    if (LIVE) {
                        const result = await executeSell(trade.asset, pos.shares);
                        if (result.success) {
                            const pnl = pos.shares * (trade.price - pos.entryPrice);
                            sessionPnl += pnl;
                            console.log(`  → SOLD @ ${result.fillPrice} — PnL: $${pnl.toFixed(2)}`);
                        } else {
                            console.log(`  → SELL FAILED: ${result.error}`);
                        }
                    } else {
                        const pnl = pos.shares * (trade.price - pos.entryPrice);
                        sessionPnl += pnl;
                        console.log(`  → [DRY] Would sell ${pos.shares.toFixed(1)} shares — est PnL: $${pnl.toFixed(2)}`);
                    }
                    positions.delete(trade.asset);

                    tradeCount++;
                    recordTrade({
                        timestamp: now, tradeNumber: tradeCount, mode: LIVE ? 'LIVE' : 'DRY_RUN',
                        sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                        sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                        marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                        asset: trade.asset, outcome: trade.outcome, side: 'SELL', copySize: TRADE_SIZE_USD,
                        status: 'COPIED',
                        sessionPnl, sessionTrades: tradeCount,
                    });
                    continue;
                }

                // BUY handling
                if (sessionPnl <= -MAX_LOSS_USD) {
                    console.log(`  → SKIP (max loss reached: $${sessionPnl.toFixed(2)})`);
                    tradeCount++;
                    recordTrade({
                        timestamp: now, tradeNumber: tradeCount, mode: LIVE ? 'LIVE' : 'DRY_RUN',
                        sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                        sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                        marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                        asset: trade.asset, outcome: trade.outcome, side: 'BUY', copySize: TRADE_SIZE_USD,
                        status: 'SKIPPED', skipReason: `Max loss reached`,
                        sessionPnl, sessionTrades: tradeCount,
                    });
                    continue;
                }

                if (positions.has(trade.asset)) {
                    console.log(`  → SKIP (already have position)`);
                    continue;
                }

                const estimatedShares = TRADE_SIZE_USD / trade.price;

                if (LIVE) {
                    console.log(`  → BUYING $${TRADE_SIZE_USD} @ ${trade.price}`);
                    const result = await executeBuy(trade.asset, trade.price, TRADE_SIZE_USD);
                    if (result.success) {
                        console.log(`  → FILLED @ ${result.fillPrice} (${result.fillShares} shares)`);
                        positions.set(trade.asset, {
                            asset: trade.asset, marketSlug: trade.slug, outcome: trade.outcome,
                            shares: result.fillShares || estimatedShares,
                            entryPrice: result.fillPrice || trade.price,
                            sourceTrader: traderName, timestamp: now,
                        });
                    } else {
                        console.log(`  → BUY FAILED: ${result.error}`);
                        tradeCount++;
                        recordTrade({
                            timestamp: now, tradeNumber: tradeCount, mode: 'LIVE',
                            sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                            sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                            marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                            asset: trade.asset, outcome: trade.outcome, side: 'BUY', copySize: TRADE_SIZE_USD,
                            status: 'FAILED', error: result.error?.slice(0, 200),
                            sessionPnl, sessionTrades: tradeCount,
                        });
                        continue;
                    }
                } else {
                    console.log(`  → [DRY] Would buy $${TRADE_SIZE_USD} (~${estimatedShares.toFixed(1)} shares)`);
                    positions.set(trade.asset, {
                        asset: trade.asset, marketSlug: trade.slug, outcome: trade.outcome,
                        shares: estimatedShares, entryPrice: trade.price,
                        sourceTrader: traderName, timestamp: now,
                    });
                }

                tradeCount++;
                recordTrade({
                    timestamp: now, tradeNumber: tradeCount, mode: LIVE ? 'LIVE' : 'DRY_RUN',
                    sourceTrader: traderName, sourceTraderAddress: trade.proxyWallet,
                    sourceTxHash: trade.transactionHash, sourceSize: trade.size, sourcePrice: trade.price,
                    marketTitle: trade.title, marketSlug: trade.slug, conditionId: trade.conditionId,
                    asset: trade.asset, outcome: trade.outcome, side: 'BUY', copySize: TRADE_SIZE_USD,
                    status: 'COPIED',
                    sessionPnl, sessionTrades: tradeCount,
                });
            }

            if (newCount > 0) {
                saveSeenTrades(seen);
                console.log(`\n[STATUS] ${tradeCount} trades | ${positions.size} positions | PnL $${sessionPnl.toFixed(2)}`);
            }

            // Heartbeat every ~20 polls
            if (pollCount % 20 === 0) {
                const now = new Date().toLocaleTimeString();
                console.log(`[${now}] Heartbeat — ${tradeCount}T, ${positions.size} pos, PnL $${sessionPnl.toFixed(2)}`);
            }

            // Periodic discovery (every 6h)
            if (Date.now() - lastDiscovery > DISCOVERY_INTERVAL_MS) {
                lastDiscovery = Date.now();
                await discoverNewTraders(followed);
            }

        } catch (e: any) {
            console.log(`[ERROR] Poll cycle: ${e.message?.slice(0, 100)}`);
        }

        await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_S * 1000));
    }
}

// ── Shutdown ────────────────────────────────────────────────────────────
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] SIGINT');
    console.log(`[FINAL] ${tradeCount} trades | PnL $${sessionPnl.toFixed(2)} | ${positions.size} open positions`);
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n[SHUTDOWN] SIGTERM');
    process.exit(0);
});

main().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
});
