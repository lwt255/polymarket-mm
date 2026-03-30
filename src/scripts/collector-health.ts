import fs from 'fs';

type PricingRecord = {
    slug?: string;
    marketEnd?: number;
    collectedAt?: string;
    snapshots?: unknown[];
    resolution?: string;
};

type LoadedFile = {
    fileName: string;
    filePath: string;
    records: PricingRecord[];
    sizeBytes: number;
    parseErrors: number;
    error: string | null;
    lastModified: Date | null;
    earliest: Date | null;
    latest: Date | null;
    recordsPerHour: number | null;
    rangeHours: number | null;
};

type HourBucket = {
    hour: Date;
    count: number;
};

const RAW_FILE = 'pricing-data.raw.jsonl';
const FILTERED_FILE = 'pricing-data.jsonl';
const HOUR_MS = 60 * 60 * 1000;
const STALL_THRESHOLD_MS = 15 * 60 * 1000;

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;

    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unitIndex = 0;

    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }

    return `${value.toFixed(2)} ${units[unitIndex]}`;
}

function formatDate(date: Date | null): string {
    return date ? date.toISOString() : 'N/A';
}

function formatHours(hours: number | null): string {
    if (hours === null || !Number.isFinite(hours)) return 'N/A';
    return `${hours.toFixed(2)}h`;
}

function formatRate(rate: number | null): string {
    if (rate === null || !Number.isFinite(rate)) return 'N/A';
    return `${rate.toFixed(2)} records/hour`;
}

function formatAge(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
}

function parseCollectedAt(value: unknown): Date | null {
    if (typeof value !== 'string') return null;

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
}

function getCrypto(slug: unknown): string {
    if (typeof slug !== 'string' || slug.length === 0) return 'unknown';
    return slug.split('-')[0] || 'unknown';
}

function truncateToHour(date: Date): Date {
    return new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);
}

function loadJsonl(fileName: string): LoadedFile {
    const filePath = `${process.cwd()}/${fileName}`;

    try {
        const stat = fs.statSync(filePath);
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);

        const records: PricingRecord[] = [];
        let parseErrors = 0;

        for (const line of lines) {
            try {
                const parsed = JSON.parse(line) as unknown;
                if (parsed && typeof parsed === 'object') {
                    records.push(parsed as PricingRecord);
                } else {
                    parseErrors++;
                }
            } catch {
                parseErrors++;
            }
        }

        const collectedTimes = records
            .map((record) => parseCollectedAt(record.collectedAt))
            .filter((value): value is Date => value !== null)
            .sort((a, b) => a.getTime() - b.getTime());

        const earliest = collectedTimes[0] ?? null;
        const latest = collectedTimes[collectedTimes.length - 1] ?? null;
        const rangeHours = earliest && latest && latest.getTime() > earliest.getTime()
            ? (latest.getTime() - earliest.getTime()) / HOUR_MS
            : null;
        const recordsPerHour = rangeHours && rangeHours > 0
            ? records.length / rangeHours
            : null;

        return {
            fileName,
            filePath,
            records,
            sizeBytes: stat.size,
            parseErrors,
            error: null,
            lastModified: stat.mtime,
            earliest,
            latest,
            recordsPerHour,
            rangeHours,
        };
    } catch (error) {
        return {
            fileName,
            filePath,
            records: [],
            sizeBytes: 0,
            parseErrors: 0,
            error: error instanceof Error ? error.message : String(error),
            lastModified: null,
            earliest: null,
            latest: null,
            recordsPerHour: null,
            rangeHours: null,
        };
    }
}

function countByCrypto(records: PricingRecord[]): Array<[string, number]> {
    const counts = new Map<string, number>();

    for (const record of records) {
        const crypto = getCrypto(record.slug);
        counts.set(crypto, (counts.get(crypto) ?? 0) + 1);
    }

    return [...counts.entries()].sort((a, b) => {
        if (b[1] !== a[1]) return b[1] - a[1];
        return a[0].localeCompare(b[0]);
    });
}

function buildHourlyBuckets(records: PricingRecord[]): HourBucket[] {
    const timestamps = records
        .map((record) => parseCollectedAt(record.collectedAt))
        .filter((value): value is Date => value !== null)
        .sort((a, b) => a.getTime() - b.getTime());

    if (timestamps.length === 0) return [];

    const counts = new Map<number, number>();
    for (const timestamp of timestamps) {
        const hourTs = truncateToHour(timestamp).getTime();
        counts.set(hourTs, (counts.get(hourTs) ?? 0) + 1);
    }

    const startHour = truncateToHour(timestamps[0]).getTime();
    const endHour = truncateToHour(timestamps[timestamps.length - 1]).getTime();
    const buckets: HourBucket[] = [];

    for (let hourTs = startHour; hourTs <= endHour; hourTs += HOUR_MS) {
        buckets.push({
            hour: new Date(hourTs),
            count: counts.get(hourTs) ?? 0,
        });
    }

    return buckets;
}

function printFileStats(file: LoadedFile): void {
    console.log(`${file.fileName}:`);
    console.log(`  path: ${file.filePath}`);

    if (file.error) {
        console.log(`  error: ${file.error}`);
        return;
    }

    console.log(`  records: ${file.records.length}`);
    console.log(`  size: ${formatBytes(file.sizeBytes)} (${file.sizeBytes.toLocaleString()} bytes)`);
    console.log(`  time range: ${formatDate(file.earliest)} -> ${formatDate(file.latest)}`);

    if (file.parseErrors > 0) {
        console.log(`  parse errors skipped: ${file.parseErrors}`);
    }
}

