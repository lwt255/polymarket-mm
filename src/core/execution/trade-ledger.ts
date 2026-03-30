/**
 * Trade Ledger — Append-only trade log with verification status.
 *
 * Every trade gets recorded with:
 * - What we intended (order details)
 * - What actually happened (fill confirmation)
 * - What the chain says (balance before/after)
 * - Whether it all matches (reconciliation)
 *
 * Writes to both JSONL (human-readable) and optionally SQLite.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';
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

    // Execution
    execution: {
        status: ExecutionResult['status'];
        orderId: string;
        fillPrice: number;
        fillSize: number;
        fillCost: number;
        latencyMs: number;
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
}

export class TradeLedger {
    private logPath: string;
    private tradeCount: number = 0;
    private sessionPnl: number = 0;
    private sessionWins: number = 0;

    constructor(logPath: string = 'underdog-snipe-trades.jsonl') {
        this.logPath = logPath;
        // Count existing trades in the file
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

        appendFileSync(this.logPath, JSON.stringify(record) + '\n');
    }

    getStats(): { trades: number; wins: number; pnl: number; winRate: number } {
        return {
            trades: this.tradeCount,
            wins: this.sessionWins,
            pnl: this.sessionPnl,
            winRate: this.tradeCount > 0 ? this.sessionWins / this.tradeCount : 0,
        };
    }
}
