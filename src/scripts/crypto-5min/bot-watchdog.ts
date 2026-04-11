/**
 * bot-watchdog.ts — Continuous monitoring for the favorite snipe bot + collector
 *
 * Runs every 5 minutes. Logs status, alerts on problems, auto-restarts crashed processes.
 *
 * Usage:
 *   npx tsx src/scripts/crypto-5min/bot-watchdog.ts                    # monitor only
 *   npx tsx src/scripts/crypto-5min/bot-watchdog.ts --auto-restart     # monitor + restart dead processes
 *   npx tsx src/scripts/crypto-5min/bot-watchdog.ts --interval 120     # check every 2 min
 *
 * Run in background:
 *   nohup npx tsx src/scripts/crypto-5min/bot-watchdog.ts --auto-restart > watchdog.out 2>&1 &
 */
import 'dotenv/config';
import * as fs from 'fs';
import { execSync, exec } from 'child_process';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

const args = process.argv.slice(2);
const AUTO_RESTART = args.includes('--auto-restart');
const INTERVAL_SEC = parseInt(args.find((_, i, a) => a[i - 1] === '--interval') || '300');
const ALERT_LOG = 'watchdog-alerts.log';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function run(cmd: string): string {
    try { return execSync(cmd, { encoding: 'utf-8', timeout: 10000 }).trim(); } catch { return ''; }
}

function log(msg: string) {
    const ts = new Date().toISOString().slice(0, 19);
    console.log(`[${ts}] ${msg}`);
}

function alert(msg: string) {
    const ts = new Date().toISOString().slice(0, 19);
    const line = `[${ts}] ALERT: ${msg}`;
    console.log(`\n${'!'.repeat(60)}\n${line}\n${'!'.repeat(60)}\n`);
    fs.appendFileSync(ALERT_LOG, line + '\n');
}

function isProcessRunning(name: string): boolean {
    const result = run(`ps aux | grep "${name}" | grep -v grep | grep tsx`);
    return result.length > 0;
}

function getTradeStats(): { total: number; filled: number; wins: number; losses: number; pnl: number; lastTradeAge: number; lastTrade: any } | null {
    const file = 'favorite-snipe-trades.jsonl';
    if (!fs.existsSync(file)) return null;
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').filter(l => l);
    if (lines.length === 0) return null;
    const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const filled = trades.filter((t: any) => t.execution?.status === 'FILLED');
    const wins = filled.filter((t: any) => t.won).length;
    const losses = filled.length - wins;
    const pnl = filled.reduce((s: number, t: any) => s + (t.expectedPnl || 0), 0);
    const lastTrade = trades[trades.length - 1];
    const lastTradeAge = lastTrade ? Math.round((Date.now() - new Date(lastTrade.timestamp).getTime()) / 60000) : -1;
    return { total: trades.length, filled: filled.length, wins, losses, pnl, lastTradeAge, lastTrade };
}

function getLogAge(file: string): number {
    if (!fs.existsSync(file)) return -1;
    return Math.round((Date.now() - fs.statSync(file).mtimeMs) / 60000);
}

async function getBalance(): Promise<number> {
    const pk = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || '';
    if (!pk) return -1;
    const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
    const addr = privateKeyToAccount(key).address;
    const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
    try {
        const bal = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [addr] });
        return Number(bal) / 1e6;
    } catch {
        return -1;
    }
}

function restartCollector() {
    log('Auto-restarting collector...');
    exec('caffeinate -s nohup npx tsx src/scripts/pricing-collector.ts --continuous > pricing-collector.out 2>&1 &');
}

function restartBot() {
    log('Auto-restarting bot ($10/trade, $40 max loss)...');
    exec('nohup npx tsx src/scripts/crypto-5min/favorite-snipe-bot.ts --live --size 10 --max-loss 40 > favorite-bot.out 2>&1 &');
}

// Track state between checks
let prevBalance = -1;
let prevTradeCount = 0;
let checksWithoutTrade = 0;
let startBalance = -1;

