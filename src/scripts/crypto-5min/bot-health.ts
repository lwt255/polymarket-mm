/**
 * bot-health.ts — Quick health check for the favorite snipe bot + collector
 *
 * Usage: npx tsx src/scripts/crypto-5min/bot-health.ts
 */
import 'dotenv/config';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);

function run(cmd: string): string {
    try { return execSync(cmd, { encoding: 'utf-8' }).trim(); } catch { return ''; }
}

async function main() {
    const now = new Date();
    console.log(`\n=== BOT HEALTH CHECK — ${now.toISOString().slice(0, 19)} UTC ===\n`);

    // ── 1. Process check ──
    const botProcs = run("ps aux | grep favorite-snipe-bot | grep -v grep | grep tsx");
    const collectorProcs = run("ps aux | grep pricing-collector | grep -v grep | grep tsx");

    console.log(`BOT:       ${botProcs ? '🟢 RUNNING' : '🔴 NOT RUNNING'}`);
    console.log(`COLLECTOR: ${collectorProcs ? '🟢 RUNNING' : '🔴 NOT RUNNING'}`);

    // ── 2. On-chain balance ──
    const pk = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || '';
    if (pk) {
        const key = (pk.startsWith('0x') ? pk : `0x${pk}`) as `0x${string}`;
        const addr = privateKeyToAccount(key).address;
        const pub = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
        try {
            const bal = await pub.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [addr] });
            console.log(`BALANCE:   $${(Number(bal) / 1e6).toFixed(2)} (${addr.slice(0, 8)}...)`);
        } catch {
            console.log(`BALANCE:   ⚠️  RPC error`);
        }
    }

    // ── 3. Trade log ──
    const tradeFile = 'favorite-snipe-trades.jsonl';
    if (fs.existsSync(tradeFile)) {
        const lines = fs.readFileSync(tradeFile, 'utf-8').trim().split('\n').filter(l => l);
        const trades = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        const filled = trades.filter((t: any) => t.execution?.status === 'FILLED');
        const wins = filled.filter((t: any) => t.won);
        const losses = filled.filter((t: any) => !t.won);
        const unfilled = trades.filter((t: any) => t.execution?.status === 'UNFILLED');
        const totalPnl = filled.reduce((s: number, t: any) => s + (t.expectedPnl || 0), 0);

        console.log(`\n--- SESSION TRADES ---`);
        console.log(`Total:     ${trades.length} (${filled.length} filled, ${unfilled.length} unfilled)`);
        console.log(`Record:    ${wins.length}W / ${losses.length}L (${filled.length > 0 ? (wins.length / filled.length * 100).toFixed(0) : 0}%)`);
        console.log(`PnL:       ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(2)}`);

        // Last 5 trades
        console.log(`\nLast trades:`);
        for (const t of trades.slice(-5)) {
            const status = t.execution?.status;
            const side = t.underdogSide;
            const ask = (t.underdogAsk * 100).toFixed(0);
            const result = status === 'FILLED' ? (t.won ? `WIN +$${t.expectedPnl.toFixed(2)}` : `LOSS $${t.expectedPnl.toFixed(2)}`) : status;
            const ago = Math.round((now.getTime() - new Date(t.timestamp).getTime()) / 60000);
            console.log(`  ${t.timestamp.slice(11, 19)} ${t.crypto} ${side} @${ask}¢ — ${result} (${ago}m ago)`);
        }

        // Win streak / loss streak
        let curStreak = 0, maxWinStreak = 0, maxLoseStreak = 0, curType = '';
        for (const t of filled) {
            if (t.won) {
                if (curType === 'W') curStreak++; else { curStreak = 1; curType = 'W'; }
                maxWinStreak = Math.max(maxWinStreak, curStreak);
            } else {
                if (curType === 'L') curStreak++; else { curStreak = 1; curType = 'L'; }
                maxLoseStreak = Math.max(maxLoseStreak, curStreak);
            }
        }
        console.log(`\nMax win streak:  ${maxWinStreak}`);
        console.log(`Max loss streak: ${maxLoseStreak}`);
        console.log(`Current streak:  ${curStreak}${curType}`);
    } else {
        console.log(`\n--- NO TRADES YET ---`);
    }

    // ── 4. Bot log tail ──
    const botLog = 'favorite-bot.out';
    if (fs.existsSync(botLog)) {
        const stat = fs.statSync(botLog);
        const ageMins = Math.round((now.getTime() - stat.mtimeMs) / 60000);
        const lastLines = run(`tail -5 ${botLog}`);

        console.log(`\n--- BOT LOG (last update ${ageMins}m ago) ---`);
        if (ageMins > 10 && botProcs) {
            console.log(`⚠️  Log hasn't updated in ${ageMins} minutes but process is running`);
        }
        console.log(lastLines);
    }

    // ── 5. Collector check ──
    const collectorLog = 'pricing-collector.out';
    if (fs.existsSync(collectorLog)) {
        const stat = fs.statSync(collectorLog);
        const ageMins = Math.round((now.getTime() - stat.mtimeMs) / 60000);
        const lastResolution = run(`grep "Resolution:" ${collectorLog} | tail -1`);

        console.log(`\n--- COLLECTOR (last update ${ageMins}m ago) ---`);
        if (ageMins > 10 && collectorProcs) {
            console.log(`⚠️  Collector log stale (${ageMins}m) but process running`);
        }
        if (lastResolution) console.log(`Last resolution: ${lastResolution.slice(lastResolution.indexOf(']') + 2)}`);

        // Count today's records
        const today = now.toISOString().slice(0, 10);
        const todayCount = run(`grep -c "${today}" pricing-data.jsonl 2>/dev/null`);
        console.log(`Today's records: ${todayCount || '0'}`);
    }

    // ── 6. Errors ──
    if (fs.existsSync(botLog)) {
        const errors = run(`grep -i "error\\|fatal\\|halt\\|crash" ${botLog} | tail -5`);
        if (errors) {
            console.log(`\n--- ⚠️  ERRORS DETECTED ---`);
            console.log(errors);
        }
    }

    console.log(`\n${'='.repeat(50)}\n`);
}

main().catch(e => console.error(e));
