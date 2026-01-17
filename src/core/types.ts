/**
 * Polymarket Core Types
 * 
 * Shared type definitions for Polymarket trading bots.
 */

// =============================================================================
// MARKET & ORDER TYPES
// =============================================================================

export type OrderSide = 'BUY' | 'SELL';
export type OrderStatus = 'PENDING' | 'OPEN' | 'FILLED' | 'CANCELLED' | 'EXPIRED';
export type OrderType = 'LIMIT' | 'MARKET';
export type Outcome = 'YES' | 'NO';

export interface MarketInfo {
    /** Unique market identifier */
    conditionId: string;
    /** Human-readable market question */
    question: string;
    /** Market description */
    description?: string;
    /** Token ID for YES outcome */
    yesTokenId: string;
    /** Token ID for NO outcome */
    noTokenId: string;
    /** Current YES price (0.00 - 1.00) */
    yesPrice: number;
    /** Current NO price (0.00 - 1.00) */
    noPrice: number;
    /** Total liquidity in USD */
    liquidity: number;
    /** 24h volume in USD */
    volume24h: number;
    /** Market end date */
    endDate?: Date;
    /** Whether market is active */
    active: boolean;
}

export interface OrderBook {
    bids: Array<{ price: number; size: number }>;
    asks: Array<{ price: number; size: number }>;
    spread: number;
    midPrice: number;
}

export interface Order {
    id: string;
    tokenId: string;
    side: OrderSide;
    type: OrderType;
    price: number;
    size: number;
    filledSize: number;
    status: OrderStatus;
    createdAt: number;
    updatedAt: number;
}

// =============================================================================
// POSITION & BALANCE TYPES
// =============================================================================

export interface Position {
    tokenId: string;
    conditionId: string;
    outcome: Outcome;
    size: number;
    avgEntryPrice: number;
    currentPrice: number;
    unrealizedPnl: number;
    realizedPnl: number;
}

export interface BalanceInfo {
    /** USDC balance available */
    available: number;
    /** USDC balance locked in orders */
    locked: number;
    /** Total USDC balance */
    total: number;
}

// =============================================================================
// TRADE & SIGNAL TYPES
// =============================================================================

export type TradeSource = 'live' | 'backtest' | 'simulation';
export type ExitReason = 'TP' | 'STOP' | 'MANUAL' | 'TIMEOUT' | 'EXPIRED';

export interface Trade {
    id: string;
    source: TradeSource;
    conditionId: string;
    tokenId: string;
    outcome: Outcome;
    side: OrderSide;
    entryPrice: number;
    exitPrice: number;
    size: number;
    entryTime: number;
    exitTime: number;
    pnlDollar: number;
    pnlPercent: number;
    exitReason: ExitReason;
    fees: {
        entry: number;
        exit: number;
        total: number;
    };
}

export interface Signal {
    id: string;
    timestamp: number;
    conditionId: string;
    tokenId: string;
    outcome: Outcome;
    side: OrderSide;
    price: number;
    confidence: number;
    reason: string;
    executed: boolean;
    skipReason?: string;
}

// =============================================================================
// CONFIG TYPES
// =============================================================================

export interface BotConfig {
    /** Bot name/identifier */
    name: string;
    /** Whether to execute trades (false = paper trading) */
    live: boolean;
    /** Risk per trade in USDC */
    riskPerTrade: number;
    /** Maximum daily loss in USDC */
    maxDailyLoss: number;
    /** Maximum concurrent positions */
    maxPositions: number;
    /** API rate limit (requests per second) */
    rateLimit: number;
    /** Logging level */
    logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface RiskLimits {
    /** Maximum position size in USDC */
    maxPositionSize: number;
    /** Maximum daily loss before kill switch */
    maxDailyLoss: number;
    /** Maximum consecutive losses before cooldown */
    maxConsecutiveLosses: number;
    /** Cooldown minutes after hitting loss limit */
    cooldownMinutes: number;
}
