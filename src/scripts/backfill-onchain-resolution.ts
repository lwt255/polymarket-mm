/**
 * backfill-onchain-resolution.ts
 *
 * Corrects the resolution field in pricing-data.jsonl and pricing-data.raw.jsonl
 * by replacing Gamma API resolutions with on-chain payoutNumerators (the truth).
 *
 * Strategy:
 *   1. Deduplicate slugs (many records share the same slug across files)
 *   2. Batch-fetch conditionIds from Gamma API
 *   3. Batch-read on-chain payoutNumerators
 *   4. Rewrite files with corrected resolutions + recalculated simulatedTrades
 *
 * Usage:
 *   npx tsx src/scripts/backfill-onchain-resolution.ts [--dry-run]
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as readline from 'readline';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const GAMMA = 'https://gamma-api.polymarket.com';

const ctAbi = parseAbi([
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);

const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });

async function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// --- Step 1: Collect all unique slugs ---

async function collectSlugs(file: string): Promise<Set<string>> {
    const slugs = new Set<string>();
    if (!fs.existsSync(file)) return slugs;
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            if (r.slug) slugs.add(r.slug);
        } catch { /* skip */ }
    }
    return slugs;
}

// --- Step 2: Resolve all slugs on-chain ---

interface SlugResolution {
    onChainResolution: 'UP' | 'DOWN' | 'UNKNOWN';
    conditionId?: string;
}

async function resolveSlugOnChain(slug: string): Promise<SlugResolution> {
    // Get conditionId from Gamma
    let conditionId: `0x${string}` | null = null;
    let outcomes: string[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const resp = await fetch(`${GAMMA}/markets?slug=${slug}`);
            const data = await resp.json() as any[];
            if (data?.[0]) {
                conditionId = data[0].conditionId as `0x${string}`;
                outcomes = JSON.parse(data[0].outcomes || '[]');
                break;
            }
        } catch { /* retry */ }
        await sleep(1000);
    }

    if (!conditionId || outcomes.length === 0) {
        return { onChainResolution: 'UNKNOWN' };
    }

    // Check on-chain
    try {
        const den = await pub.readContract({
            address: CT_ADDRESS, abi: ctAbi,
            functionName: 'payoutDenominator', args: [conditionId],
        });

        if (Number(den) === 0) {
            return { onChainResolution: 'UNKNOWN', conditionId };
        }

        for (let i = 0; i < outcomes.length; i++) {
            const pn = await pub.readContract({
                address: CT_ADDRESS, abi: ctAbi,
                functionName: 'payoutNumerators', args: [conditionId, BigInt(i)],
            });
            if (pn > 0n) {
                return {
                    onChainResolution: outcomes[i].toUpperCase() as 'UP' | 'DOWN',
                    conditionId,
                };
            }
        }
    } catch { /* RPC error */ }

    return { onChainResolution: 'UNKNOWN', conditionId };
}

async function batchResolve(slugs: string[]): Promise<Map<string, SlugResolution>> {
    const results = new Map<string, SlugResolution>();
    const BATCH = 10;
    let done = 0;

    for (let i = 0; i < slugs.length; i += BATCH) {
        const batch = slugs.slice(i, i + BATCH);
        const batchResults = await Promise.all(batch.map(s => resolveSlugOnChain(s)));
        for (let j = 0; j < batch.length; j++) {
            results.set(batch[j], batchResults[j]);
        }
        done += batch.length;
        process.stdout.write(`\r  Resolved: ${done}/${slugs.length} (${(done / slugs.length * 100).toFixed(1)}%)`);
        if (i + BATCH < slugs.length) await sleep(300);
    }
    console.log();
    return results;
}

// --- Step 3: Rewrite files ---

const TAKER_FEE_RATE = 0.001;
const GAS_COST_CENTS = 100;

function recalcSimTrades(simulatedTrades: any[], newResolution: string): any[] {
    if (!simulatedTrades || newResolution === 'UNKNOWN') return simulatedTrades || [];

    return simulatedTrades.map((t: any) => {
        const won = t.side === newResolution;
        const payoutCents = won ? 100 : 0;
        const netPnlCents = payoutCents - t.totalCostCents;
        return { ...t, won, payoutCents, netPnlCents };
    });
}

