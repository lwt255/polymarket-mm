/**
 * verify-collector-resolution.ts
 *
 * Verifies collector resolution data against on-chain payoutNumerators (the only truth).
 * Takes a random sample of collector records and checks each one on-chain.
 *
 * Usage:
 *   npx tsx src/scripts/verify-collector-resolution.ts [--sample 50] [--wins-only] [--recent 24h]
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

interface CollectorRecord {
    slug: string;
    resolution: string;       // "UP" | "DOWN" | "UNKNOWN"
    chainlinkMoveDollars: number;
    collectedAt: string;
    marketEnd: number;
}

interface VerifyResult {
    slug: string;
    collectorResolution: string;
    chainlinkResolution: string;
    onChainResolution: string;  // "UP" | "DOWN" | "NOT_RESOLVED" | "ERROR"
    match: boolean;
    collectedAt: string;
    onChainPayouts: string;     // e.g. "UP=1000000 DOWN=0"
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

async function loadRecords(winsOnly: boolean, recentHours: number | null): Promise<CollectorRecord[]> {
    const records: CollectorRecord[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(DATA_FILE) });
    const cutoff = recentHours ? Date.now() - recentHours * 3600_000 : 0;

    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (r.resolution === 'UNKNOWN') continue;
            if (winsOnly && r.resolution !== 'UP' && r.resolution !== 'DOWN') continue;
            if (recentHours && new Date(r.collectedAt).getTime() < cutoff) continue;
            records.push({
                slug: r.slug,
                resolution: r.resolution,
                chainlinkMoveDollars: r.chainlinkMoveDollars,
                collectedAt: r.collectedAt,
                marketEnd: r.marketEnd,
            });
        } catch { /* skip bad lines */ }
    }
    return records;
}

async function verifyOnChain(slug: string, collectorRes: string, clMove: number): Promise<VerifyResult> {
    const clResolution = clMove >= 0 ? 'UP' : 'DOWN';
    const base: Omit<VerifyResult, 'onChainResolution' | 'match' | 'onChainPayouts'> = {
        slug,
        collectorResolution: collectorRes,
        chainlinkResolution: clResolution,
        collectedAt: '',
    };

    try {
        // Fetch market from Gamma to get conditionId
        const resp = await fetch(`${GAMMA}/markets?slug=${slug}`);
        const data = await resp.json() as any[];
        if (!data?.[0]) {
            return { ...base, onChainResolution: 'ERROR', match: false, onChainPayouts: 'market not found in API' };
        }

        const m = data[0];
        const conditionId = m.conditionId as `0x${string}`;
        const outcomes: string[] = JSON.parse(m.outcomes || '[]');

        // Check on-chain resolution
        const den = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutDenominator', args: [conditionId] });

        if (Number(den) === 0) {
            return { ...base, onChainResolution: 'NOT_RESOLVED', match: false, onChainPayouts: 'denominator=0' };
        }

        // Get payout numerators for each outcome
        const payouts: { outcome: string; numerator: bigint }[] = [];
        for (let i = 0; i < outcomes.length; i++) {
            const pn = await pub.readContract({ address: CT, abi: ctAbi, functionName: 'payoutNumerators', args: [conditionId, BigInt(i)] });
            payouts.push({ outcome: outcomes[i], numerator: pn });
        }

        const payoutStr = payouts.map(p => `${p.outcome}=${p.numerator.toString()}`).join(' ');
        const winner = payouts.find(p => p.numerator > 0n);
        const onChainRes = winner ? winner.outcome.toUpperCase() : 'UNKNOWN';

        return {
            ...base,
            onChainResolution: onChainRes,
            match: collectorRes.toUpperCase() === onChainRes,
            onChainPayouts: payoutStr,
        };
    } catch (err: any) {
        return { ...base, onChainResolution: 'ERROR', match: false, onChainPayouts: err.message?.slice(0, 100) || 'unknown error' };
    }
}