function recentRate(records: PricingRecord[], windowHours: number): number | null {
    const now = Date.now();
    const cutoff = now - windowHours * HOUR_MS;
    const recent = records.filter((r) => {
        const d = parseCollectedAt(r.collectedAt);
        return d !== null && d.getTime() >= cutoff;
    });
    return recent.length > 0 ? recent.length / windowHours : null;
}

function printRateStats(file: LoadedFile): void {
    console.log(`${file.fileName}:`);

    if (file.error) {
        console.log('  unavailable');
        return;
    }

    const recent3h = recentRate(file.records, 3);
    console.log(`  range: ${formatHours(file.rangeHours)}`);
    console.log(`  lifetime avg: ${formatRate(file.recordsPerHour)}`);
    console.log(`  last 3h avg:  ${formatRate(recent3h)}`);
}

function printCryptoBreakdown(label: string, records: PricingRecord[]): void {
    console.log(`${label}:`);

    const entries = countByCrypto(records);
    if (entries.length === 0) {
        console.log('  no records');
        return;
    }

    for (const [crypto, count] of entries) {
        console.log(`  ${crypto}: ${count}`);
    }
}

function printRecentRecords(records: PricingRecord[], sourceLabel: string): void {
    console.log(`Source: ${sourceLabel}`);

    if (records.length === 0) {
        console.log('  no records');
        return;
    }

    const recent = records.slice(-5).reverse();
    for (const record of recent) {
        const snapshotCount = Array.isArray(record.snapshots) ? record.snapshots.length : 0;
        const slug = typeof record.slug === 'string' ? record.slug : 'unknown';
        const resolution = typeof record.resolution === 'string' ? record.resolution : 'UNKNOWN';
        const collectedAt = typeof record.collectedAt === 'string' ? record.collectedAt : 'N/A';
        console.log(`  ${collectedAt} | ${slug} | ${resolution} | snapshots=${snapshotCount}`);
    }
}

function main(): void {
    const rawFile = loadJsonl(RAW_FILE);
    const filteredFile = loadJsonl(FILTERED_FILE);

    const now = Date.now();
    const rawLastModifiedMs = rawFile.lastModified?.getTime() ?? null;
    const rawAgeMs = rawLastModifiedMs === null ? null : now - rawLastModifiedMs;
    const isStalled = rawAgeMs === null || rawAgeMs > STALL_THRESHOLD_MS;

    const hourlyBuckets = buildHourlyBuckets(rawFile.records);
    const averagePerHour = hourlyBuckets.length > 0
        ? rawFile.records.length / hourlyBuckets.length
        : 0;
    const lowCountThreshold = averagePerHour * 0.5;
    const gapBuckets = hourlyBuckets.filter((bucket) => bucket.count < lowCountThreshold);
    const hasGaps = gapBuckets.length > 0;

    const status = isStalled ? 'STALLED' : hasGaps ? 'WARNING' : 'HEALTHY';

    console.log('=== Collector Health Report ===');
    console.log();

    console.log('--- File Stats ---');
    printFileStats(rawFile);
    printFileStats(filteredFile);
    console.log();

    console.log('--- Collection Rate ---');
    printRateStats(rawFile);
    printRateStats(filteredFile);
    console.log();

    console.log('--- Per-Crypto Breakdown ---');
    printCryptoBreakdown(RAW_FILE, rawFile.records);
    printCryptoBreakdown(FILTERED_FILE, filteredFile.records);
    console.log();

    console.log('--- Gap Detection ---');
    if (rawFile.error) {
        console.log(`Raw file unavailable: ${rawFile.error}`);
    } else if (hourlyBuckets.length === 0) {
        console.log('No hourly buckets available from raw records.');
    } else {
        console.log(`Hourly buckets: ${hourlyBuckets.length}`);
        console.log(`Average raw records/hour: ${averagePerHour.toFixed(2)}`);
        console.log(`Low-count threshold: < ${lowCountThreshold.toFixed(2)} records/hour`);

        if (gapBuckets.length === 0) {
            console.log('No unusually low-volume hours detected.');
        } else {
            console.log('Unusually low-volume hours:');
            for (const bucket of gapBuckets) {
                console.log(`  ${bucket.hour.toISOString()} | count=${bucket.count}`);
            }
        }
    }
    console.log();

    console.log('--- Recent Records ---');
    const recentSource = rawFile.records.length > 0 ? RAW_FILE : FILTERED_FILE;
    const recentRecords = rawFile.records.length > 0 ? rawFile.records : filteredFile.records;
    printRecentRecords(recentRecords, recentSource);
    console.log();

    console.log('--- Status ---');
    if (rawFile.error) {
        console.log(`Raw file check failed: ${rawFile.error}`);
    } else if (rawAgeMs !== null) {
        console.log(`Raw file last modified: ${formatDate(rawFile.lastModified)}`);
        console.log(`Raw file age: ${formatAge(rawAgeMs)}`);

        if (isStalled) {
            console.log(`STALL WARNING: ${RAW_FILE} has not been updated for more than 15 minutes.`);
        }
    }

    if (!isStalled && hasGaps) {
        console.log(`Gap warning: ${gapBuckets.length} low-count hourly bucket(s) detected.`);
    }

    console.log(`STATUS: ${status}`);
}

main();