async function check() {
    const now = new Date();
    const alerts: string[] = [];

    // ── Process checks ──
    const botRunning = isProcessRunning('favorite-snipe-bot');
    const collectorRunning = isProcessRunning('pricing-collector');

    if (!botRunning) {
        alerts.push('Bot is NOT running');
        if (AUTO_RESTART) restartBot();
    }
    if (!collectorRunning) {
        alerts.push('Collector is NOT running');
        if (AUTO_RESTART) restartCollector();
    }

    // ── Balance check ──
    const balance = await getBalance();
    if (startBalance < 0 && balance > 0) startBalance = balance;

    if (balance >= 0 && prevBalance >= 0) {
        const change = balance - prevBalance;
        // Alert on big sudden drop (>$15 in one check interval)
        if (change < -15) {
            alerts.push(`Balance dropped $${Math.abs(change).toFixed(2)} ($${prevBalance.toFixed(2)} → $${balance.toFixed(2)})`);
        }
    }

    if (balance >= 0 && balance < 10) {
        alerts.push(`Balance critically low: $${balance.toFixed(2)}`);
    }

    if (balance >= 0) prevBalance = balance;

    // ── Trade stats ──
    const stats = getTradeStats();
    if (stats) {
        if (stats.filled === prevTradeCount) {
            checksWithoutTrade++;
        } else {
            checksWithoutTrade = 0;
        }
        prevTradeCount = stats.filled;

        // No trades for 2+ hours during likely active market
        if (checksWithoutTrade >= 24 && botRunning) { // 24 checks × 5min = 2 hours
            alerts.push(`No new trades for ${checksWithoutTrade * Math.round(INTERVAL_SEC / 60)}+ minutes (bot is running)`);
            checksWithoutTrade = 0; // reset so we don't spam
        }

        // Bad loss streak
        if (stats.losses > stats.wins + 5) {
            alerts.push(`Heavy losses: ${stats.wins}W/${stats.losses}L (PnL: $${stats.pnl.toFixed(2)})`);
        }
    }

    // ── Log freshness ──
    const botLogAge = getLogAge('favorite-bot.out');
    if (botRunning && botLogAge > 10) {
        alerts.push(`Bot log stale (${botLogAge}m) — may be stuck`);
    }

    // ── Bot errors ──
    if (fs.existsSync('favorite-bot.out')) {
        const recentErrors = run(`tail -50 favorite-bot.out | grep -i "fatal\\|halt\\|crash\\|ECONNREFUSED\\|ENOTFOUND" | tail -3`);
        if (recentErrors && !recentErrors.includes('Could not create api key')) {
            alerts.push(`Bot errors detected: ${recentErrors.slice(0, 100)}`);
        }
    }

    // ── Print status ──
    const botIcon = botRunning ? '🟢' : '🔴';
    const collIcon = collectorRunning ? '🟢' : '🔴';
    const balStr = balance >= 0 ? `$${balance.toFixed(2)}` : '??';
    const sessionPnl = balance >= 0 && startBalance >= 0 ? balance - startBalance : 0;
    const statsStr = stats ? `${stats.wins}W/${stats.losses}L ${stats.pnl >= 0 ? '+' : ''}$${stats.pnl.toFixed(2)}` : 'no trades';

    log(`${botIcon} Bot  ${collIcon} Coll  | Bal: ${balStr}  | ${statsStr}  | ${alerts.length === 0 ? 'OK' : alerts.length + ' alert(s)'}`);

    // ── Fire alerts ──
    for (const a of alerts) {
        alert(a);
    }
}

async function main() {
    log(`=== BOT WATCHDOG STARTED ===`);
    log(`Interval: ${INTERVAL_SEC}s | Auto-restart: ${AUTO_RESTART}`);
    log(`Alerts logged to: ${ALERT_LOG}`);
    log('');

    while (true) {
        try {
            await check();
        } catch (err: any) {
            log(`Watchdog error: ${err.message}`);
        }
        await sleep(INTERVAL_SEC * 1000);
    }
}

main();
