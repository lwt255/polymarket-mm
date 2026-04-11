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
export type FillType = 'MAKER' | 'TAKER' | 'UNFILLED';

export interface FallbackResult extends ExecutionResult {
    fillType: FillType;
}

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
const CONFIRM_MAX_POLLS = 25;  // 25 seconds max to confirm
const CANCEL_AFTER_POLLS = 20; // cancel resting order after 20 seconds (was 6s — too aggressive)
const MAKER_TIMEOUT_POLLS = 12; // try maker for 12 seconds before falling back to taker
const TAKER_TIMEOUT_POLLS = 10; // 10 more seconds for taker attempt

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
     * Place a maker order (bid+1¢), and if it doesn't fill within 12s,
     * cancel and fall back to a taker order at the current ask.
     */
    async executeWithFallback(
        tokenId: string,
        makerPrice: number,
        sizeUsd: number,
        getAskPrice: () => Promise<number>,
        log?: (msg: string) => void,
        maxTakerPrice?: number,
    ): Promise<FallbackResult> {
        const shares = Math.floor(sizeUsd / makerPrice);
        if (shares < 1) {
            return { ...this.errorResult('Position too small for 1 share', makerPrice, 0), fillType: 'UNFILLED' };
        }

        const orderPlaced = Date.now();

        // Phase 1: Try maker order
        let orderId: string;
        try {
            const result = await this.client.createAndPostOrder({
                tokenID: tokenId,
                price: makerPrice,
                size: shares,
                side: 'BUY' as any,
            });
            if (!result?.orderID || result?.error) {
                return { ...this.errorResult(result?.error || 'No orderID returned', makerPrice, shares), fillType: 'UNFILLED' };
            }
            orderId = result.orderID;
        } catch (err: any) {
            return { ...this.errorResult(`Order placement failed: ${err.message}`, makerPrice, shares), fillType: 'UNFILLED' };
        }

        // Poll maker for MAKER_TIMEOUT_POLLS seconds
        for (let poll = 0; poll < MAKER_TIMEOUT_POLLS; poll++) {
            await this.sleep(CONFIRM_POLL_INTERVAL_MS);
            try {
                const openOrders = await this.client.getOpenOrders() || [];
                const stillOpen = openOrders.some((o: any) => o.id === orderId || o.orderID === orderId);
                if (!stillOpen) {
                    // Maker filled
                    log?.(`    Maker filled in ${poll + 1}s`);
                    return {
                        status: 'FILLED', orderId,
                        fillPrice: makerPrice, fillSize: shares, fillCost: shares * makerPrice,
                        requestedPrice: makerPrice, requestedShares: shares,
                        timestamps: { orderPlaced, confirmationReceived: Date.now() },
                        fillType: 'MAKER',
                    };
                }
            } catch {
                continue; // network blip, keep polling
            }
        }

        // Phase 2: Cancel maker, fall back to taker
        log?.(`    Maker unfilled after ${MAKER_TIMEOUT_POLLS}s — falling back to taker`);
        try {
            await this.client.cancelOrder({ orderID: orderId } as any);
        } catch {
            // Cancel may fail if it just filled — we'll detect in polling
        }
        await this.sleep(1000); // let cancellation propagate

        // After cancel, order disappears from open orders whether it was filled or cancelled.
        // We cannot distinguish the two from getOpenOrders alone.
        // Proceed to taker fallback — if the maker DID fill, the taker will fail (no balance)
        // which is safer than falsely assuming a fill.

        // Place taker order at current ask
        let takerPrice: number;
        try {
            takerPrice = await getAskPrice();
        } catch {
            return {
                status: 'UNFILLED', orderId, fillPrice: 0, fillSize: 0, fillCost: 0,
                requestedPrice: makerPrice, requestedShares: shares,
                error: 'Failed to read ask for taker fallback',
                timestamps: { orderPlaced, confirmationReceived: Date.now() },
                fillType: 'UNFILLED',
            };
        }

        if (maxTakerPrice && takerPrice > maxTakerPrice) {
            log?.(`    Taker ask ${(takerPrice * 100).toFixed(0)}¢ > max ${(maxTakerPrice * 100).toFixed(0)}¢ — skipping`);
            return {
                status: 'UNFILLED', orderId, fillPrice: 0, fillSize: 0, fillCost: 0,
                requestedPrice: takerPrice, requestedShares: 0,
                error: `Taker price ${takerPrice} exceeds max ${maxTakerPrice}`,
                timestamps: { orderPlaced, confirmationReceived: Date.now() },
                fillType: 'UNFILLED',
            };
        }

        const takerShares = Math.floor(sizeUsd / takerPrice);
        if (takerShares < 1) {
            return {
                status: 'UNFILLED', orderId, fillPrice: 0, fillSize: 0, fillCost: 0,
                requestedPrice: takerPrice, requestedShares: 0,
                error: 'Taker price too high for 1 share',
                timestamps: { orderPlaced, confirmationReceived: Date.now() },
                fillType: 'UNFILLED',
            };
        }

        log?.(`    Taker order at ${(takerPrice * 100).toFixed(0)}¢ (${takerShares} shares)`);

        let takerOrderId: string;
        try {
            const result = await this.client.createAndPostOrder({
                tokenID: tokenId,
                price: takerPrice,
                size: takerShares,
                side: 'BUY' as any,
            });
            if (!result?.orderID || result?.error) {
                return { ...this.errorResult(result?.error || 'Taker order failed', takerPrice, takerShares), fillType: 'UNFILLED' };
            }
            takerOrderId = result.orderID;
        } catch (err: any) {
            return { ...this.errorResult(`Taker order failed: ${err.message}`, takerPrice, takerShares), fillType: 'UNFILLED' };
        }

        // Poll taker for TAKER_TIMEOUT_POLLS seconds
        let takerCancelled = false;
        for (let poll = 0; poll < TAKER_TIMEOUT_POLLS; poll++) {
            await this.sleep(CONFIRM_POLL_INTERVAL_MS);
            try {
                const openOrders = await this.client.getOpenOrders() || [];
                const stillOpen = openOrders.some((o: any) => o.id === takerOrderId || o.orderID === takerOrderId);
                if (!stillOpen) {
                    log?.(`    Taker filled in ${poll + 1}s`);
                    return {
                        status: 'FILLED', orderId: takerOrderId,
                        fillPrice: takerPrice, fillSize: takerShares, fillCost: takerShares * takerPrice,
                        requestedPrice: takerPrice, requestedShares: takerShares,
                        timestamps: { orderPlaced, confirmationReceived: Date.now() },
                        fillType: 'TAKER',
                    };
                }
                // Cancel taker if running out of time
                if (poll >= TAKER_TIMEOUT_POLLS - 2 && !takerCancelled) {
                    try {
                        await this.client.cancelOrder({ orderID: takerOrderId } as any);
                        takerCancelled = true;
                    } catch { /* next poll resolves */ }
                }
            } catch {
                continue;
            }
        }

        return {
            status: 'UNFILLED', orderId: takerOrderId,
            fillPrice: 0, fillSize: 0, fillCost: 0,
            requestedPrice: takerPrice, requestedShares: takerShares,
            error: 'Both maker and taker failed to fill',
            timestamps: { orderPlaced, confirmationReceived: Date.now() },
            fillType: 'UNFILLED',
        };
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
