/**
 * Polymarket Risk Manager
 * 
 * Manages risk controls for trading bots:
 * - Daily loss limits
 * - Position sizing based on stop distance
 * - Consecutive loss cooldowns
 * - Kill switch for emergency stops
 * 
 * Adapted from hyperliquid-mm risk-manager.ts
 */

import type { RiskLimits, BotConfig } from '../types.js';

// =============================================================================
// TYPES
// =============================================================================

export interface RiskConfig {
    /** Starting account balance in USDC */
    accountBalance: number;
    /** Risk per trade in USDC */
    riskPerTrade: number;
    /** Maximum daily loss in USDC */
    maxDailyLoss: number;
    /** Maximum consecutive losses before cooldown */
    maxConsecutiveLosses: number;
    /** Cooldown after hitting loss limit (minutes) */
    cooldownAfterLossesMinutes: number;
    /** Maximum concurrent positions */
    maxConcurrentPositions: number;
}

export interface TokenRiskState {
    symbol: string;
    dailyPnl: number;
    dailyTradeCount: number;
    consecutiveLosses: number;
    lastTradeTime: number;
    hasOpenPosition: boolean;
    isPaused: boolean;
    pauseReason?: string;
    pauseUntil?: number;
}

export interface AccountRiskState {
    balance: number;
    peakBalance: number;
    dailyPnl: number;
    totalTradeCount: number;
    consecutiveLosses: number;
    currentPositions: number;
    isPaused: boolean;
    pauseReason?: string;
    pauseUntil?: number;
}

export interface TradeResult {
    symbol: string;
    pnl: number;
    timestamp: number;
}

// =============================================================================
// DEFAULT CONFIG
// =============================================================================

const DEFAULT_CONFIG: RiskConfig = {
    accountBalance: 1000,
    riskPerTrade: 10,
    maxDailyLoss: 100,
    maxConsecutiveLosses: 3,
    cooldownAfterLossesMinutes: 60,
    maxConcurrentPositions: 5,
};

// =============================================================================
// RISK MANAGER CLASS
// =============================================================================

export class RiskManager {
    private config: RiskConfig;
    private accountState: AccountRiskState;
    private tokenStates: Map<string, TokenRiskState>;
    private startOfDay: number;

    constructor(config: Partial<RiskConfig> = {}) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.tokenStates = new Map();
        this.startOfDay = this.getStartOfDay();

