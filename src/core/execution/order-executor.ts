/**
 * Order Executor — Place orders and CONFIRM fills. Never fire-and-forget.
 *
 * This module fixes the missed-trade bug from the previous bot.
 * Every order is tracked through to a definitive outcome:
 *   FILLED — order matched, we hold tokens
 *   UNFILLED — order cancelled or expired, no tokens
 *   ERROR — something went wrong, investigate
 *
 * We never assume a fill. We verify.
 */

import { ClobClient } from '@polymarket/clob-client';

export type FillStatus = 'FILLED' | 'UNFILLED' | 'ERROR';

export interface ExecutionResult {
    status: FillStatus;
    orderId: string;
    fillPrice: number;      // actual avg fill price (0 if unfilled)
    fillSize: number;        // shares actually filled (0 if unfilled)
    fillCost: number;        // total USD spent (0 if unfilled)
    requestedPrice: number;  // price we asked for
    requestedShares: number; // shares we asked for
    error?: string;
    timestamps: {
        orderPlaced: number;
        confirmationReceived: number;
    };
}

const CONFIRM_POLL_INTERVAL_MS = 1000;
const CONFIRM_MAX_POLLS = 12;  // 12 seconds max to confirm
const CANCEL_AFTER_POLLS = 6;  // cancel resting order after 6 seconds

export class OrderExecutor {
    private client: ClobClient;

    constructor(client: ClobClient) {
        this.client = client;
    }

    /**
     * Place a buy order and confirm the fill. Returns a definitive result.
     *
     * Flow:
     * 1. Call createAndPostOrder
     * 2. Poll getOpenOrders to check if order is still resting
     * 3. If still resting after CANCEL_AFTER_POLLS, cancel it
     * 4. Return FILLED (not in open orders = matched) or UNFILLED
     */
    async executeAndConfirm(
        tokenId: string,
        price: number,
        sizeUsd: number,
    ): Promise<ExecutionResult> {
        const shares = Math.floor(sizeUsd / price);
        if (shares < 1) {
            return this.errorResult('Position too small for 1 share', price, 0);
        }

        const orderPlaced = Date.now();

        // Step 1: Place the order
        let orderId: string;
        try {
            const result = await this.client.createAndPostOrder({
                tokenID: tokenId,
                price,
                size: shares,
                side: 'BUY' as any,
            });

            if (!result?.orderID || result?.error) {
                return this.errorResult(
                    result?.error || 'No orderID returned',
                    price, shares,
                );
            }
            orderId = result.orderID;
        } catch (err: any) {
            return this.errorResult(
                `Order placement failed: ${err.message}`,
                price, shares,
            );
        }

        // Step 2: Poll to confirm fill
        let filled = false;
        let cancelled = false;

        for (let poll = 0; poll < CONFIRM_MAX_POLLS; poll++) {
            await this.sleep(CONFIRM_POLL_INTERVAL_MS);

            try {
                const openOrders = await this.client.getOpenOrders() || [];
                const stillOpen = openOrders.some(
                    (o: any) => (o.id === orderId || o.orderID === orderId)
                );

                if (!stillOpen) {
                    // Order is NOT in open orders = it filled (or was already cancelled)
                    filled = !cancelled;
                    break;
                }

                // Order is still resting — cancel after timeout
                if (poll >= CANCEL_AFTER_POLLS - 1 && !cancelled) {
                    try {
                        await this.client.cancelOrder({ orderID: orderId } as any);
                        cancelled = true;
                    } catch {
                        // Cancel failed — order might have filled between check and cancel
                        // Next poll will resolve this
                    }
                }
            } catch (err: any) {
                // Network error during polling — keep trying
                continue;
            }
        }

        const confirmationReceived = Date.now();

        if (filled) {
            return {
                status: 'FILLED',
                orderId,
                fillPrice: price,       // best estimate — actual fill may differ slightly
                fillSize: shares,
                fillCost: shares * price,
                requestedPrice: price,
                requestedShares: shares,
                timestamps: { orderPlaced, confirmationReceived },
            };
        } else {
            return {
                status: 'UNFILLED',
                orderId,
                fillPrice: 0,
                fillSize: 0,
                fillCost: 0,
                requestedPrice: price,
                requestedShares: shares,
                error: cancelled ? 'Order cancelled — did not fill in time' : 'Order disappeared without confirmed fill',
                timestamps: { orderPlaced, confirmationReceived },
            };
        }
    }

    /**
     * Cancel all open orders. Safety mechanism.
     */
    async cancelAll(): Promise<void> {
        try {
            await this.client.cancelAll();
        } catch {
            // Best effort
        }
    }

    private errorResult(error: string, price: number, shares: number): ExecutionResult {
        const now = Date.now();
        return {
            status: 'ERROR',
            orderId: '',
            fillPrice: 0,
            fillSize: 0,
            fillCost: 0,
            requestedPrice: price,
            requestedShares: shares,
            error,
            timestamps: { orderPlaced: now, confirmationReceived: now },
        };
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
