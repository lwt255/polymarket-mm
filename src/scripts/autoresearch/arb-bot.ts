/**
 * Dry-Run Arb Bot for BTC 5-Minute Markets
 *
 * Paper-trades maker-only limit BUY orders on both UP and DOWN sides.
 * If both fill at combined cost < $1.00, guaranteed profit at resolution.
 *
 * Outputs DryRunResult JSON to stdout. Logs to stderr.
 *
 * Usage: npx tsx src/scripts/autoresearch/arb-bot.ts --duration 30
 */

import { ChainlinkFeed } from '../crypto-5min/chainlink-feed.js';
import { PARAMS } from './arb-bot-params.js';
import type { ArbBotParams, BookSnapshot, MarketResult, DryRunResult, DryRunSummary } from './types.js';

const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const POLL_INTERVAL_MS = 3000;

const log = (...args: any[]) => console.error(...args);

// --- Helpers ---

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Sleep in 10s chunks, checking Chainlink health each chunk. Throws if feed is dead. */
async function sleepWithHealthCheck(ms: number, chainlink: ChainlinkFeed): Promise<void> {
    const chunkMs = 10000;
    let remaining = ms;
    while (remaining > 0) {
        await sleep(Math.min(remaining, chunkMs));
        remaining -= chunkMs;
        if (chainlink.getTimestamp() > 0 && Date.now() - chainlink.getTimestamp() > 120000) {
            throw new Error('Chainlink feed stale during sleep');
        }
    }
}

async function getFullBook(tokenId: string): Promise<BookSnapshot> {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, spread: 1, midpoint: 0.5, bidDepth: 0, askDepth: 0, bids: [], asks: [] };

    const bids = (raw.bids || [])
        .map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || [])
        .map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .sort((a: any, b: any) => a.price - b.price);

    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 1;
    const bidDepth = bids.filter((b: any) => b.price >= bestBid - 0.05).reduce((sum: number, b: any) => sum + b.size, 0);
    const askDepth = asks.filter((a: any) => a.price <= bestAsk + 0.05).reduce((sum: number, a: any) => sum + a.size, 0);

    return { bestBid, bestAsk, spread: bestAsk - bestBid, midpoint: (bestBid + bestAsk) / 2, bidDepth, askDepth, bids, asks };
}

async function findCurrentMarket(): Promise<any> {
    const now = Math.floor(Date.now() / 1000);
    const rounded = Math.floor(now / 300) * 300;

    for (const ts of [rounded, rounded + 300]) {
        const slug = `btc-updown-5m-${ts}`;
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data && data.length > 0) {
            const m = data[0];
            const endDate = new Date(m.endDate).getTime();
            if (endDate > Date.now()) return m;
        }
    }
    return null;
}

async function findMarketWithRetry(retries = 5): Promise<any> {
    let market = await findCurrentMarket();
    for (let i = 0; i < retries && !market; i++) {
        log(`  Retry ${i + 1}/${retries} finding market...`);
        await sleep(2000);
        market = await findCurrentMarket();
    }
    return market;
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

async function resolveOutcome(slug: string, retries = 5): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    for (let i = 0; i < retries; i++) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data?.[0]) {
            // Try outcomePrices first (resolved markets)
            const prices = JSON.parse(data[0].outcomePrices || '[]').map(Number);
            const outcomes = JSON.parse(data[0].outcomes || '[]');
            const upIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'UP');
            const downIdx = outcomes.findIndex((o: string) => o.toUpperCase() === 'DOWN');
            if (upIdx !== -1 && prices[upIdx] >= 0.95) return 'UP';
            if (downIdx !== -1 && prices[downIdx] >= 0.95) return 'DOWN';

            // Also check if market shows resolved status
            if (data[0].resolved) {
                // Resolved but prices not extreme — check which side won
                if (upIdx !== -1 && downIdx !== -1) {
                    if (prices[upIdx] > prices[downIdx]) return 'UP';
                    if (prices[downIdx] > prices[upIdx]) return 'DOWN';
                }
            }
        }
        log(`    Resolution attempt ${i + 1}/${retries}: not yet resolved`);
        if (i < retries - 1) await sleep(5000);
    }
    return 'UNKNOWN';
}