        this.accountState = {
            balance: this.config.accountBalance,
            peakBalance: this.config.accountBalance,
            dailyPnl: 0,
            totalTradeCount: 0,
            consecutiveLosses: 0,
            currentPositions: 0,
            isPaused: false,
        };
    }

    /**
     * Get start of current day (midnight UTC)
     */
    private getStartOfDay(): number {
        const now = new Date();
        now.setUTCHours(0, 0, 0, 0);
        return now.getTime();
    }

    /**
     * Check for day rollover and reset daily stats
     */
    private checkDayRollover(): void {
        const currentDayStart = this.getStartOfDay();
        if (currentDayStart > this.startOfDay) {
            console.log('[RISK] Day rollover detected, resetting daily stats');
            this.startOfDay = currentDayStart;
            this.accountState.dailyPnl = 0;
            this.accountState.consecutiveLosses = 0;
            this.accountState.isPaused = false;
            this.accountState.pauseReason = undefined;
            this.accountState.pauseUntil = undefined;

            // Reset token daily stats
            for (const state of this.tokenStates.values()) {
                state.dailyPnl = 0;
                state.dailyTradeCount = 0;
                state.consecutiveLosses = 0;
                state.isPaused = false;
                state.pauseReason = undefined;
                state.pauseUntil = undefined;
            }
        }
    }

    /**
     * Get or create token risk state
     */
    private getTokenState(symbol: string): TokenRiskState {
        if (!this.tokenStates.has(symbol)) {
            this.tokenStates.set(symbol, {
                symbol,
                dailyPnl: 0,
                dailyTradeCount: 0,
                consecutiveLosses: 0,
                lastTradeTime: 0,
                hasOpenPosition: false,
                isPaused: false,
            });
        }
        return this.tokenStates.get(symbol)!;
    }

    /**
     * Check if trading is allowed
     */
    canOpenPosition(symbol: string): { allowed: boolean; reason?: string } {
        this.checkDayRollover();
        this.checkCooldowns();

        // Check account-level pauses
        if (this.accountState.isPaused) {
            return { allowed: false, reason: this.accountState.pauseReason || 'Account paused' };
        }

        // Check daily loss limit
        if (this.accountState.dailyPnl <= -this.config.maxDailyLoss) {
            return { allowed: false, reason: `Daily loss limit reached: $${Math.abs(this.accountState.dailyPnl).toFixed(2)}` };
        }

        // Check max positions
        if (this.accountState.currentPositions >= this.config.maxConcurrentPositions) {
            return { allowed: false, reason: `Max positions reached: ${this.config.maxConcurrentPositions}` };
        }

        // Check token-level pauses
        const tokenState = this.getTokenState(symbol);
        if (tokenState.isPaused) {
            return { allowed: false, reason: tokenState.pauseReason || `${symbol} paused` };
        }

        // Check if already has position
        if (tokenState.hasOpenPosition) {
            return { allowed: false, reason: `Already has open position in ${symbol}` };
        }

        return { allowed: true };
    }

    /**
     * Calculate position size based on risk per trade and stop distance
     */
    calculatePositionSize(
        entryPrice: number,
        stopPrice: number,
        riskMultiplier: number = 1.0
    ): { sizeUsd: number; risk: number } {
        const stopPercent = Math.abs(entryPrice - stopPrice) / entryPrice;
        const riskDollars = this.config.riskPerTrade * riskMultiplier;
        const sizeUsd = riskDollars / stopPercent;

        return {
            sizeUsd: Math.round(sizeUsd * 100) / 100,
            risk: riskDollars,
        };
    }

    /**
     * Mark position as opened
     */
    onPositionOpened(symbol: string): void {
        const tokenState = this.getTokenState(symbol);
        tokenState.hasOpenPosition = true;
        this.accountState.currentPositions++;
    }

    /**
     * Record trade result and update risk states
     */
    recordTradeResult(result: TradeResult): void {
        this.checkDayRollover();

        const tokenState = this.getTokenState(result.symbol);

        // Update token state
        tokenState.hasOpenPosition = false;
        tokenState.dailyPnl += result.pnl;
        tokenState.dailyTradeCount++;
        tokenState.lastTradeTime = result.timestamp;

        // Update account state
        this.accountState.currentPositions = Math.max(0, this.accountState.currentPositions - 1);
        this.accountState.balance += result.pnl;
        this.accountState.dailyPnl += result.pnl;
        this.accountState.totalTradeCount++;

        if (this.accountState.balance > this.accountState.peakBalance) {
            this.accountState.peakBalance = this.accountState.balance;
        }

        // Track consecutive losses
        if (result.pnl < 0) {
            tokenState.consecutiveLosses++;
            this.accountState.consecutiveLosses++;

            // Check for consecutive loss pause
            if (tokenState.consecutiveLosses >= this.config.maxConsecutiveLosses) {
                tokenState.isPaused = true;
                tokenState.pauseReason = `${tokenState.consecutiveLosses} consecutive losses`;
                tokenState.pauseUntil = Date.now() + this.config.cooldownAfterLossesMinutes * 60 * 1000;
                console.log(`[RISK] ${result.symbol} paused: ${tokenState.pauseReason}`);
            }
        } else {
            tokenState.consecutiveLosses = 0;
            this.accountState.consecutiveLosses = 0;
        }

        // Check daily loss limit
        if (this.accountState.dailyPnl <= -this.config.maxDailyLoss) {
            this.accountState.isPaused = true;
            this.accountState.pauseReason = 'Daily loss limit reached';
            console.log(`[RISK] Account paused: ${this.accountState.pauseReason}`);
        }

        console.log(
            `[RISK] Trade recorded: ${result.symbol} $${result.pnl.toFixed(2)} | ` +
            `Daily: $${this.accountState.dailyPnl.toFixed(2)} | ` +
            `Balance: $${this.accountState.balance.toFixed(2)}`
        );
    }

    /**
     * Check and clear expired cooldowns
     */
    private checkCooldowns(): void {
        const now = Date.now();

        // Check account cooldown
        if (this.accountState.isPaused && this.accountState.pauseUntil && now >= this.accountState.pauseUntil) {
            console.log('[RISK] Account cooldown expired, resuming');
            this.accountState.isPaused = false;
            this.accountState.pauseReason = undefined;
            this.accountState.pauseUntil = undefined;
        }

        // Check token cooldowns
        for (const state of this.tokenStates.values()) {
            if (state.isPaused && state.pauseUntil && now >= state.pauseUntil) {
                console.log(`[RISK] ${state.symbol} cooldown expired, resuming`);
                state.isPaused = false;
                state.pauseReason = undefined;
                state.pauseUntil = undefined;
                state.consecutiveLosses = 0;
            }
        }
    }

    /**
     * Trigger kill switch - pause all trading
     */
    triggerKillSwitch(reason: string): void {
        console.log(`[RISK] 🛑 KILL SWITCH TRIGGERED: ${reason}`);
        this.accountState.isPaused = true;
        this.accountState.pauseReason = `Kill switch: ${reason}`;
        // No auto-resume for kill switch
    }

    /**
     * Manually unpause trading
     */
    manualUnpause(symbol?: string): void {
        if (symbol) {
            const state = this.getTokenState(symbol);
            state.isPaused = false;
            state.pauseReason = undefined;
            state.pauseUntil = undefined;
            state.consecutiveLosses = 0;
            console.log(`[RISK] ${symbol} manually unpaused`);
        } else {
            this.accountState.isPaused = false;
            this.accountState.pauseReason = undefined;
            this.accountState.pauseUntil = undefined;
            console.log('[RISK] Account manually unpaused');
        }
    }

    /**
     * Get current risk status
     */
    getStatus(): {
        account: AccountRiskState;
        tokens: TokenRiskState[];
        canTrade: boolean;
    } {
        this.checkDayRollover();
        this.checkCooldowns();

        return {
            account: { ...this.accountState },
            tokens: Array.from(this.tokenStates.values()),
            canTrade: !this.accountState.isPaused && this.accountState.dailyPnl > -this.config.maxDailyLoss,
        };
    }

    /**
     * Reset risk manager (for testing)
     */
    reset(newBalance?: number): void {
        this.accountState = {
            balance: newBalance ?? this.config.accountBalance,
            peakBalance: newBalance ?? this.config.accountBalance,
            dailyPnl: 0,
            totalTradeCount: 0,
            consecutiveLosses: 0,
            currentPositions: 0,
            isPaused: false,
        };
        this.tokenStates.clear();
        this.startOfDay = this.getStartOfDay();
    }
}
