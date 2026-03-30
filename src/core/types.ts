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

export interface Candle {
    timestamp: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}

export interface PriceHistoryPoint {
    t: number; // timestamp
    p: number; // price
}

export interface PriceHistoryParams {
    market: string;
    interval: '1m' | '5m' | '15m' | '1h' | '6h' | '1d' | '1w';
    startTs?: number;
    endTs?: number;
    fidelity?: number;
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

export interface ClobTrade {
    id: string;
    price: number;
    size: number;
    side: OrderSide;
    timestamp: number;
    tokenId: string;
}

export interface TradeParams {
    id?: string;
    maker_address?: string;
    market?: string;
    asset_id?: string;
    before?: string;
    after?: string;
    limit?: number;
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

// =============================================================================
// BACKTEST TYPES
// =============================================================================

export interface ExecutionModelConfig {
    /** Base fill probability (0.0 - 1.0). Realistic: 0.5-0.7 */
    baseFillProbability: number;
    /** Fill probability reduction per $100 order size. Realistic: 0.05-0.15 */
    fillProbabilityDecayPerHundred: number;
    /** Adverse selection penalty (0.0 - 1.0). Applied when fills happen. Realistic: 0.001-0.003 */
    adverseSelectionPenalty: number;
    /** Minimum fill ratio for partial fills (0.0 - 1.0). Realistic: 0.5-0.8 */
    minPartialFillRatio: number;
    /** Whether to enable realistic execution modeling */
    enabled: boolean;
}

export const DEFAULT_EXECUTION_MODEL: ExecutionModelConfig = {
    baseFillProbability: 0.70,
    fillProbabilityDecayPerHundred: 0.10,
    adverseSelectionPenalty: 0.002,
    minPartialFillRatio: 0.5,
    enabled: true,
};

export interface BacktestConfig {
    marketId: string;
    yesTokenId: string;
    noTokenId: string;
    startTime: number;
    endTime: number;
    initialBalance: number;
    takerFee: number;
    makerFee: number;
    slippage: number; // Decimal (e.g. 0.001 for 0.1%)
    /** Execution model configuration for realistic fill simulation */
    executionModel?: ExecutionModelConfig;
}

export interface BacktestStats {
    totalTrades: number;
    wins: number;
    losses: number;
    winRate: number;
    profitDollar: number;
    profitPercent: number;
    maxDrawdown: number;
    /** Additional stats for execution model analysis */
    fillAttempts?: number;
    actualFills?: number;
    fillRate?: number;
    avgFillRatio?: number;
    adverseSelectionCost?: number;
}

// =============================================================================
// EVENT CALENDAR TYPES
// =============================================================================

export type EventType = 'FED_MEETING' | 'ELECTION' | 'SPORTS_FINAL' | 'EARNINGS' | 'CUSTOM';
export type EventImpact = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface MarketEvent {
    id: string;
    name: string;
    type: EventType;
    impact: EventImpact;
    /** Event timestamp (when the event occurs) */
    timestamp: number;
    /** Related market condition IDs */
    relatedMarkets: string[];
    /** Expected price move in percentage (e.g., 0.10 for 10%) */
    expectedMove?: number;
    /** Pre-event window in minutes (when to start positioning) */
    preEventWindowMinutes: number;
    /** Post-event window in minutes (when to exit positions) */
    postEventWindowMinutes: number;
}