/** Resolve using Chainlink: UP wins if closing price >= opening price */
function resolveFromChainlink(market: any, chainlink: ChainlinkFeed, openPrice: number): 'UP' | 'DOWN' | 'UNKNOWN' {
    const closePrice = chainlink.getPrice();
    if (openPrice <= 0 || closePrice <= 0) return 'UNKNOWN';
    log(`  Chainlink resolution: open=$${openPrice.toFixed(2)} close=$${closePrice.toFixed(2)}`);
    return closePrice >= openPrice ? 'UP' : 'DOWN';
}

// --- Main Bot Logic ---

async function runOneMarket(params: ArbBotParams, chainlink: ChainlinkFeed): Promise<MarketResult> {
    try {
        return await _runOneMarket(params, chainlink);
    } catch (err: any) {
        log(`  [ERROR] ${err.message}`);
        return makeSkippedResult(err.message);
    }
}

async function _runOneMarket(params: ArbBotParams, chainlink: ChainlinkFeed): Promise<MarketResult> {
    const market = await findMarketWithRetry();
    if (!market) {
        return makeSkippedResult('No market found');
    }

    const tokens = getTokenIds(market);
    if (!tokens) {
        return makeSkippedResult('Could not parse token IDs');
    }

    const endTime = new Date(market.endDate).getTime();
    const startTime = endTime - 300000; // 5-min markets
    const slug = market.slug;
    log(`\n=== Market: ${slug} ===`);
    log(`  End: ${new Date(endTime).toISOString()}`);

    // Capture opening Chainlink price (used for resolution)
    const openPrice = chainlink.getPrice();
    log(`  Chainlink open: $${openPrice.toFixed(2)}`);

    // Entry delay
    if (params.entryDelaySeconds > 0) {
        log(`  Waiting ${params.entryDelaySeconds}s entry delay...`);
        await sleep(params.entryDelaySeconds * 1000);
    }

    // Check if market still active after delay
    if (Date.now() >= endTime - params.exitBeforeEndSeconds * 1000) {
        return makeSkippedResult('Market too close to end after entry delay');
    }

    // Fetch initial books
    const upBook = await getFullBook(tokens.upToken);
    const downBook = await getFullBook(tokens.downToken);

    // Apply filters
    const overround = upBook.bestAsk + downBook.bestAsk - 1.0;

    if (upBook.spread * 100 < params.minSpreadCents || downBook.spread * 100 < params.minSpreadCents) {
        return makeSkippedResult(`Spread too tight: UP=${(upBook.spread * 100).toFixed(1)}¢ DOWN=${(downBook.spread * 100).toFixed(1)}¢`);
    }
    if (overround * 100 > params.maxOverroundCents) {
        return makeSkippedResult(`Overround too high: ${(overround * 100).toFixed(1)}¢`);
    }
    if (upBook.bidDepth < params.minBookDepthUsd || downBook.bidDepth < params.minBookDepthUsd) {
        return makeSkippedResult(`Book depth too low: UP=$${upBook.bidDepth.toFixed(0)} DOWN=$${downBook.bidDepth.toFixed(0)}`);
    }

    // Calculate simulated bid prices
    const upOffset = params.useSymmetricPricing ? params.upBidOffset : params.upBidOffset;
    const downOffset = params.useSymmetricPricing ? params.upBidOffset : params.downBidOffset;
    const upBidPrice = Math.max(0.01, Math.round((upBook.midpoint - upOffset) * 100) / 100);
    const downBidPrice = Math.max(0.01, Math.round((downBook.midpoint - downOffset) * 100) / 100);
    const combinedCost = upBidPrice + downBidPrice;

    log(`  UP book: bid=${upBook.bestBid} ask=${upBook.bestAsk} mid=${upBook.midpoint.toFixed(3)}`);
    log(`  DOWN book: bid=${downBook.bestBid} ask=${downBook.bestAsk} mid=${downBook.midpoint.toFixed(3)}`);
    log(`  Sim bids: UP=${upBidPrice} DOWN=${downBidPrice} Combined=${combinedCost.toFixed(3)}`);
    log(`  Overround: ${(overround * 100).toFixed(1)}¢ | Arb margin: ${((1.0 - combinedCost) * 100).toFixed(1)}¢`);

    // Poll for fills
    let upFilled = false;
    let downFilled = false;
    let upFillTime: number | null = null;
    let downFillTime: number | null = null;
    let pollCount = 0;
    let nearMisses = 0;
    let bookSnapshots = 0;
    let upConsecutiveHits = 0;
    let downConsecutiveHits = 0;

    const exitTime = endTime - params.exitBeforeEndSeconds * 1000;

    while (Date.now() < exitTime) {
        // Stale chainlink check
        const priceAge = Date.now() - chainlink.getTimestamp();
        if (priceAge > 30000 && chainlink.getTimestamp() > 0) {
            log(`  [WARN] Chainlink price stale (${(priceAge / 1000).toFixed(0)}s old), skipping fill check`);
            await sleep(POLL_INTERVAL_MS);
            continue;
        }

        const upNow = await getFullBook(tokens.upToken);
        const downNow = await getFullBook(tokens.downToken);
        pollCount++;
        bookSnapshots += 2;

        // Check UP fill: best ask dropped to/below our bid
        if (!upFilled) {
            if (upNow.bestAsk <= upBidPrice + params.fillThresholdCents / 100) {
                upConsecutiveHits++;
                if (upConsecutiveHits >= 2) {
                    upFilled = true;
                    upFillTime = Date.now();
                    log(`  ** UP FILLED at ${upBidPrice} (ask=${upNow.bestAsk})`);
                }
            } else {
                if (upConsecutiveHits === 1) nearMisses++;
                upConsecutiveHits = 0;
            }
        }

        // Check DOWN fill
        if (!downFilled) {
            if (downNow.bestAsk <= downBidPrice + params.fillThresholdCents / 100) {
                downConsecutiveHits++;
                if (downConsecutiveHits >= 2) {
                    downFilled = true;
                    downFillTime = Date.now();
                    log(`  ** DOWN FILLED at ${downBidPrice} (ask=${downNow.bestAsk})`);
                }
            } else {
                if (downConsecutiveHits === 1) nearMisses++;
                downConsecutiveHits = 0;
            }
        }

        // Cancel on single fill
        if (params.cancelOnSingleFill && (upFilled !== downFilled) && (upFilled || downFilled)) {
            log(`  Single fill detected, cancelling other side per params`);
            break;
        }

        // Both filled — no need to keep polling
        if (upFilled && downFilled) {
            log(`  Both sides filled!`);
            break;
        }

        await sleep(POLL_INTERVAL_MS);
    }

    // Wait for resolution
    const msUntilEnd = endTime - Date.now();
    if (msUntilEnd > 0) {
        log(`  Waiting ${(msUntilEnd / 1000).toFixed(0)}s for market to end...`);
        await sleepWithHealthCheck(msUntilEnd, chainlink);
    }

    // Primary resolution: Chainlink close vs open price (instant, no API lag)
    let outcome = resolveFromChainlink(market, chainlink, openPrice);
    if (outcome === 'UNKNOWN') {
        // Fallback: wait for Gamma API to update (can take 1-3 minutes)
        log(`  Chainlink resolution unclear, waiting 90s for Gamma API...`);
        await sleep(90000);
        outcome = await resolveOutcome(slug);
    }
    log(`  Outcome: ${outcome}`);

    // Calculate P&L
    let pnlCents = 0;
    const shares = params.sharesPerSide * params.partialFillRatio;

    if (upFilled && downFilled) {
        // Both filled: guaranteed profit = (1.00 - combinedCost) * shares
        pnlCents = (1.0 - combinedCost) * shares * 100;
        log(`  BOTH FILL P&L: +${pnlCents.toFixed(1)}¢`);
    } else if (upFilled && !downFilled) {
        // Single UP fill: depends on resolution
        if (outcome === 'UP') {
            pnlCents = (1.0 - upBidPrice) * shares * 100;
        } else if (outcome === 'DOWN') {
            pnlCents = -upBidPrice * shares * 100;
        }
        log(`  SINGLE UP fill P&L: ${pnlCents.toFixed(1)}¢`);
    } else if (downFilled && !upFilled) {
        if (outcome === 'DOWN') {
            pnlCents = (1.0 - downBidPrice) * shares * 100;
        } else if (outcome === 'UP') {
            pnlCents = -downBidPrice * shares * 100;
        }
        log(`  SINGLE DOWN fill P&L: ${pnlCents.toFixed(1)}¢`);
    } else {
        log(`  NO FILLS`);
    }

    return {
        slug,
        startTime: endTime - 300000,
        endTime,
        upBestBid: upBook.bestBid,
        upBestAsk: upBook.bestAsk,
        downBestBid: downBook.bestBid,
        downBestAsk: downBook.bestAsk,
        overround,
        upBidPrice,
        downBidPrice,
        combinedCost,
        upFilled,
        downFilled,
        upFillTime,
        downFillTime,
        outcome,
        pnlCents,
        skipped: false,
        pollCount,
        nearMisses,
        bookSnapshots,
    };
}

