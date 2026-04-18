/**
 * Trade Ledger — Append-only trade log with SQLite persistence.
 *
 * Every trade gets recorded to BOTH:
 * - JSONL file (human-readable, backwards compatible)
 * - SQLite database (durable, queryable, survives restarts)
 *
 * The DB is the source of truth. The JSONL is for convenience.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
// @ts-ignore — esModuleInterop mismatch, works at runtime with tsx
import BetterSqlite3 from 'better-sqlite3';
type Database = BetterSqlite3.Database;
type Statement = BetterSqlite3.Statement;
import type { ExecutionResult } from './order-executor.js';
import type { ReconcileResult } from './position-verifier.js';

export interface TradeRecord {
    // Identity
    timestamp: string;
    tradeNumber: number;

    // Market info
    slug: string;
    crypto: string;
    underdogSide: 'UP' | 'DOWN';
    underdogAsk: number;

    // Filters that qualified this trade
    filters: {
        neverOneSided: boolean;
        prevResMatch: boolean;
        twoSidedAtT60: boolean;
    };

    // v3 signals (persisted so we don't lose on restart)
    signals?: {
        signalCount: number;
        accounts: string[];       // e.g. ['flip60', 'cross>=2']
        flip60: boolean;
        isUSEve: boolean;
        isWeekend: boolean;
        crossSame: number;
        leaderRising: boolean | null;
        prevMatchesFav: boolean;
        stoppedOut: boolean;      // was this trade stopped by poll-based stop?
        holdPnl: number;          // what P&L would have been without stop
    };

    // Execution
    execution: {
        status: ExecutionResult['status'];
        orderId: string;
        fillPrice: number;
        fillSize: number;
        fillCost: number;
        latencyMs: number;
        fillType?: 'MAKER' | 'TAKER' | 'UNFILLED';
        // Set when the executor declared UNFILLED but on-chain shares were
        // found at resolution time (false-positive phantom detection). The
        // trade is reclassified as FILLED using inferred size/price so the
        // ledger reflects reality; this flag marks it as audit-worthy.
        recoveredFromPhantom?: boolean;
    };

    // Resolution
    resolution: string;     // 'UP' | 'DOWN' | 'UNKNOWN'
    won: boolean;
    expectedPnl: number;

    // On-chain verification
    balanceBefore: number;
    balanceAfter: number;
    reconciliation: ReconcileResult | null;

    // Running totals
    sessionPnl: number;
    sessionTrades: number;
    sessionWins: number;

    // Version tracking
    botVersion?: string;
}

export class TradeLedger {
    private logPath: string;
    private db: Database;
    private insertStmt: Statement;
    private tradeCount: number = 0;
    private sessionPnl: number = 0;
    private sessionWins: number = 0;

    constructor(logPath: string = 'underdog-snipe-trades.jsonl', dbPath: string = 'state/trades.db') {
        this.logPath = logPath;

        // Count existing trades in JSONL for backwards compat
        if (existsSync(logPath)) {
            try {
                const content = readFileSync(logPath, 'utf-8').trim();
                if (content) {
                    this.tradeCount = content.split('\n').length;
                }
            } catch {
                this.tradeCount = 0;
            }
        }

        // Initialize SQLite
        this.db = new BetterSqlite3(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                trade_number INTEGER,
                slug TEXT NOT NULL,
                crypto TEXT NOT NULL,
                leader_side TEXT NOT NULL,
                leader_ask REAL NOT NULL,

                -- Signals
                signal_count INTEGER,
                accounts TEXT,
                flip60 INTEGER,
                is_us_eve INTEGER,
                is_weekend INTEGER,
                cross_same INTEGER,
                leader_rising INTEGER,
                prev_match_fav INTEGER,
                stopped_out INTEGER DEFAULT 0,
                hold_pnl REAL,

                -- Execution
                exec_status TEXT,
                order_id TEXT,
                fill_price REAL,
                fill_size REAL,
                fill_cost REAL,
                latency_ms REAL,

                -- Resolution
                resolution TEXT,
                won INTEGER,
                expected_pnl REAL,

                -- Verification
                balance_before REAL,
                balance_after REAL,

                -- Version tracking
                bot_version TEXT DEFAULT 'v4',

                -- Full record as JSON (for anything we missed)
                raw_json TEXT
            )
        `);

        this.db.exec(`
            CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp);
            CREATE INDEX IF NOT EXISTS idx_trades_crypto ON trades(crypto);
            CREATE INDEX IF NOT EXISTS idx_trades_slug ON trades(slug);
        `);

        this.insertStmt = this.db.prepare(`
            INSERT INTO trades (
                timestamp, trade_number, slug, crypto, leader_side, leader_ask,
                signal_count, accounts, flip60, is_us_eve, is_weekend, cross_same,
                leader_rising, prev_match_fav, stopped_out, hold_pnl,
                exec_status, order_id, fill_price, fill_size, fill_cost, latency_ms,
                resolution, won, expected_pnl,
                balance_before, balance_after,
                bot_version, raw_json
            ) VALUES (
                @timestamp, @trade_number, @slug, @crypto, @leader_side, @leader_ask,
                @signal_count, @accounts, @flip60, @is_us_eve, @is_weekend, @cross_same,
                @leader_rising, @prev_match_fav, @stopped_out, @hold_pnl,
                @exec_status, @order_id, @fill_price, @fill_size, @fill_cost, @latency_ms,
                @resolution, @won, @expected_pnl,
                @balance_before, @balance_after,
                @bot_version, @raw_json
            )
        `);

        // Import existing JSONL trades into DB if DB is empty
        const dbCount = this.db.prepare('SELECT COUNT(*) as n FROM trades').get() as any;
        if (dbCount.n === 0 && this.tradeCount > 0) {
            this.importJsonlToDb();
        }

        this.hydrateSessionState();
    }

    private importJsonlToDb(): void {
        try {
            const content = readFileSync(this.logPath, 'utf-8').trim();
            if (!content) return;
            const lines = content.split('\n');
            const importMany = this.db.transaction((records: any[]) => {
                for (const raw of records) {
                    this.insertToDb(raw);
                }
            });
            const records = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
            importMany(records);
            console.log(`[TradeLedger] Imported ${records.length} existing trades into SQLite`);
        } catch (e: any) {
            console.log(`[TradeLedger] JSONL import failed: ${e.message}`);
        }
    }

    private insertToDb(record: TradeRecord): void {
        try {
            this.insertStmt.run({
                timestamp: record.timestamp,
                trade_number: record.tradeNumber,
                slug: record.slug,
                crypto: record.crypto,
                leader_side: record.underdogSide,
                leader_ask: record.underdogAsk,
                signal_count: record.signals?.signalCount ?? null,
                accounts: record.signals?.accounts ? JSON.stringify(record.signals.accounts) : null,
                flip60: record.signals?.flip60 ? 1 : 0,
                is_us_eve: record.signals?.isUSEve ? 1 : 0,
                is_weekend: record.signals?.isWeekend ? 1 : 0,
                cross_same: record.signals?.crossSame ?? null,
                leader_rising: record.signals?.leaderRising === true ? 1 : record.signals?.leaderRising === false ? 0 : null,
                prev_match_fav: record.signals?.prevMatchesFav ? 1 : 0,
                stopped_out: record.signals?.stoppedOut ? 1 : 0,
                hold_pnl: record.signals?.holdPnl ?? null,
                exec_status: record.execution.status,
                order_id: record.execution.orderId,
                fill_price: record.execution.fillPrice,
                fill_size: record.execution.fillSize,
                fill_cost: record.execution.fillCost,
                latency_ms: record.execution.latencyMs,
                resolution: record.resolution,
                won: record.won ? 1 : 0,
                expected_pnl: record.expectedPnl,
                balance_before: record.balanceBefore,
                balance_after: record.balanceAfter,
                bot_version: record.botVersion || 'v4',
                raw_json: JSON.stringify(record),
            });
        } catch (e: any) {
            console.log(`[TradeLedger] DB insert failed: ${e.message}`);
        }
    }

    private hydrateSessionState(): void {
        try {
            const rows = this.db.prepare(`
                SELECT trade_number, raw_json
                FROM trades
                ORDER BY id
            `).all() as any[];

            if (rows.length === 0) {
                this.tradeCount = 0;
                this.sessionPnl = 0;
                this.sessionWins = 0;
                return;
            }

            const lastRow = rows[rows.length - 1];
            this.tradeCount = Number(lastRow?.trade_number ?? rows.length);
            this.sessionPnl = 0;
            this.sessionWins = 0;

            for (const row of rows) {
                try {
                    const raw = JSON.parse(row.raw_json);
                    if (raw?.execution?.status === 'FILLED') {
                        this.sessionPnl += Number(raw?.reconciliation?.actualPnl ?? raw?.expectedPnl ?? 0);
                        if (raw?.won) this.sessionWins++;
                    }
                } catch {
                    // Fall back to DB aggregates below if any row is malformed.
                    const totals = this.db.prepare(`
                        SELECT
                            COALESCE(SUM(won), 0) as wins,
                            COALESCE(SUM(expected_pnl), 0) as pnl
                        FROM trades
                        WHERE exec_status = 'FILLED'
                    `).get() as any;

                    this.sessionWins = Number(totals?.wins ?? 0);
                    this.sessionPnl = Number(totals?.pnl ?? 0);
                    return;
                }
            }
        } catch (e: any) {
            console.log(`[TradeLedger] Session hydrate failed: ${e.message}`);
            this.sessionPnl = 0;
            this.sessionWins = 0;
        }
    }

    recordTrade(record: TradeRecord): void {
        this.tradeCount++;
        record.tradeNumber = this.tradeCount;
        record.sessionTrades = this.tradeCount;

        if (record.execution.status === 'FILLED') {
            this.sessionPnl += record.reconciliation?.actualPnl ?? record.expectedPnl;
            if (record.won) this.sessionWins++;
        }
        record.sessionPnl = this.sessionPnl;
        record.sessionWins = this.sessionWins;

        // Write to both JSONL and SQLite
        appendFileSync(this.logPath, JSON.stringify(record) + '\n');
        this.insertToDb(record);
    }

    getStats(): { trades: number; wins: number; pnl: number; winRate: number } {
        return {
            trades: this.tradeCount,
            wins: this.sessionWins,
            pnl: this.sessionPnl,
            winRate: this.tradeCount > 0 ? this.sessionWins / this.tradeCount : 0,
        };
    }

    // Query helpers for analysis
    getAllTrades(): TradeRecord[] {
        const rows = this.db.prepare('SELECT raw_json FROM trades ORDER BY timestamp').all() as any[];
        return rows.map(r => JSON.parse(r.raw_json));
    }

    getTradesByDate(date: string): TradeRecord[] {
        const rows = this.db.prepare("SELECT raw_json FROM trades WHERE timestamp LIKE ? || '%' ORDER BY timestamp").all(date) as any[];
        return rows.map(r => JSON.parse(r.raw_json));
    }

    getSignalStats(): any[] {
        return this.db.prepare(`
            SELECT signal_count,
                   COUNT(*) as n,
                   SUM(won) as wins,
                   ROUND(SUM(expected_pnl), 2) as total_pnl,
                   ROUND(AVG(expected_pnl), 2) as avg_pnl
            FROM trades
            WHERE resolution IN ('UP', 'DOWN') AND signal_count IS NOT NULL
            GROUP BY signal_count
            ORDER BY signal_count
        `).all();
    }
}
