/**
 * Live Dashboard — Terminal status display for microstructure bot v4
 *
 * Usage: npx tsx src/scripts/crypto-5min/live-dashboard.ts
 *        poly-dash  (shortcut)
 *
 * Refreshes every 30 seconds. Ctrl+C to exit.
 */
import 'dotenv/config';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const usdcAbi = parseAbi(['function balanceOf(address) view returns (uint256)']);
const LEDGER = 'microstructure-trades.jsonl';
const LOG = 'logs/microstructure-bot-live.log';

function run(cmd: string): string {
    try { return execSync(cmd, { encoding: 'utf-8' }).trim(); } catch { return ''; }
}

interface Trade {
    timestamp: string;
    crypto: string;
    resolution: string;
    won: boolean;
    expectedPnl: number;
    underdogAsk: number;
    signals: { leaderSide?: string; signalCount?: number; accounts?: string[] };
    execution: { status: string; orderId: string; fillPrice: number; fillSize: number; fillType?: string };
}

function loadLiveTrades(): Trade[] {
    if (!fs.existsSync(LEDGER)) return [];
    const lines = fs.readFileSync(LEDGER, 'utf-8').split('\n').filter(Boolean);
    const trades: Trade[] = [];
    for (const line of lines) {
        try {
            const t = JSON.parse(line);
            if (t.execution?.orderId !== 'dry-run') trades.push(t);
        } catch {}
    }
    return trades;
}

function getLastLogLines(n: number): string[] {
    if (!fs.existsSync(LOG)) return [];
    const out = run(`tail -${n} "${LOG}"`);
    return out.split('\n');
}