function makeSkippedResult(reason: string): MarketResult {
    log(`  SKIP: ${reason}`);
    return {
        slug: '', startTime: Date.now(), endTime: Date.now(),
        upBestBid: 0, upBestAsk: 0, downBestBid: 0, downBestAsk: 0,
        overround: 0, upBidPrice: 0, downBidPrice: 0, combinedCost: 0,
        upFilled: false, downFilled: false, upFillTime: null, downFillTime: null,
        outcome: 'UNKNOWN', pnlCents: 0, skipped: true, skipReason: reason,
        pollCount: 0, nearMisses: 0, bookSnapshots: 0,
    };
}

function summarize(markets: MarketResult[], startTime: number): DryRunSummary {
    const traded = markets.filter((m) => !m.skipped);
    const bothFills = traded.filter((m) => m.upFilled && m.downFilled);
    const singleFills = traded.filter((m) => (m.upFilled || m.downFilled) && !(m.upFilled && m.downFilled));
    const noFills = traded.filter((m) => !m.upFilled && !m.downFilled);

    let runningPnl = 0;
    let maxDrawdown = 0;
    let peak = 0;
    let singleFillLoss = 0;

    for (const m of traded) {
        runningPnl += m.pnlCents;
        if (runningPnl > peak) peak = runningPnl;
        const dd = peak - runningPnl;
        if (dd > maxDrawdown) maxDrawdown = dd;
        if ((m.upFilled !== m.downFilled) && m.pnlCents < 0) {
            singleFillLoss += Math.abs(m.pnlCents);
        }
    }

    const overrounds = traded.filter((m) => m.overround > 0).map((m) => m.overround);
    const avgOverround = overrounds.length > 0 ? overrounds.reduce((a, b) => a + b, 0) / overrounds.length : 0;

    return {
        startTime,
        endTime: Date.now(),
        durationMinutes: (Date.now() - startTime) / 60000,
        marketsTraded: traded.length,
        marketsSkipped: markets.length - traded.length,
        bothFills: bothFills.length,
        singleFills: singleFills.length,
        noFills: noFills.length,
        bothFillRate: traded.length > 0 ? bothFills.length / traded.length : 0,
        netPnlCents: runningPnl,
        maxDrawdownCents: maxDrawdown,
        singleFillLossCents: singleFillLoss,
        avgOverround,
    };
}

