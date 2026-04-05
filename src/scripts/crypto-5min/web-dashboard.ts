/**
 * Web Dashboard — Browser-based status display for microstructure bot v4
 *
 * Usage: npx tsx src/scripts/crypto-5min/web-dashboard.ts
 *        poly-web  (shortcut)
 *
 * Opens http://localhost:3456 — auto-refreshes every 15 seconds.
 */
import 'dotenv/config';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { createPublicClient, http as viemHttp, parseAbi } from 'viem';
import { polygon } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';

const PORT = 3456;
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
    signals: any;
    execution: any;
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
    return out.split('\n').filter(Boolean);
}

async function getBalance(): Promise<number> {
    try {
        const key = process.env.POLYMARKET_PRIVATE_KEY2 || process.env.POLYMARKET_PRIVATE_KEY || '';
        if (!key) return -1;
        const formatted = (key.startsWith('0x') ? key : `0x${key}`) as `0x${string}`;
        const account = privateKeyToAccount(formatted);
        const client = createPublicClient({ chain: polygon, transport: viemHttp('https://polygon.drpc.org') });
        const raw = await client.readContract({ address: USDC, abi: usdcAbi, functionName: 'balanceOf', args: [account.address] });
        return Number(raw) / 1e6;
    } catch { return -1; }
}

async function buildStatus() {
    const now = new Date();
    const trades = loadLiveTrades();
    const resolved = trades.filter(t => t.resolution === 'UP' || t.resolution === 'DOWN');
    const wins = resolved.filter(t => t.won);
    const losses = resolved.filter(t => !t.won);
    const totalPnl = resolved.reduce((s, t) => s + t.expectedPnl, 0);
    const wr = resolved.length > 0 ? (wins.length / resolved.length * 100) : 0;
    const avgPnl = resolved.length > 0 ? totalPnl / resolved.length : 0;

    // Streak
    let streak = 0, streakType = '';
    for (let i = resolved.length - 1; i >= 0; i--) {
        const w = resolved[i].won;
        if (i === resolved.length - 1) { streakType = w ? 'W' : 'L'; streak = 1; }
        else if ((w && streakType === 'W') || (!w && streakType === 'L')) streak++;
        else break;
    }

    // Today
    const today = now.toISOString().slice(0, 10);
    const todayTrades = resolved.filter(t => t.timestamp.startsWith(today));
    const todayWins = todayTrades.filter(t => t.won);
    const todayPnl = todayTrades.reduce((s, t) => s + t.expectedPnl, 0);
    const todayWr = todayTrades.length > 0 ? (todayWins.length / todayTrades.length * 100) : 0;

    // By symbol
    const symbols = ['BTC', 'ETH', 'SOL', 'XRP'];
    const bySymbol = symbols.map(sym => {
        const st = resolved.filter(t => t.crypto === sym);
        const sw = st.filter(t => t.won);
        const sp = st.reduce((s, t) => s + t.expectedPnl, 0);
        return { symbol: sym, trades: st.length, wins: sw.length, losses: st.length - sw.length, pnl: +sp.toFixed(2), wr: st.length > 0 ? +(sw.length / st.length * 100).toFixed(1) : 0 };
    }).filter(s => s.trades > 0);

    // By hour
    const byHour: any[] = [];
    for (let h = 0; h < 24; h++) {
        const ht = resolved.filter(t => {
            const hr = parseInt(t.timestamp.slice(11, 13));
            return hr === h;
        });
        if (ht.length === 0) continue;
        const hw = ht.filter(t => t.won);
        const hp = ht.reduce((s, t) => s + t.expectedPnl, 0);
        byHour.push({ hour: h, trades: ht.length, wins: hw.length, pnl: +hp.toFixed(2), wr: +(hw.length / ht.length * 100).toFixed(1) });
    }

    // Maker vs taker
    const makerTrades = resolved.filter(t => t.execution?.fillType === 'MAKER');
    const takerTrades = resolved.filter(t => t.execution?.fillType !== 'MAKER');
    const makerVsTaker = {
        maker: makerTrades.length,
        taker: takerTrades.length,
        makerPnl: +makerTrades.reduce((s, t) => s + t.expectedPnl, 0).toFixed(2),
        takerPnl: +takerTrades.reduce((s, t) => s + t.expectedPnl, 0).toFixed(2),
    };

    // PnL curve
    let cumPnl = 0;
    const pnlCurve = [0, ...resolved.map(t => { cumPnl += t.expectedPnl; return +cumPnl.toFixed(2); })];

    // Trade list (most recent first)
    const tradeList = resolved.slice().reverse().map(t => ({
        time: t.timestamp.slice(0, 19).replace('T', ' '),
        crypto: t.crypto,
        won: t.won,
        pnl: +t.expectedPnl.toFixed(2),
        ask: t.underdogAsk,
        fillPrice: t.execution?.fillPrice || t.underdogAsk,
        fillType: t.execution?.fillType || 'TAKER',
        signals: t.signals?.signalCount || 0,
        accounts: t.signals?.accounts || [],
    }));

    // Process status
    const botProc = run("ps aux | grep microstructure-bot | grep -v grep | grep tsx | grep live");
    const collectorProc = run("ps aux | grep pricing-collector | grep -v grep | grep tsx");
    const snipeProc = run("ps aux | grep favorite-snipe | grep -v grep | grep tsx");
    const watchdogProc = run("ps aux | grep bot-watchdog | grep -v grep | grep tsx");
    const warnings: string[] = [];
    if (snipeProc) warnings.push('SNIPE BOT STILL RUNNING');
    if (watchdogProc) warnings.push('WATCHDOG STILL RUNNING');

    // Balance
    const balance = await getBalance();

    // Recent log
    const logLines = getLastLogLines(15);
    const recentLog = logLines.filter(l => l.includes('WIN') || l.includes('LOSS') || l.includes('BUY') || l.includes('No qualifying') || l.includes('ENTRY WINDOW') || l.includes('Balance:'));

    return {
        timestamp: now.toISOString(),
        bot: { running: !!botProc, mode: botProc ? 'LIVE' : 'OFF' },
        collector: { running: !!collectorProc },
        warnings,
        balance: +balance.toFixed(2),
        allTime: { trades: resolved.length, wins: wins.length, losses: losses.length, wr: +wr.toFixed(1), pnl: +totalPnl.toFixed(2), avgPnl: +avgPnl.toFixed(2), streak: `${streak}${streakType}` },
        today: { trades: todayTrades.length, wins: todayWins.length, losses: todayTrades.length - todayWins.length, wr: +todayWr.toFixed(1), pnl: +todayPnl.toFixed(2) },
        bySymbol,
        byHour,
        makerVsTaker,
        trades: tradeList,
        pnlCurve,
        recentLog,
    };
}

const server = http.createServer(async (req, res) => {
    if (req.url === '/api/status') {
        try {
            const status = await buildStatus();
            res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
            res.end(JSON.stringify(status));
        } catch (err: any) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
        }
    } else if (req.url === '/' || req.url === '/index.html') {
        const htmlPath = path.join(import.meta.dirname || '.', 'dashboard.html');
        try {
            const html = fs.readFileSync(htmlPath, 'utf-8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
        } catch {
            res.writeHead(404);
            res.end('dashboard.html not found');
        }
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`\n  Polymarket Dashboard running at http://localhost:${PORT}\n`);
    console.log('  Press Ctrl+C to stop.\n');
});