async function rewriteFile(
    inputFile: string,
    outputFile: string,
    resolutions: Map<string, SlugResolution>,
    dryRun: boolean,
): Promise<{ total: number; changed: number; unknowns: number }> {
    if (!fs.existsSync(inputFile)) return { total: 0, changed: 0, unknowns: 0 };

    let total = 0, changed = 0, unknowns = 0;

    // For dry run, just count. For live, stream to a temp file then rename.
    const tmpFile = dryRun ? null : `${outputFile}.tmp-${Date.now()}`;
    const ws = tmpFile ? fs.createWriteStream(tmpFile) : null;

    const rl = readline.createInterface({ input: fs.createReadStream(inputFile) });
    for await (const line of rl) {
        if (!line.trim()) continue;
        try {
            const r = JSON.parse(line);
            total++;
            const res = resolutions.get(r.slug);

            if (!res || res.onChainResolution === 'UNKNOWN') {
                unknowns++;
                ws?.write(line + '\n');
                continue;
            }

            if (r.resolution !== res.onChainResolution) {
                changed++;
            }

            r.resolution = res.onChainResolution;
            if (r.simulatedTrades) {
                r.simulatedTrades = recalcSimTrades(r.simulatedTrades, res.onChainResolution);
            }

            ws?.write(JSON.stringify(r) + '\n');
        } catch {
            ws?.write(line + '\n');
        }
    }

    if (ws) {
        await new Promise<void>((resolve) => ws.end(resolve));

        // Backup original
        const backupFile = `${inputFile}.pre-onchain-fix-${Date.now()}.bak`;
        fs.copyFileSync(inputFile, backupFile);
        console.log(`  Backed up: ${backupFile}`);

        // Rename tmp to output
        fs.renameSync(tmpFile!, outputFile);
    }

    return { total, changed, unknowns };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');

    console.log(`=== BACKFILL ON-CHAIN RESOLUTION ===`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE (will rewrite files)'}\n`);

    // Step 1: Collect all unique slugs across both files
    console.log('Step 1: Collecting unique slugs...');
    const slugsA = await collectSlugs('pricing-data.jsonl');
    const slugsB = await collectSlugs('pricing-data.raw.jsonl');
    const allSlugs = new Set([...slugsA, ...slugsB]);
    console.log(`  pricing-data.jsonl: ${slugsA.size} unique slugs`);
    console.log(`  pricing-data.raw.jsonl: ${slugsB.size} unique slugs`);
    console.log(`  Combined unique: ${allSlugs.size} slugs\n`);

    // Step 2: Resolve all slugs on-chain
    console.log('Step 2: Resolving on-chain (this will take a few minutes)...');
    const slugList = [...allSlugs];
    const resolutions = await batchResolve(slugList);

    // Stats
    let resolved = 0, unknown = 0;
    for (const [, r] of resolutions) {
        if (r.onChainResolution !== 'UNKNOWN') resolved++;
        else unknown++;
    }
    console.log(`  Resolved: ${resolved}, Unknown: ${unknown}\n`);

    // Step 3: Rewrite files
    console.log('Step 3: Rewriting files with on-chain truth...');

    const statsMain = await rewriteFile('pricing-data.jsonl', 'pricing-data.jsonl', resolutions, dryRun);
    console.log(`  pricing-data.jsonl: ${statsMain.total} records, ${statsMain.changed} resolutions changed, ${statsMain.unknowns} unknown`);

    const statsRaw = await rewriteFile('pricing-data.raw.jsonl', 'pricing-data.raw.jsonl', resolutions, dryRun);
    console.log(`  pricing-data.raw.jsonl: ${statsRaw.total} records, ${statsRaw.changed} resolutions changed, ${statsRaw.unknowns} unknown`);

    console.log(`\n=== SUMMARY ===`);
    console.log(`Total resolutions corrected: ${statsMain.changed + statsRaw.changed}`);
    console.log(`Correction rate: ${((statsMain.changed / statsMain.total) * 100).toFixed(1)}% of strategy-grade records`);

    if (dryRun) {
        console.log(`\nThis was a DRY RUN. Re-run without --dry-run to apply changes.`);
    } else {
        console.log(`\nFiles rewritten with on-chain truth. Originals backed up as .bak files.`);
        console.log(`You can now re-run strategy analysis on the corrected data.`);
    }
}

main().catch(e => console.error(e));