// --- Main ---

async function main() {
    const durationArg = process.argv.indexOf('--duration');
    const durationMinutes = durationArg !== -1 ? parseInt(process.argv[durationArg + 1] || '30') : 30;

    log(`\n=== BTC 5-Min Arb Bot (DRY RUN) ===`);
    log(`Duration: ${durationMinutes} minutes`);
    log(`Params: ${JSON.stringify(PARAMS, null, 2)}`);

    const chainlink = new ChainlinkFeed();
    await chainlink.connect((price) => {
        // silent — just keeping the feed alive
    });

    // Wait for first price
    for (let i = 0; i < 10 && chainlink.getPrice() === 0; i++) {
        await sleep(1000);
    }
    log(`Chainlink BTC: $${chainlink.getPrice().toFixed(2)}`);

    const startTime = Date.now();
    const endTime = startTime + durationMinutes * 60 * 1000;
    // Hard timeout: 10 min past expected end (safety net for hangs)
    const hardTimeout = setTimeout(() => {
        log(`[FATAL] Hard timeout reached, forcing exit`);
        chainlink.disconnect();
        const summary = summarize(markets, startTime);
        const result: DryRunResult = { params: PARAMS, markets, summary };
        console.log(JSON.stringify(result));
        process.exit(0);
    }, (durationMinutes + 10) * 60 * 1000);

    const markets: MarketResult[] = [];
    let consecutiveApiFailures = 0;

    while (Date.now() < endTime) {
        // Check Chainlink health — if stale > 2 min, feed is dead
        if (chainlink.getTimestamp() > 0 && Date.now() - chainlink.getTimestamp() > 120000) {
            log(`[WARN] Chainlink feed dead (${((Date.now() - chainlink.getTimestamp()) / 1000).toFixed(0)}s stale), ending early`);
            break;
        }

        const result = await runOneMarket(PARAMS, chainlink);
        markets.push(result);

        if (result.skipped && result.skipReason?.includes('No market')) {
            consecutiveApiFailures++;
            if (consecutiveApiFailures >= 5) {
                log(`[WARN] 5 consecutive API failures, ending early`);
                break;
            }
        } else {
            consecutiveApiFailures = 0;
        }

        // Wait for next 5-min boundary
        const now = Date.now();
        const nextBoundary = (Math.floor(now / 300000) + 1) * 300000;
        const waitMs = nextBoundary - now + 2000; // +2s buffer for market to appear
        if (waitMs > 0 && Date.now() + waitMs < endTime) {
            log(`\nWaiting ${(waitMs / 1000).toFixed(0)}s for next market...`);
            await sleepWithHealthCheck(waitMs, chainlink);
        }
    }

    clearTimeout(hardTimeout);

    chainlink.disconnect();

    const summary = summarize(markets, startTime);
    const result: DryRunResult = { params: PARAMS, markets, summary };

    log(`\n=== Summary ===`);
    log(`Markets: ${summary.marketsTraded} traded, ${summary.marketsSkipped} skipped`);
    log(`Fills: ${summary.bothFills} both, ${summary.singleFills} single, ${summary.noFills} none`);
    log(`P&L: ${summary.netPnlCents.toFixed(1)}¢ net | Max DD: ${summary.maxDrawdownCents.toFixed(1)}¢`);
    log(`Both-fill rate: ${(summary.bothFillRate * 100).toFixed(1)}%`);

    // Output JSON to stdout (captured by loop)
    console.log(JSON.stringify(result));

    // Force exit — ChainlinkFeed's onclose handler sets a reconnect timer
    // that keeps the event loop alive even after disconnect()
    process.exit(0);
}

main().catch((err) => {
    log('Fatal error:', err);
    process.exit(1);
});