async function render() {
    const now = new Date();
    const trades = loadLiveTrades();
    const resolved = trades.filter(t => t.resolution === 'UP' || t.resolution === 'DOWN');
    const wins = resolved.filter(t => t.won);
    const losses = resolved.filter(t => !t.won);
    const totalPnl = resolved.reduce((s, t) => s + t.expectedPnl, 0);
    const wr = resolved.length > 0 ? (wins.length / resolved.length * 100) : 0;

    // On-chain balance
    let balance = '...';
    try {
        const key = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || process.env.EVM_WALLET_PRIVATE_KEY2 || '';
        if (key) {
            const formatted = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
            const account = privateKeyToAccount(formatted);
            const client = createPublicClient({ chain: polygon, transport: http('https://polygon.drpc.org') });
            const raw = await client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [account.address] });
            balance = `$${(Number(raw) / 1e6).toFixed(2)}`;
        }
    } catch { balance = 'error'; }

    // Process status
    const botProc = run("ps aux | grep microstructure-bot | grep -v grep | grep tsx | grep live");
    const collectorProc = run("ps aux | grep pricing-collector | grep -v grep | grep tsx");
    const snipeProc = run("ps aux | grep favorite-snipe | grep -v grep | grep tsx");
    const watchdogProc = run("ps aux | grep bot-watchdog | grep -v grep | grep tsx");

    // Today's trades only
    const today = now.toISOString().slice(0, 10);
    const todayTrades = resolved.filter(t => t.timestamp.startsWith(today));
    const todayWins = todayTrades.filter(t => t.won);
    const todayPnl = todayTrades.reduce((s, t) => s + t.expectedPnl, 0);
    const todayWr = todayTrades.length > 0 ? (todayWins.length / todayTrades.length * 100) : 0;

    // By symbol today
    const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
    const symStats = symbols.map(sym => {
        const st = todayTrades.filter(t => t.crypto === sym);
        const sw = st.filter(t => t.won);
        const sp = st.reduce((s, t) => s + t.expectedPnl, 0);
        return { sym, trades: st.length, wins: sw.length, pnl: sp };
    });

    // Last 5 trades
    const recent = resolved.slice(-5);

    // Pending trade
    const logLines = getLastLogLines(30);
    const pendingBuy = logLines.filter(l => l.includes('>> BUY')).pop();
    const lastEntry = logLines.filter(l => l.includes('ENTRY WINDOW')).pop();
    const lastNoTrade = logLines.filter(l => l.includes('No qualifying')).pop();

    // Streak
    let streak = 0;
    let streakType = '';
    for (let i = resolved.length - 1; i >= 0; i--) {
        const w = resolved[i].won;
        if (i === resolved.length - 1) { streakType = w ? 'W' : 'L'; streak = 1; }
        else if ((w && streakType === 'W') || (!w && streakType === 'L')) streak++;
        else break;
    }

    // Clear screen and render
    console.clear();
    console.log('╔══════════════════════════════════════════════════════════╗');
    console.log('║          POLYMARKET MICROSTRUCTURE BOT v4               ║');
    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  ${now.toISOString().slice(0, 19)} UTC                              ║`);
    console.log('╠══════════════════════════════════════════════════════════╣');

    // Status
    console.log(`║  BOT:       ${botProc ? '🟢 LIVE' : '🔴 OFF'}                                        ║`);
    console.log(`║  COLLECTOR: ${collectorProc ? '🟢 RUNNING' : '🔴 OFF'}                                    ║`);
    if (snipeProc) console.log(`║  ⚠️  SNIPE BOT STILL RUNNING                             ║`);
    if (watchdogProc) console.log(`║  ⚠️  WATCHDOG STILL RUNNING                              ║`);
    console.log(`║  BALANCE:   ${balance.padEnd(10)}                                  ║`);

    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  ALL TIME (live)                                        ║');
    console.log(`║  ${resolved.length}T  ${wins.length}W/${losses.length}L  ${wr.toFixed(1)}% WR  $${totalPnl.toFixed(2)} PnL  streak: ${streak}${streakType}     ║`);

    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log(`║  TODAY (${today})                                    ║`);
    console.log(`║  ${todayTrades.length}T  ${todayWins.length}W/${todayTrades.length - todayWins.length}L  ${todayWr.toFixed(1)}% WR  $${todayPnl.toFixed(2)} expected PnL          ║`);
    console.log('║                                                          ║');
    for (const s of symStats) {
        if (s.trades === 0) continue;
        const bar = s.pnl >= 0 ? `+$${s.pnl.toFixed(2)}` : `-$${Math.abs(s.pnl).toFixed(2)}`;
        console.log(`║  ${s.sym.padEnd(4)} ${s.trades}T ${s.wins}W/${s.trades - s.wins}L  ${bar.padEnd(10)}                        ║`);
    }

    console.log('╠══════════════════════════════════════════════════════════╣');
    console.log('║  RECENT TRADES                                          ║');
    for (const t of recent) {
        const time = t.timestamp.slice(11, 19);
        const result = t.won ? 'WIN ' : 'LOSS';
        const pnl = t.expectedPnl >= 0 ? `+$${t.expectedPnl.toFixed(2)}` : `-$${Math.abs(t.expectedPnl).toFixed(2)}`;
        const fill = t.execution.fillType === 'MAKER' ? 'M' : 'T';
        console.log(`║  ${time} ${t.crypto.padEnd(4)} ${result} ${pnl.padEnd(8)} @${(t.underdogAsk * 100).toFixed(0)}¢ [${fill}]              ║`);
    }

    console.log('╠══════════════════════════════════════════════════════════╣');
    // Last activity
    if (pendingBuy) {
        const match = pendingBuy.match(/>> BUY (\w+): (\w+)/);
        if (match) console.log(`║  ⏳ PENDING: ${match[2]} ${match[1]}                                  ║`);
    } else if (lastNoTrade) {
        console.log('║  💤 No qualifying trades last candle                     ║');
    }
    console.log('╚══════════════════════════════════════════════════════════╝');
    console.log('  Refreshing every 30s. Ctrl+C to exit.');
}

async function main() {
    await render();
    setInterval(render, 30000);
}

main().catch(console.error);
