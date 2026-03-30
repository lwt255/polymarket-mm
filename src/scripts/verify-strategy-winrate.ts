/**
 * verify-strategy-winrate.ts
 *
 * The definitive test: recalculate the underdog strategy win rate using on-chain truth.
 * Takes collector records that had T-30 underdog trades and checks whether
 * the strategy actually wins when on-chain payoutNumerators are used.
 *
 * Usage:
 *   npx tsx src/scripts/verify-strategy-winrate.ts [--sample 200] [--filter prev-match]
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as readline from 'readline';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const GAMMA = 'https://gamma-api.polymarket.com';
const DATA_FILE = 'pricing-data.jsonl';

const ctAbi = parseAbi([
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);

const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

interface FullRecord {
    slug: string;
    resolution: string;
    chainlinkMoveDollars: number;
    collectedAt: string;
    marketEnd: number;
    snapshots: any[];
    simulatedTrades: any[];
}

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function shuffleArray<T>(arr: T[]): T[] {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

async function loadRecords(filterPrevMatch: boolean): Promise<FullRecord[]> {
    const records: FullRecord[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE) });

    // For prev-match filter, we need to track previous resolutions per crypto
    const prevRes: Record<string, string> = {};

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (r.resolution === 'UNKNOWN') continue;

            // Extract crypto from slug (e.g. "btc" from "btc-updown-5m-...")
            const crypto = r.slug.split('-')[0];

            // Find T-30 snapshot
            const t30Snap = r.snapshots?.find((s: any) =>
                s.secondsBeforeEnd >= 25 && s.secondsBeforeEnd <= 35
            );
            if (!t30Snap) { prevRes[crypto] = r.resolution; continue; }

            // Must be two-sided (both sides have asks)
            const hasUpAsk = t30Snap.upAsk > 0 && t30Snap.upAsk < 1;
            const hasDownAsk = t30Snap.downAsk > 0 && t30Snap.downAsk < 1;
            if (!hasUpAsk || !hasDownAsk) { prevRes[crypto] = r.resolution; continue; }

            // Identify underdog at T-30
            const upIsUnderdog = t30Snap.upAsk < t30Snap.downAsk;
            const underdogSide = upIsUnderdog ? 'UP' : 'DOWN';
            const underdogAsk = upIsUnderdog ? t30Snap.upAsk : t30Snap.downAsk;

            // Underdog must be cheap enough (2-50 cents)
            if (underdogAsk < 0.02 || underdogAsk > 0.50) { prevRes[crypto] = r.resolution; continue; }

            // Prev-match filter: previous resolution must match underdog side
            if (filterPrevMatch) {
                const prev = prevRes[crypto];
                if (prev !== underdogSide) {
                    prevRes[crypto] = r.resolution;
                    continue;
                }
            }

            records.push({
                slug: r.slug,
                resolution: r.resolution,
                chainlinkMoveDollars: r.chainlinkMoveDollars,
                collectedAt: r.collectedAt,
                marketEnd: r.marketEnd,
                snapshots: [t30Snap], // just keep the relevant snapshot
                simulatedTrades: [{ side: underdogSide, entryAsk: underdogAsk }],
            });

            prevRes[crypto] = r.resolution;
        } catch { /* skip */ }
    }
    return records;
}

async function getOnChainResolution(slug: string): Promise<string> {
    try {
        const resp = await fetch(`${GAMMA}/markets?slug=${slug}`);
        const data = await resp.json() as any[];
        if (!data?.[0]) return 'ERROR';

        const conditionId = data[0].conditionId as `0x${string}`;
        const outcomes: string[] = JSON.parse(data[0].outcomes || '[]');

        const den = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutDenominator', args: [conditionId] });
        if (Number(den) === 0) return 'NOT_RESOLVED';

        for (let i = 0; i < outcomes.length; i++) {
            const pn = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutNumerators', args: [conditionId, BigInt(i)] });
            if (pn > 0n) return outcomes[i].toUpperCase();
        }
        return 'UNKNOWN';
    } catch {
        return 'ERROR';
    }
}

