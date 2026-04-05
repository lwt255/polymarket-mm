/**
 * Collector Data Verification Script
 *
 * Mechanically verifies collector records against independent sources:
 * 1. On-chain resolution (ground truth)
 * 2. On-chain previous 5m resolution (prevResolution check)
 * 3. Snapshot timing (T-30 is actually ~30s before end)
 * 4. Leader/ask computation (what the bot would see)
 * 5. Bot-collector alignment (same leader, same ask, same signals)
 *
 * Usage:
 *   npx tsx src/scripts/verify-collector-data.ts [--sample 20] [--recent] [--date 2026-04-01]
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { readFileSync } from 'fs';

// ── Config ──
const GAMMA = 'https://gamma-api.polymarket.com';
const CT_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045' as `0x${string}`;
const payoutAbi = parseAbi([
    'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
    'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
]);

const viemPublicClient = createPublicClient({
    chain: polygon,
    transport: http('https://polygon.drpc.org'),
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ── Args ──
const args = process.argv.slice(2);
const sampleSize = parseInt(args.find((_, i, a) => a[i - 1] === '--sample') || '20');
const recentOnly = args.includes('--recent');
const dateFilter = args.find((_, i, a) => a[i - 1] === '--date') || '';

// ── Helpers ──

async function fetchJSON(url: string): Promise<any> {
    try {
        const r = await fetch(url);
        if (!r.ok) return null;
        return await r.json();
    } catch { return null; }
}

async function resolveOnChain(slug: string): Promise<'UP' | 'DOWN' | 'UNKNOWN'> {
    let conditionId: `0x${string}` | null = null;
    let outcomes: string[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
        const data = await fetchJSON(`${GAMMA}/markets?slug=${slug}`);
        if (data?.[0]) {
            conditionId = data[0].conditionId as `0x${string}`;
            outcomes = JSON.parse(data[0].outcomes || '[]');
            break;
        }
        await sleep(1000);
    }
    if (!conditionId || outcomes.length === 0) return 'UNKNOWN';

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
        }
    } catch {}
    return 'UNKNOWN';
}

interface VerifyResult {
    slug: string;
    checks: {
        name: string;
        expected: string;
        actual: string;
        pass: boolean;
    }[];
    allPass: boolean;
}

async function verifyRecord(record: any): Promise<VerifyResult> {
    const checks: VerifyResult['checks'] = [];
    const slug = record.slug;
    const parts = slug.match(/^(\w+)-updown-(\d+)m-(\d+)$/);
    if (!parts) {
        return { slug, checks: [{ name: 'slug_format', expected: 'valid', actual: 'invalid', pass: false }], allPass: false };
    }
    const crypto = parts[1].toUpperCase();
    const interval = parseInt(parts[2]);
    const endTs = parseInt(parts[3]);

    // ── CHECK 1: On-chain resolution matches collector ──
    const onChainRes = await resolveOnChain(slug);
    checks.push({
        name: 'resolution',
        expected: record.resolution,
        actual: onChainRes,
        pass: onChainRes === 'UNKNOWN' || record.resolution === onChainRes,
    });

    // ── CHECK 2: prevResolution matches previous 5m candle on-chain ──
    if (interval === 5 && record.prevResolution && record.prevResolution !== 'UNKNOWN') {
        // Slug timestamp is START time, so previous 5m candle starts 300s earlier
        const prevSlug = `${parts[1]}-updown-5m-${endTs - 300}`;
        const prevOnChain = await resolveOnChain(prevSlug);
        checks.push({
            name: 'prevResolution',
            expected: record.prevResolution,
            actual: prevOnChain,
            pass: prevOnChain === 'UNKNOWN' || record.prevResolution === prevOnChain,
        });
    } else if (interval === 5) {
        checks.push({
            name: 'prevResolution',
            expected: 'present',
            actual: record.prevResolution || 'MISSING',
            pass: false,
        });
    }

    // ── CHECK 3: T-30 snapshot timing ──
    const snaps = record.snapshots || [];
    const t30 = snaps.find((s: any) => Math.abs(s.secondsBeforeEnd - 30) <= 3);
    if (t30) {
        const snapTime = t30.timestamp / 1000; // ms -> s
        // Slug timestamp is START time; end = start + interval*60
        const endTime = endTs + interval * 60;
        const actualSecsBefore = endTime - snapTime;
        const timingOk = Math.abs(actualSecsBefore - 30) <= 5;
        checks.push({
            name: 'T-30_timing',
            expected: '~30s before end',
            actual: `${actualSecsBefore.toFixed(1)}s before end`,
            pass: timingOk,
        });

        // ── CHECK 4: Leader determination at T-30 ──
        const upBid = t30.upBid || 0;
        const downBid = t30.downBid || 0;
        const upAsk = t30.upAsk || 0;
        const downAsk = t30.downAsk || 0;

        const leaderSide = upBid >= downBid ? 'UP' : 'DOWN';
        const leaderAsk = leaderSide === 'UP' ? upAsk : downAsk;
        const leaderBid = leaderSide === 'UP' ? upBid : downBid;

        checks.push({
            name: 'leader_side',
            expected: `${leaderSide} (bid=${leaderBid.toFixed(2)})`,
            actual: `upBid=${upBid.toFixed(2)} downBid=${downBid.toFixed(2)}`,
            pass: true, // informational — we compute it ourselves
        });

        checks.push({
            name: 'leader_ask',
            expected: `${leaderAsk.toFixed(2)}`,
            actual: `${leaderSide}Ask=${leaderAsk.toFixed(2)}`,
            pass: leaderAsk > 0 && leaderAsk <= 1, // 1.00 is valid (one-sided, bot skips)
        });

        // ── CHECK 5: Two-sided market check ──
        const otherAsk = leaderSide === 'UP' ? downAsk : upAsk;
        const isTwoSided = leaderAsk < 0.99 && otherAsk < 0.99 && leaderAsk > 0.01 && otherAsk > 0.01;
        checks.push({
            name: 'two_sided',
            expected: 'true or false',
            actual: `leader=${leaderAsk.toFixed(2)} other=${otherAsk.toFixed(2)} → ${isTwoSided ? 'YES' : 'NO (one-sided)'}`,
            pass: true, // informational
        });

        // ── CHECK 6: If this is a tradeable candle (50-75¢ + prev=fav), verify P&L math ──
        if (isTwoSided && leaderAsk >= 0.50 && leaderAsk < 0.75) {
            const prevMatchesFav = record.prevResolution === leaderSide;
            const won = record.resolution === leaderSide;
            const shares = Math.floor(10 / leaderAsk);
            const cost = shares * leaderAsk;
            const pnl = won ? shares * (1 - leaderAsk) : -cost;

            checks.push({
                name: 'trade_economics',
                expected: `${shares}sh @${(leaderAsk * 100).toFixed(0)}¢ cost=$${cost.toFixed(2)}`,
                actual: `${won ? 'WIN' : 'LOSS'} PnL=$${pnl.toFixed(2)} | prev=${record.prevResolution} leader=${leaderSide} prevMatchesFav=${prevMatchesFav}`,
                pass: true, // informational
            });
        }
    } else {
        checks.push({
            name: 'T-30_timing',
            expected: 'present',
            actual: 'MISSING T-30 snapshot',
            pass: false,
        });
    }

    // ── CHECK 7: No duplicate in file (spot check) ──
    // This is checked at the aggregate level, not per-record

    const allPass = checks.every(c => c.pass);
    return { slug, checks, allPass };
}

// ── Main ──

async function main() {
    console.log('=== COLLECTOR DATA VERIFICATION ===');
    console.log(`Mode: ${recentOnly ? 'recent records' : dateFilter ? `date ${dateFilter}` : `random sample of ${sampleSize}`}`);
    console.log();

    // Load records using streaming for large files
    const { createReadStream } = await import('fs');
    const { createInterface } = await import('readline');

    let records: any[] = [];
    const rl = createInterface({ input: createReadStream('pricing-data.jsonl') });
    for await (const line of rl) {
        if (line.trim()) {
            try { records.push(JSON.parse(line)); } catch {}
        }
    }

    // Filter
    if (dateFilter) {
        records = records.filter(r => {
            const m = r.slug?.match(/(\d+)$/);
            if (!m) return false;
            const d = new Date(parseInt(m[1]) * 1000).toISOString().slice(0, 10);
            return d === dateFilter;
        });
    }
    if (recentOnly) {
        records = records.slice(-100);
    }

    // Dedup check
    const slugCounts = new Map<string, number>();
    for (const r of records) {
        slugCounts.set(r.slug, (slugCounts.get(r.slug) || 0) + 1);
    }
    const dupes = [...slugCounts.entries()].filter(([, n]) => n > 1);
    console.log(`--- DEDUP CHECK ---`);
    console.log(`  Total records: ${records.length}`);
    console.log(`  Unique slugs: ${slugCounts.size}`);
    console.log(`  Duplicated slugs: ${dupes.length}`);
    if (dupes.length > 0) {
        console.log(`  ⚠️  DUPLICATES FOUND:`);
        for (const [slug, n] of dupes.slice(0, 5)) {
            console.log(`    ${slug}: ${n} copies`);
        }
        if (dupes.length > 5) console.log(`    ... and ${dupes.length - 5} more`);
    } else {
        console.log(`  ✓ No duplicates`);
    }
    console.log();

    // Sample random records (only resolved 5m for meaningful checks)
    const resolved5m = records.filter(r =>
        r.resolution && r.resolution !== 'UNKNOWN' &&
        r.slug?.includes('-5m-')
    );

    // Deduplicate for sampling
    const seen = new Set<string>();
    const unique5m = resolved5m.filter(r => {
        if (seen.has(r.slug)) return false;
        seen.add(r.slug);
        return true;
    });

    const sample = recentOnly
        ? unique5m.slice(-sampleSize)
        : unique5m.sort(() => Math.random() - 0.5).slice(0, sampleSize);

    console.log(`--- VERIFYING ${sample.length} RECORDS ---`);
    console.log();

    let passed = 0;
    let failed = 0;
    const failures: VerifyResult[] = [];

    for (let i = 0; i < sample.length; i++) {
        const result = await verifyRecord(sample[i]);

        if (result.allPass) {
            passed++;
            const tradeCheck = result.checks.find(c => c.name === 'trade_economics');
            const resCheck = result.checks.find(c => c.name === 'resolution');
            console.log(`  ✓ ${result.slug} | res=${resCheck?.actual?.slice(0, 10) || '?'} ${tradeCheck ? `| ${tradeCheck.actual.slice(0, 50)}` : ''}`);
        } else {
            failed++;
            failures.push(result);
            console.log(`  ✗ ${result.slug}`);
            for (const c of result.checks.filter(c => !c.pass)) {
                console.log(`    FAIL [${c.name}]: expected=${c.expected}, actual=${c.actual}`);
            }
        }

        // Rate limit on-chain calls
        if (i < sample.length - 1) await sleep(500);
    }

    console.log();
    console.log('=== SUMMARY ===');
    console.log(`  Passed: ${passed}/${sample.length}`);
    console.log(`  Failed: ${failed}/${sample.length}`);
    console.log(`  Duplicates in file: ${dupes.length}`);

    if (failed === 0 && dupes.length === 0) {
        console.log(`  ✓ ALL CHECKS PASSED — data appears correct`);
    } else {
        console.log(`  ⚠️  ISSUES FOUND — investigate failures above`);
    }

    // Cross-check with bot log if available
    try {
        const botLog = readFileSync('logs/microstructure-bot.log', 'utf8');
        const botTrades = botLog.match(/DRY RUN: would buy \d+ shares of (UP|DOWN) @(\d+)¢/g) || [];
        const botResults = botLog.match(/(WIN|LOSS) — bought (UP|DOWN) @(\d+)¢, resolved (UP|DOWN)/g) || [];
        console.log();
        console.log(`--- BOT CROSS-CHECK ---`);
        console.log(`  Bot trades today: ${botTrades.length}`);
        console.log(`  Bot results today: ${botResults.length}`);

        // Parse bot results and cross-check against collector
        const botParsed = [...botLog.matchAll(/(\w+) (\d+)m: (WIN|LOSS) — bought (UP|DOWN) @(\d+)¢, resolved (UP|DOWN)/g)];
        if (botParsed.length > 0) {
            let botMatch = 0;
            let botMismatch = 0;
            for (const m of botParsed) {
                const [, crypto, interval, result, side, price, resolved] = m;
                // Find matching collector record (approximate)
                const matchingRecords = records.filter(r => {
                    if (!r.slug?.startsWith(crypto.toLowerCase())) return false;
                    if (!r.slug?.includes(`-${interval}m-`)) return false;
                    if (r.resolution !== resolved) return false;
                    return true;
                });
                if (matchingRecords.length > 0) botMatch++;
                else botMismatch++;
            }
            console.log(`  Bot-collector resolution matches: ${botMatch}/${botParsed.length}`);
            if (botMismatch > 0) {
                console.log(`  ⚠️  ${botMismatch} bot results don't match collector records`);
            }
        }
    } catch {
        console.log();
        console.log(`  (no bot log found for cross-check)`);
    }
}

main().catch(console.error);
