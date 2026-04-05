/**
 * backfill-prev-resolution.ts
 *
 * Fixes the prevResolution field in pricing-data.jsonl.
 * The original backfill-onchain-resolution.ts corrected `resolution` but left
 * `prevResolution` containing the old (wrong) Gamma API values.
 *
 * Strategy:
 *   1. Load all records in order, group by crypto × interval series
 *   2. Sort each series by timestamp
 *   3. Chain: each record's prevResolution = prior record's resolution
 *   4. Rewrite the file in original line order with corrected prevResolution
 *
 * Handles duplicate slugs correctly by tracking records by line index.
 *
 * No on-chain calls needed — just re-derives prevResolution from the
 * already-corrected resolution field.
 *
 * Usage:
 *   npx tsx src/scripts/backfill-prev-resolution.ts [--dry-run]
 */
import * as fs from 'fs';
import * as readline from 'readline';

interface Record {
    lineIndex: number;
    slug: string;
    resolution?: string;
    prevResolution?: string;
    crypto: string;
    interval: number;
    ts: number;
}

function parseSlug(slug: string): { crypto: string; interval: number; ts: number } | null {
    const m = slug.match(/^(\w+)-updown-(\d+)m-(\d+)$/);
    if (!m) return null;
    return { crypto: m[1], interval: parseInt(m[2]), ts: parseInt(m[3]) };
}

async function main() {
    const dryRun = process.argv.includes('--dry-run');
    const file = 'pricing-data.jsonl';

    console.log(`=== BACKFILL prevResolution ===`);
    console.log(`Mode: ${dryRun ? 'DRY RUN' : 'LIVE (will rewrite file)'}\n`);

    // Step 1: Load all records, preserving line order
    console.log('Step 1: Loading records...');
    const rawLines: string[] = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file) });
    for await (const line of rl) {
        rawLines.push(line);
    }
    console.log(`  Loaded ${rawLines.length} lines`);

    // Step 2: Parse and group by series
    console.log('Step 2: Grouping by series...');
    const records: Record[] = [];
    const series = new Map<string, Record[]>();

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (!line.trim()) continue;
        let parsed;
        try { parsed = JSON.parse(line); } catch { continue; }

        const slugInfo = parseSlug(parsed.slug);
        if (!slugInfo) continue;

        const rec: Record = {
            lineIndex: i,
            slug: parsed.slug,
            resolution: parsed.resolution,
            prevResolution: parsed.prevResolution,
            ...slugInfo,
        };
        records.push(rec);

        const key = `${slugInfo.crypto}-${slugInfo.interval}m`;
        if (!series.has(key)) series.set(key, []);
        series.get(key)!.push(rec);
    }
    console.log(`  ${series.size} series, ${records.length} records`);

    // Step 3: Sort each series by timestamp, chain prevResolution
    console.log('Step 3: Chaining prevResolution...');
    // Map from lineIndex -> corrected prevResolution
    const corrections = new Map<number, string>();
    let changed = 0;

    for (const [key, recs] of series) {
        recs.sort((a, b) => a.ts - b.ts);

        for (let i = 1; i < recs.length; i++) {
            const prev = recs[i - 1];
            const curr = recs[i];

            if (!prev.resolution || prev.resolution === 'UNKNOWN') continue;

            const correctPrev = prev.resolution;
            if (curr.prevResolution !== correctPrev) {
                changed++;
            }
            // Always set it (even if already correct) to ensure consistency
            corrections.set(curr.lineIndex, correctPrev);
        }
    }

    console.log(`  prevResolution values changed: ${changed}`);
    console.log(`  Total corrections stored: ${corrections.size}`);

    if (dryRun) {
        console.log(`\nDRY RUN — no files changed.`);
        return;
    }

    // Step 4: Rewrite file
    console.log('\nStep 4: Rewriting file...');
    const backupFile = `${file}.pre-prev-fix-${Date.now()}.bak`;
    fs.copyFileSync(file, backupFile);
    console.log(`  Backed up: ${backupFile}`);

    const tmpFile = `${file}.tmp-${Date.now()}`;
    const ws = fs.createWriteStream(tmpFile);

    for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (!line.trim()) {
            ws.write(line + '\n');
            continue;
        }

        const correctedPrev = corrections.get(i);
        if (correctedPrev !== undefined) {
            try {
                const r = JSON.parse(line);
                r.prevResolution = correctedPrev;
                ws.write(JSON.stringify(r) + '\n');
            } catch {
                ws.write(line + '\n');
            }
        } else {
            ws.write(line + '\n');
        }
    }

    await new Promise<void>(resolve => ws.end(resolve));
    fs.renameSync(tmpFile, file);

    console.log(`  File rewritten: ${file}`);
    console.log(`\n=== DONE ===`);
    console.log(`${changed} prevResolution values corrected across ${records.length} records.`);
}

main().catch(e => console.error(e));