async function main() {
    const args = process.argv.slice(2);
    const sampleSize = parseInt(args.find((_, i, a) => a[i - 1] === '--sample') || '200');
    const filterPrevMatch = args.includes('--filter') && args.includes('prev-match');

    console.log(`=== STRATEGY WIN RATE VERIFIER (On-Chain Truth) ===`);
    console.log(`Sample: ${sampleSize}, Prev-match filter: ${filterPrevMatch}\n`);

    console.log('Loading qualifying trades from collector...');
    const allRecords = await loadRecords(filterPrevMatch);
    console.log(`Found ${allRecords.length} qualifying T-30 underdog trades\n`);

    const sample = shuffleArray(allRecords).slice(0, sampleSize);
    console.log(`Verifying ${sample.length} trades against on-chain truth...\n`);

    // Track results
    let collectorWins = 0, collectorLosses = 0;
    let onChainWins = 0, onChainLosses = 0;
    let falseWins = 0, missedWins = 0;
    let resolved = 0, skipped = 0;

    // PnL tracking
    let collectorPnlCents = 0, onChainPnlCents = 0;

    // Price bucket analysis
    const buckets: Record<string, { collWins: number; collTotal: number; ocWins: number; ocTotal: number }> = {
        '2-10c': { collWins: 0, collTotal: 0, ocWins: 0, ocTotal: 0 },
        '10-20c': { collWins: 0, collTotal: 0, ocWins: 0, ocTotal: 0 },
        '20-35c': { collWins: 0, collTotal: 0, ocWins: 0, ocTotal: 0 },
        '35-50c': { collWins: 0, collTotal: 0, ocWins: 0, ocTotal: 0 },
    };

    function getBucket(ask: number): string {
        if (ask < 0.10) return '2-10c';
        if (ask < 0.20) return '10-20c';
        if (ask < 0.35) return '20-35c';
        return '35-50c';
    }

    const BATCH = 5;
    for (let i = 0; i < sample.length; i += BATCH) {
        const batch = sample.slice(i, i + BATCH);
        const results = await Promise.all(batch.map(async (r) => {
            const ocRes = await getOnChainResolution(r.slug);
            return { record: r, ocRes };
        }));

        for (const { record: r, ocRes } of results) {
            if (ocRes === 'ERROR' || ocRes === 'NOT_RESOLVED' || ocRes === 'UNKNOWN') {
                skipped++;
                continue;
            }
            resolved++;

            const underdogSide = r.simulatedTrades[0].side;
            const entryAsk = r.simulatedTrades[0].entryAsk;
            const bucket = getBucket(entryAsk);
            const entryCents = entryAsk * 100;
            const payoutCents = 100; // $1 per share

            // Collector says...
            const collectorWon = underdogSide === r.resolution;
            if (collectorWon) collectorWins++; else collectorLosses++;
            collectorPnlCents += collectorWon ? (payoutCents - entryCents) : -entryCents;
            buckets[bucket].collTotal++;
            if (collectorWon) buckets[bucket].collWins++;

            // On-chain says...
            const onChainWon = underdogSide === ocRes;
            if (onChainWon) onChainWins++; else onChainLosses++;
            onChainPnlCents += onChainWon ? (payoutCents - entryCents) : -entryCents;
            buckets[bucket].ocTotal++;
            if (onChainWon) buckets[bucket].ocWins++;

            // Track mismatches
            if (collectorWon && !onChainWon) falseWins++;
            if (!collectorWon && onChainWon) missedWins++;
        }

        process.stdout.write(`\r  Progress: ${Math.min(i + BATCH, sample.length)}/${sample.length} (${resolved} resolved, ${skipped} skipped)`);
        if (i + BATCH < sample.length) await sleep(500);
    }

    console.log('\n');

    // --- Report ---
    console.log(`=== SAMPLE RESULTS ===`);
    console.log(`Resolved: ${resolved}, Skipped: ${skipped}\n`);

    console.log(`           COLLECTOR        ON-CHAIN (TRUTH)`);
    console.log(`Wins:      ${collectorWins}               ${onChainWins}`);
    console.log(`Losses:    ${collectorLosses}             ${onChainLosses}`);
    console.log(`Win rate:  ${(collectorWins / resolved * 100).toFixed(1)}%            ${(onChainWins / resolved * 100).toFixed(1)}%`);
    console.log(`PnL/trade: ${(collectorPnlCents / resolved).toFixed(1)}¢           ${(onChainPnlCents / resolved).toFixed(1)}¢`);
    console.log(`Total PnL: ${(collectorPnlCents / 100).toFixed(2)}          ${(onChainPnlCents / 100).toFixed(2)}`);
    console.log();
    console.log(`False wins (collector=W, chain=L): ${falseWins}`);
    console.log(`Missed wins (collector=L, chain=W): ${missedWins}`);
    console.log(`Net error impact: ${falseWins - missedWins} phantom wins removed`);

    console.log(`\n=== PRICE BUCKET ANALYSIS ===`);
    console.log(`Bucket     Coll WR%    OnChain WR%   Coll N   OC N`);
    for (const [name, b] of Object.entries(buckets)) {
        if (b.ocTotal === 0) continue;
        console.log(`${name.padEnd(10)} ${(b.collWins / b.collTotal * 100).toFixed(1).padStart(6)}%     ${(b.ocWins / b.ocTotal * 100).toFixed(1).padStart(6)}%     ${String(b.collTotal).padStart(5)}  ${String(b.ocTotal).padStart(5)}`);
    }

    console.log(`\n=== VERDICT ===`);
    const onChainWR = onChainWins / resolved * 100;
    const collWR = collectorWins / resolved * 100;
    const wrDiff = collWR - onChainWR;

    if (onChainPnlCents > 0) {
        console.log(`✓ Strategy is STILL PROFITABLE with on-chain truth.`);
        console.log(`  Win rate drops from ${collWR.toFixed(1)}% to ${onChainWR.toFixed(1)}% (${wrDiff.toFixed(1)}pp inflation).`);
        console.log(`  PnL/trade: $${(onChainPnlCents / resolved / 100).toFixed(2)}`);
    } else {
        console.log(`✗ Strategy is NOT PROFITABLE with on-chain truth.`);
        console.log(`  Win rate drops from ${collWR.toFixed(1)}% to ${onChainWR.toFixed(1)}% (${wrDiff.toFixed(1)}pp inflation).`);
        console.log(`  PnL/trade: -$${Math.abs(onChainPnlCents / resolved / 100).toFixed(2)}`);
        console.log(`  THE EDGE DOES NOT EXIST. The collector's resolution errors created a phantom edge.`);
    }
}

main().catch(e => console.error(e));