async function main() {
    const args = process.argv.slice(2);
    const sampleSize = parseInt(args.find((_, i, a) => a[i - 1] === '--sample') || '100');
    const winsOnly = args.includes('--wins-only');
    const recentArg = args.find((_, i, a) => a[i - 1] === '--recent');
    const recentHours = recentArg ? parseInt(recentArg) : null;

    console.log(`=== COLLECTOR RESOLUTION VERIFIER ===`);
    console.log(`Sample size: ${sampleSize}, Wins only: ${winsOnly}, Recent: ${recentHours ? recentHours + 'h' : 'all'}\n`);

    console.log('Loading collector records...');
    const allRecords = await loadRecords(winsOnly, recentHours);
    console.log(`Found ${allRecords.length} records with resolution\n`);

    // Random sample
    const sample = shuffleArray(allRecords).slice(0, sampleSize);
    console.log(`Verifying ${sample.length} records against on-chain truth...\n`);

    const results: VerifyResult[] = [];
    let done = 0;

    // Process in batches to avoid rate limits
    const BATCH = 5;
    for (let i = 0; i < sample.length; i += BATCH) {
        const batch = sample.slice(i, i + BATCH);
        const batchResults = await Promise.all(
            batch.map(r => verifyOnChain(r.slug, r.resolution, r.chainlinkMoveDollars))
        );
        results.push(...batchResults);
        done += batch.length;
        process.stdout.write(`\r  Progress: ${done}/${sample.length}`);
        if (i + BATCH < sample.length) await sleep(500); // rate limit courtesy
    }
    console.log('\n');

    // --- Analysis ---
    const resolved = results.filter(r => r.onChainResolution !== 'NOT_RESOLVED' && r.onChainResolution !== 'ERROR');
    const notResolved = results.filter(r => r.onChainResolution === 'NOT_RESOLVED');
    const errors = results.filter(r => r.onChainResolution === 'ERROR');
    const matches = resolved.filter(r => r.match);
    const mismatches = resolved.filter(r => !r.match);

    console.log(`=== RESULTS ===`);
    console.log(`Total checked:     ${results.length}`);
    console.log(`On-chain resolved: ${resolved.length}`);
    console.log(`Not resolved yet:  ${notResolved.length}`);
    console.log(`Errors:            ${errors.length}`);
    console.log();
    console.log(`MATCHES (collector correct):   ${matches.length}/${resolved.length} (${(matches.length / resolved.length * 100).toFixed(1)}%)`);
    console.log(`MISMATCHES (collector WRONG):   ${mismatches.length}/${resolved.length} (${(mismatches.length / resolved.length * 100).toFixed(1)}%)`);
    console.log();

    if (mismatches.length > 0) {
        console.log(`=== MISMATCHES (collector said X, on-chain says Y) ===`);
        // Analyze mismatch direction
        let collectorSaidUp_actuallyDown = 0;
        let collectorSaidDown_actuallyUp = 0;
        for (const m of mismatches) {
            console.log(`  ${m.slug}: collector=${m.collectorResolution} onchain=${m.onChainResolution} cl=${m.chainlinkResolution} payouts=[${m.onChainPayouts}]`);
            if (m.collectorResolution === 'UP' && m.onChainResolution === 'DOWN') collectorSaidUp_actuallyDown++;
            if (m.collectorResolution === 'DOWN' && m.onChainResolution === 'UP') collectorSaidDown_actuallyUp++;
        }
        console.log();
        console.log(`Mismatch direction:`);
        console.log(`  Collector said UP, actually DOWN:   ${collectorSaidUp_actuallyDown}`);
        console.log(`  Collector said DOWN, actually UP:   ${collectorSaidDown_actuallyUp}`);
    }

    // --- Strategy impact analysis ---
    // For underdog strategy: we buy the underdog. If the collector says the underdog won but
    // on-chain says it lost, that's a false win. If collector says favorite won but on-chain
    // says underdog won, that's a missed win.
    console.log(`\n=== STRATEGY IMPACT ===`);
    console.log(`If the collector's ${(mismatches.length / resolved.length * 100).toFixed(1)}% error rate is systematic:`);

    // Recalculate what the win rate would be with on-chain truth
    // For this we need to know which side was the underdog for each record
    // We don't have that in this sample directly, but we can estimate:
    // The collector says X won. If that's wrong, a trade that was marked "win" is actually a loss.
    const collectorWinCount = resolved.length; // all have resolutions
    const falseWins = mismatches.length; // these were wrong
    console.log(`Out of ${resolved.length} resolved records checked:`);
    console.log(`  ${matches.length} collector resolutions are CORRECT`);
    console.log(`  ${mismatches.length} collector resolutions are WRONG`);
    console.log(`  Error rate: ${(mismatches.length / resolved.length * 100).toFixed(1)}%`);
    console.log();

    if (mismatches.length > 0) {
        console.log(`⚠️  The collector's resolution is UNRELIABLE.`);
        console.log(`   All strategy analysis based on collector resolutions is suspect.`);
        console.log(`   The claimed 46% win rate needs recalculation with on-chain truth.`);
    } else {
        console.log(`✓  Collector resolutions match on-chain truth for this sample.`);
        console.log(`   The resolution data appears reliable.`);
    }

    // Also check Chainlink vs on-chain
    const clMatches = resolved.filter(r => {
        const cl = r.chainlinkResolution;
        return cl === r.onChainResolution;
    });
    console.log(`\n=== CHAINLINK vs ON-CHAIN ===`);
    console.log(`CL matches on-chain:  ${clMatches.length}/${resolved.length} (${(clMatches.length / resolved.length * 100).toFixed(1)}%)`);
    console.log(`CL mismatches:        ${resolved.length - clMatches.length}/${resolved.length} (${((resolved.length - clMatches.length) / resolved.length * 100).toFixed(1)}%)`);

    // Print errors if any
    if (errors.length > 0) {
        console.log(`\n=== ERRORS ===`);
        for (const e of errors.slice(0, 10)) {
            console.log(`  ${e.slug}: ${e.onChainPayouts}`);
        }
    }
    if (notResolved.length > 0) {
        console.log(`\n=== NOT RESOLVED ON-CHAIN (${notResolved.length}) ===`);
        for (const nr of notResolved.slice(0, 5)) {
            console.log(`  ${nr.slug}`);
        }
        if (notResolved.length > 5) console.log(`  ... and ${notResolved.length - 5} more`);
    }
}

main().catch(e => console.error(e));
