/**
 * Tunable Parameters for the BTC 5-min Maker Arbitrage Bot
 *
 * THIS IS THE ONLY FILE THE AI EDITS.
 * Keep it small and isolated for clean git diffs.
 */

import type { ArbBotParams } from './types.js';

export const PARAMS: ArbBotParams = {
    // Order placement
    upBidOffset: 0.03,          // Bid 3¢ below midpoint on UP
    downBidOffset: 0.03,        // Bid 3¢ below midpoint on DOWN
    useSymmetricPricing: true,  // Use same offset for both sides

    // Timing
    entryDelaySeconds: 10,      // Wait 10s after market opens
    exitBeforeEndSeconds: 15,   // Cancel 15s before resolution

    // Filters
    minSpreadCents: 1,          // Need at least 1¢ spread
    maxOverroundCents: 4,       // Skip if overround > 4¢
    minBookDepthUsd: 20,        // Need $20+ near touch

    // Risk
    sharesPerSide: 20,          // 20 shares per side
    maxSingleSideLossCents: 30, // Max 30¢ loss on single fill
    cancelOnSingleFill: true,   // Cancel other side immediately

    // Fill simulation
    fillThresholdCents: 0,      // Ask must reach exactly our bid
    partialFillRatio: 1.0,      // Assume full fill if threshold met
};
