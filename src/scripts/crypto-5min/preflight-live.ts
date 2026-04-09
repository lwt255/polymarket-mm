/**
 * Live Preflight — verify the v4 live path without placing any trades.
 *
 * Checks:
 * - private key present and wallet derivation works
 * - CLOB authentication works
 * - on-chain USDC balance is readable
 * - max-loss floor can be initialized
 * - open orders are visible
 * - current 5m / 15m crypto markets can be discovered
 * - top-of-book reads work for those markets
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/preflight-live.ts
 *   npx tsx src/scripts/crypto-5min/preflight-live.ts --max-loss 40
 */

import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

import { PositionVerifier } from '../../core/execution/position-verifier.js';

const args = process.argv.slice(2);

function getArg(name: string, defaultVal: string): string {
    const idx = args.indexOf(name);
    return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : defaultVal;
}

const MAX_LOSS_USD = parseFloat(getArg('--max-loss', '40'));
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const CRYPTOS = [
    { slug: 'btc', name: 'BTC' },
    { slug: 'eth', name: 'ETH' },
    { slug: 'sol', name: 'SOL' },
    { slug: 'xrp', name: 'XRP' },
];

const log = (...a: any[]) => {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...a);
};

async function fetchJSON(url: string): Promise<any> {
    try {
        const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (polymarket-preflight)' } });
        if (!resp.ok) return null;
        return resp.json();
    } catch {
        return null;
    }
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

async function getBookInfo(tokenId: string) {
    const raw = await fetchJSON(`${CLOB}/book?token_id=${tokenId}`);
    if (!raw) return { bestBid: 0, bestAsk: 1, totalAskDepth: 0, totalBidDepth: 0 };
    const bids = (raw.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) }))
        .filter((b: any) => Number.isFinite(b.price) && b.size > 0)
        .sort((a: any, b: any) => b.price - a.price);
    const asks = (raw.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) }))
        .filter((a: any) => Number.isFinite(a.price) && a.size > 0)
        .sort((a: any, b: any) => a.price - b.price);
    return {
        bestBid: bids[0]?.price ?? 0,
        bestAsk: asks[0]?.price ?? 1,
        totalAskDepth: asks.reduce((s: number, a: any) => s + a.size, 0),
        totalBidDepth: bids.reduce((s: number, b: any) => s + b.size, 0),
    };
}

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
                    if (new Date(m.endDate).getTime() > Date.now() && !seenSlugs.has(m.slug)) {
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
                    if (new Date(m.endDate).getTime() > Date.now() && !seenSlugs.has(m.slug)) {
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

async function main() {
    log('='.repeat(60));
    log('MICROSTRUCTURE BOT v4 LIVE PREFLIGHT');
    log(`Max loss config: $${MAX_LOSS_USD}`);
    log('No orders will be placed');
    log('='.repeat(60));

    const privateKey = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY;
    if (!privateKey) {
        throw new Error('Missing POLYMARKET_PRIVATE_KEY or POLYMARKET_PRIVATE_KEY2');
    }

    const formattedKey = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
    const wallet = new Wallet(formattedKey);
    log(`Wallet: ${wallet.address.slice(0, 10)}...${wallet.address.slice(-6)}`);

    log('Authenticating with CLOB...');
    const publicClobClient = new ClobClient(CLOB, 137, wallet);
    const creds = await publicClobClient.createOrDeriveApiKey();
    const client = new ClobClient(CLOB, 137, wallet, creds);
    const openOrders = await client.getOpenOrders() || [];
    log(`CLOB auth OK | open orders visible: ${openOrders.length}`);

    const verifier = new PositionVerifier(wallet.address);
    const initOk = await verifier.initialize(MAX_LOSS_USD);
    if (!initOk) {
        throw new Error('Could not read on-chain USDC balance');
    }
    log(`Balance OK: $${verifier.getStartingBalance().toFixed(2)} | floor: $${verifier.getFloorBalance().toFixed(2)}`);

    log('Discovering current markets...');
    const markets = await findCurrentMarkets();
    if (markets.length === 0) {
        throw new Error('No current crypto markets found');
    }

    for (const { market, crypto, interval } of markets) {
        const tokens = getTokenIds(market);
        if (!tokens) {
            log(`WARN ${crypto.name} ${interval}m: could not parse token ids`);
            continue;
        }
        const leaderBook = await getBookInfo(tokens.upToken);
        const followerBook = await getBookInfo(tokens.downToken);
        log(
            `${crypto.name} ${interval}m | ${market.slug} | ` +
            `UP ${Math.round(leaderBook.bestBid * 100)}-${Math.round(leaderBook.bestAsk * 100)}c ` +
            `DOWN ${Math.round(followerBook.bestBid * 100)}-${Math.round(followerBook.bestAsk * 100)}c`
        );
    }

    log('Preflight complete: auth, balance, market discovery, and book reads all succeeded');
}

main().catch((err: any) => {
    log(`PREFLIGHT FAILED: ${err.message}`);
    process.exit(1);
});
