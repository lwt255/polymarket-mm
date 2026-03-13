/**
 * Autoresearch Loop Types
 * Shared interfaces for the BTC 5-min maker arbitrage autoresearch system.
 */

/** Tunable parameters — the ONLY thing the AI edits */
export interface ArbBotParams {
    // Order placement
    upBidOffset: number;       // How far below midpoint to bid on UP (0.01 = 1¢)
    downBidOffset: number;     // How far below midpoint to bid on DOWN
    useSymmetricPricing: boolean; // If true, use same offset for both sides

    // Timing
    entryDelaySeconds: number;    // Wait N seconds after market opens before placing
    exitBeforeEndSeconds: number; // Cancel unfilled orders N seconds before resolution

    // Filters
    minSpreadCents: number;       // Skip if spread < N cents (too tight)
    maxOverroundCents: number;    // Skip if ask_up + ask_down > 1.00 + N cents
    minBookDepthUsd: number;      // Skip if near-touch depth < $N

    // Risk
    sharesPerSide: number;        // Shares to bid per side
    maxSingleSideLossCents: number; // Max acceptable loss on single-fill scenario
    cancelOnSingleFill: boolean;  // Cancel other side immediately on single fill

    // Fill simulation
    fillThresholdCents: number;   // Best ask must drop to bid + N cents to count as fill
    partialFillRatio: number;     // Fraction of shares assumed filled (0.0–1.0)
}

/** Valid ranges for each parameter (used for validation) */
export const PARAM_RANGES: Record<keyof ArbBotParams, { min: number; max: number } | null> = {
    upBidOffset:            { min: 0.005, max: 0.15 },
    downBidOffset:          { min: 0.005, max: 0.15 },
    useSymmetricPricing:    null, // boolean
    entryDelaySeconds:      { min: 0, max: 120 },
    exitBeforeEndSeconds:   { min: 5, max: 60 },
    minSpreadCents:         { min: 0, max: 10 },
    maxOverroundCents:      { min: 0, max: 10 },
    minBookDepthUsd:        { min: 0, max: 500 },
    sharesPerSide:          { min: 5, max: 200 },
    maxSingleSideLossCents: { min: 1, max: 50 },
    cancelOnSingleFill:     null, // boolean
    fillThresholdCents:     { min: 0, max: 5 },
    partialFillRatio:       { min: 0.1, max: 1.0 },
};

/** Per-market outcome from a dry run */
export interface MarketResult {
    slug: string;
    startTime: number;  // epoch ms
    endTime: number;

    // Book state at entry
    upBestBid: number;
    upBestAsk: number;
    downBestBid: number;
    downBestAsk: number;
    overround: number;   // upAsk + downAsk - 1.0

    // Simulated order
    upBidPrice: number;
    downBidPrice: number;
    combinedCost: number; // upBid + downBid (must be < 1.0 for arb)

    // Fill tracking
    upFilled: boolean;
    downFilled: boolean;
    upFillTime: number | null;
    downFillTime: number | null;

    // Resolution
    outcome: 'UP' | 'DOWN' | 'UNKNOWN';
    pnlCents: number;    // in cents (positive = profit)
    skipped: boolean;
    skipReason?: string;

    // Diagnostics
    pollCount: number;
    nearMisses: number;  // price touched but didn't sustain
    bookSnapshots: number;
}

/** Aggregated stats from a full dry run */
export interface DryRunSummary {
    startTime: number;
    endTime: number;
    durationMinutes: number;
    marketsTraded: number;
    marketsSkipped: number;
    bothFills: number;
    singleFills: number;
    noFills: number;
    bothFillRate: number;      // bothFills / marketsTraded
    netPnlCents: number;
    maxDrawdownCents: number;
    singleFillLossCents: number; // total loss from single-fill scenarios
    avgOverround: number;
}

/** Full output of a dry run */
export interface DryRunResult {
    params: ArbBotParams;
    markets: MarketResult[];
    summary: DryRunSummary;
}

/** Order book snapshot */
export interface BookSnapshot {
    bestBid: number;
    bestAsk: number;
    spread: number;
    midpoint: number;
    bidDepth: number;
    askDepth: number;
    bids: { price: number; size: number }[];
    asks: { price: number; size: number }[];
}

/** Experiment record logged per iteration */
export interface ExperimentRecord {
    iteration: number;
    timestamp: number;
    gitHash: string;
    hypothesis: string;
    params: ArbBotParams;
    score: number;
    previousScore: number;
    accepted: boolean;
    verdict: 'accepted' | 'rejected' | 'inconclusive';
    summary: DryRunSummary;
    durationMinutes: number;
    error?: string;
}
