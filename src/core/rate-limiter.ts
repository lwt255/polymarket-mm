/**
 * Polymarket Rate Limiter
 * 
 * Coordinates API request timing across multiple bots via shared state file.
 * Implements exponential backoff on rate limit errors.
 * 
 * Adapted from hyperliquid-mm shared-rate-limiter.ts
 */

import * as fs from 'fs';
import * as path from 'path';

const STATE_DIR = './state';
const LIMITER_FILE = 'polymarket-rate-limiter.json';
const LOCK_FILE = 'polymarket-rate-limiter.lock';

interface LimiterState {
    nextAllowedAt: number;
    backoffMs: number;
    last429At: number;
    consecutiveErrors: number;
}

const DEFAULT_STATE: LimiterState = {
    nextAllowedAt: 0,
    backoffMs: 0,
    last429At: 0,
    consecutiveErrors: 0,
};

// Default: 200ms between requests (5 req/sec)
let minIntervalMs = 200;

/**
 * Set the minimum interval between HTTP requests
 */
export function setMinInterval(ms: number): void {
    minIntervalMs = ms;
}

/**
 * Ensure state directory exists
 */
function ensureStateDir(): void {
    if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true });
    }
}

/**
 * Read limiter state from file
 */
function readState(): LimiterState {
    ensureStateDir();
    const filePath = path.join(STATE_DIR, LIMITER_FILE);

    try {
        if (fs.existsSync(filePath)) {
            const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
            return { ...DEFAULT_STATE, ...data };
        }
    } catch {
        // Ignore read errors, return default
    }

    return { ...DEFAULT_STATE };
}

/**
 * Write limiter state to file
 */
function writeState(state: LimiterState): void {
    ensureStateDir();
    const filePath = path.join(STATE_DIR, LIMITER_FILE);

    try {
        fs.writeFileSync(filePath, JSON.stringify(state, null, 2));
    } catch (error) {
        console.error('[RATE-LIMIT] Failed to write state:', error);
    }
}

/**
 * Acquire a simple file lock (best effort)
 */
function acquireLock(): boolean {
    ensureStateDir();
    const lockPath = path.join(STATE_DIR, LOCK_FILE);

    try {
        fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
        return true;
    } catch {
        // Lock exists, check if stale (older than 10 seconds)
        try {
            const stat = fs.statSync(lockPath);
            const age = Date.now() - stat.mtimeMs;
            if (age > 10000) {
                fs.unlinkSync(lockPath);
                fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
                return true;
            }
        } catch {
            // Ignore
        }
        return false;
    }
}

/**
 * Release the file lock
 */
function releaseLock(): void {
    const lockPath = path.join(STATE_DIR, LOCK_FILE);
    try {
        fs.unlinkSync(lockPath);
    } catch {
        // Ignore
    }
}

/**
 * Wait before making an HTTP request
 * Respects global nextAllowedAt and backoff state
 */
export async function waitBeforeRequest(): Promise<void> {
    const now = Date.now();
    let waitMs = 0;

    // Try to acquire lock
    let attempts = 0;
    while (!acquireLock() && attempts < 20) {
        await new Promise(resolve => setTimeout(resolve, 50));
        attempts++;
    }

    try {
        const state = readState();

        // Reset backoff if we haven't seen rate limits recently (1 min)
        if (state.backoffMs > 0 && now - state.last429At > 60000) {
            state.backoffMs = 0;
        }

        const effectiveInterval = Math.max(minIntervalMs, state.backoffMs);
        const earliest = Math.max(state.nextAllowedAt, now);
        waitMs = Math.max(0, earliest - now);

        state.nextAllowedAt = earliest + effectiveInterval;
        writeState(state);
    } finally {
        releaseLock();
    }

    if (waitMs > 0) {
        if (waitMs > 1000) {
            console.log(`[RATE-LIMIT] Waiting ${waitMs}ms due to rate limits...`);
        }
        await new Promise(resolve => setTimeout(resolve, waitMs));
    }
}

/**
 * Report a successful request - resets consecutive errors
 */
export function reportSuccess(): void {
    let attempts = 0;
    while (!acquireLock() && attempts < 5) {
        attempts++;
    }

    try {
        const state = readState();
        state.consecutiveErrors = 0;
        writeState(state);
    } finally {
        releaseLock();
    }
}

/**
 * Report a rate limit error (429) - triggers backoff escalation
 */
export function reportRateLimit(): void {
    const now = Date.now();
    let attempts = 0;
    while (!acquireLock() && attempts < 5) {
        attempts++;
    }

    try {
        const state = readState();
        state.consecutiveErrors = (state.consecutiveErrors || 0) + 1;
        state.last429At = now;

        // Exponential backoff: 2s → 4s → 8s → 16s → 32s → 60s max
        const nextBackoff = state.backoffMs > 0 ? Math.min(state.backoffMs * 2, 60000) : 2000;
        state.backoffMs = nextBackoff;
        state.nextAllowedAt = Math.max(state.nextAllowedAt, now + nextBackoff);

        writeState(state);

        console.log(
            `[RATE-LIMIT] 429 detected! Backoff: ${state.backoffMs}ms ` +
            `(consecutive errors: ${state.consecutiveErrors})`
        );
    } finally {
        releaseLock();
    }
}

/**
 * Get current rate limiter status
 */
export function getRateLimiterStatus(): {
    inBackoff: boolean;
    backoffRemainingMs: number;
    consecutiveErrors: number;
    minIntervalMs: number;
} {
    const state = readState();
    const now = Date.now();

    return {
        inBackoff: state.backoffMs > 0 && now - state.last429At < 60000,
        backoffRemainingMs: Math.max(0, state.nextAllowedAt - now),
        consecutiveErrors: state.consecutiveErrors || 0,
        minIntervalMs,
    };
}

/**
 * Reset rate limiter state (for testing)
 */
export function resetRateLimiter(): void {
    ensureStateDir();
    const filePath = path.join(STATE_DIR, LIMITER_FILE);
    try {
        fs.unlinkSync(filePath);
    } catch {
        // Ignore
    }
}
