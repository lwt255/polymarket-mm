/**
 * Polymarket Trading Database
 * 
 * SQLite database wrapper for trade logging and analysis.
 * 
 * Adapted from hyperliquid-mm trading-db.ts
 */

import Database from 'better-sqlite3';
import * as path from 'path';
import * as fs from 'fs';
import type { Trade, Signal, TradeSource } from '../types.js';

// =============================================================================
// SCHEMA
// =============================================================================

const SCHEMA_SQL = `
-- Trades table
CREATE TABLE IF NOT EXISTS trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trade_id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL,
  entry_price REAL NOT NULL,
  exit_price REAL NOT NULL,
  size REAL NOT NULL,
  entry_time INTEGER NOT NULL,
  exit_time INTEGER NOT NULL,
  pnl_dollar REAL NOT NULL,
  pnl_percent REAL NOT NULL,
  exit_reason TEXT,
  entry_fee REAL,
  exit_fee REAL,
  total_fees REAL,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_trades_source ON trades(source);
CREATE INDEX IF NOT EXISTS idx_trades_condition_id ON trades(condition_id);
CREATE INDEX IF NOT EXISTS idx_trades_entry_time ON trades(entry_time);

-- Signals table
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id TEXT UNIQUE NOT NULL,
  source TEXT NOT NULL,
  condition_id TEXT NOT NULL,
  token_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  side TEXT NOT NULL,
  price REAL NOT NULL,
  confidence REAL,
  reason TEXT,
  timestamp INTEGER NOT NULL,
  executed INTEGER NOT NULL DEFAULT 0,
  skip_reason TEXT,
  trade_id TEXT,
  created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
);

CREATE INDEX IF NOT EXISTS idx_signals_source ON signals(source);
CREATE INDEX IF NOT EXISTS idx_signals_timestamp ON signals(timestamp);
CREATE INDEX IF NOT EXISTS idx_signals_executed ON signals(executed);
`;

// =============================================================================
// TYPES
// =============================================================================

export interface TradeInsert {
    tradeId: string;
    source: TradeSource;
    conditionId: string;
    tokenId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    size: number;
    entryTime: number;
    exitTime: number;
    pnlDollar: number;
    pnlPercent: number;
    exitReason?: string;
    entryFee?: number;
    exitFee?: number;
    totalFees?: number;
}

export interface SignalInsert {
    signalId: string;
    source: TradeSource;
    conditionId: string;
    tokenId: string;
    outcome: 'YES' | 'NO';
    side: 'BUY' | 'SELL';
    price: number;
    confidence?: number;
    reason?: string;
    timestamp: number;
    executed: boolean;
    skipReason?: string;
    tradeId?: string;
}

export interface TradeQueryOptions {
    source?: TradeSource;
    conditionId?: string;
    startTime?: number;
    endTime?: number;
    limit?: number;
    offset?: number;
}

// =============================================================================
// DATABASE CLASS
// =============================================================================

export class TradingDatabase {
    private db: Database.Database;
    private dbPath: string;

    constructor(dbPath: string = './state/polymarket-trades.db') {
        this.dbPath = dbPath;

        // Ensure directory exists
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.exec(SCHEMA_SQL);
    }

    /**
     * Insert a trade record
     */
    insertTrade(trade: TradeInsert): void {
        const stmt = this.db.prepare(`
      INSERT INTO trades (
        trade_id, source, condition_id, token_id, outcome, side,
        entry_price, exit_price, size, entry_time, exit_time,
        pnl_dollar, pnl_percent, exit_reason, entry_fee, exit_fee, total_fees
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?
      )
    `);

        stmt.run(
            trade.tradeId,
            trade.source,
            trade.conditionId,
            trade.tokenId,
            trade.outcome,
            trade.side,
            trade.entryPrice,
            trade.exitPrice,
            trade.size,
            trade.entryTime,
            trade.exitTime,
            trade.pnlDollar,
            trade.pnlPercent,
            trade.exitReason ?? null,
            trade.entryFee ?? null,
            trade.exitFee ?? null,
            trade.totalFees ?? null
        );
    }

    /**
     * Insert a signal record
     */
    insertSignal(signal: SignalInsert): void {
        const stmt = this.db.prepare(`
      INSERT INTO signals (
        signal_id, source, condition_id, token_id, outcome, side,
        price, confidence, reason, timestamp, executed, skip_reason, trade_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

        stmt.run(
            signal.signalId,
            signal.source,
            signal.conditionId,
            signal.tokenId,
            signal.outcome,
            signal.side,
            signal.price,
            signal.confidence ?? null,
            signal.reason ?? null,
            signal.timestamp,
            signal.executed ? 1 : 0,
            signal.skipReason ?? null,
            signal.tradeId ?? null
        );
    }

    /**
     * Query trades with filtering
     */
    queryTrades(options: TradeQueryOptions = {}): TradeInsert[] {
        let sql = 'SELECT * FROM trades WHERE 1=1';
        const params: unknown[] = [];

        if (options.source) {
            sql += ' AND source = ?';
            params.push(options.source);
        }

        if (options.conditionId) {
            sql += ' AND condition_id = ?';
            params.push(options.conditionId);
        }

        if (options.startTime) {
            sql += ' AND entry_time >= ?';
            params.push(options.startTime);
        }

        if (options.endTime) {
            sql += ' AND entry_time <= ?';
            params.push(options.endTime);
        }

        sql += ' ORDER BY entry_time DESC';

        if (options.limit) {
            sql += ' LIMIT ?';
            params.push(options.limit);
        }

        if (options.offset) {
            sql += ' OFFSET ?';
            params.push(options.offset);
        }

        const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];

        return rows.map(row => ({
            tradeId: row.trade_id as string,
            source: row.source as TradeSource,
            conditionId: row.condition_id as string,
            tokenId: row.token_id as string,
            outcome: row.outcome as 'YES' | 'NO',
            side: row.side as 'BUY' | 'SELL',
            entryPrice: row.entry_price as number,
            exitPrice: row.exit_price as number,
            size: row.size as number,
            entryTime: row.entry_time as number,
            exitTime: row.exit_time as number,
            pnlDollar: row.pnl_dollar as number,
            pnlPercent: row.pnl_percent as number,
            exitReason: row.exit_reason as string | undefined,
            entryFee: row.entry_fee as number | undefined,
            exitFee: row.exit_fee as number | undefined,
            totalFees: row.total_fees as number | undefined,
        }));
    }

    /**
     * Get performance summary
     */
    getSummary(source: TradeSource = 'simulation', startTime?: number): {
        totalTrades: number;
        wins: number;
        losses: number;
        winRate: number;
        totalPnl: number;
        avgPnl: number;
        totalFees: number;
    } {
        let sql = `
      SELECT 
        COUNT(*) as total_trades,
        SUM(CASE WHEN pnl_dollar > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN pnl_dollar <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(pnl_dollar) as total_pnl,
        AVG(pnl_dollar) as avg_pnl,
        SUM(COALESCE(total_fees, 0)) as total_fees
      FROM trades
      WHERE source = ?
    `;
        const params: unknown[] = [source];

        if (startTime) {
            sql += ' AND entry_time >= ?';
            params.push(startTime);
        }

        const row = this.db.prepare(sql).get(...params) as Record<string, unknown>;

        const totalTrades = (row.total_trades as number) || 0;
        const wins = (row.wins as number) || 0;
        const losses = (row.losses as number) || 0;

        return {
            totalTrades,
            wins,
            losses,
            winRate: totalTrades > 0 ? (wins / totalTrades) * 100 : 0,
            totalPnl: (row.total_pnl as number) || 0,
            avgPnl: (row.avg_pnl as number) || 0,
            totalFees: (row.total_fees as number) || 0,
        };
    }

    /**
     * Close database connection
     */
    close(): void {
        this.db.close();
    }
}
