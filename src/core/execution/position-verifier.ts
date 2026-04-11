/**
 * Position Verifier — On-chain balance verification and max loss enforcement.
 *
 * This is the safety backbone of the execution bot. It reads USDC balance
 * directly from the Polygon chain and enforces hard stop-loss limits.
 *
 * Design principle: NEVER trust internal state. Always verify on-chain.
 */

import { createPublicClient, http, parseAbi } from 'viem';
import { polygon } from 'viem/chains';

const USDC_ADDRESS = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174' as `0x${string}`;
const USDC_ABI = parseAbi(['function balanceOf(address account) view returns (uint256)']);

export interface BalanceCheck {
    balance: number;       // USDC balance in dollars
    success: boolean;      // whether the on-chain read succeeded
    timestamp: number;     // when the check happened
}

export interface MaxLossCheck {
    safe: boolean;
    currentBalance: number;
    floorBalance: number;
    loss: number;
    peakBalance: number;
    trailActive: boolean;  // true when the trailing stop is the binding floor
    reason?: string;       // why it's not safe (if applicable)
}

export interface ReconcileResult {
    expectedPnl: number;
    actualPnl: number;
    discrepancy: number;
    alert: boolean;        // true if discrepancy > threshold
}

export class PositionVerifier {
    private publicClient: ReturnType<typeof createPublicClient>;
    private walletAddress: `0x${string}`;
    private startingBalance: number = -1;
    private floorBalance: number = -1;
    private lastVerifiedBalance: number = -1;
    private peakBalance: number = -1;
    private trailingAmountUsd: number = 0;

    constructor(walletAddress: string, rpcUrl: string = 'https://polygon.drpc.org') {
        this.walletAddress = walletAddress as `0x${string}`;
        this.publicClient = createPublicClient({
            chain: polygon,
            transport: http(rpcUrl),
        });
    }

    /**
     * Read on-chain USDC balance. Returns -1 on failure.
     * This is the ONLY source of truth for how much money we have.
     */
    async getBalance(): Promise<BalanceCheck> {
        // Retry up to 3 times — single RPC failures are common
        for (let attempt = 0; attempt < 3; attempt++) {
            try {
                const raw = await this.publicClient.readContract({
                    address: USDC_ADDRESS,
                    abi: USDC_ABI,
                    functionName: 'balanceOf',
                    args: [this.walletAddress],
                });
                const balance = Number(raw) / 1e6; // USDC has 6 decimals
                this.lastVerifiedBalance = balance;
                return { balance, success: true, timestamp: Date.now() };
            } catch (err) {
                if (attempt < 2) {
                    await new Promise(r => setTimeout(r, 1000)); // wait 1s between retries
                }
            }
        }
        return { balance: -1, success: false, timestamp: Date.now() };
    }

    /**
     * Initialize the verifier by reading starting balance and setting floor.
     * Must be called before any trading. Returns false if balance read fails.
     */
    async initialize(maxLossUsd: number, trailingAmountUsd: number = 0): Promise<boolean> {
        const check = await this.getBalance();
        if (!check.success || check.balance < 0) {
            return false;
        }
        this.startingBalance = check.balance;
        this.peakBalance = check.balance;
        this.floorBalance = check.balance - maxLossUsd;
        this.trailingAmountUsd = trailingAmountUsd;
        return true;
    }

    /**
     * Check if we're within max loss limits.
     * If balance read fails, returns UNSAFE (refuse to trade when blind).
     */
    async checkMaxLoss(): Promise<MaxLossCheck> {
        if (this.floorBalance < 0) {
            return {
                safe: false,
                currentBalance: -1,
                floorBalance: this.floorBalance,
                loss: 0,
                peakBalance: this.peakBalance,
                trailActive: false,
                reason: 'Verifier not initialized — call initialize() first',
            };
        }

        const check = await this.getBalance();
        if (!check.success) {
            return {
                safe: false,
                currentBalance: -1,
                floorBalance: this.floorBalance,
                loss: 0,
                peakBalance: this.peakBalance,
                trailActive: false,
                reason: 'On-chain balance read FAILED — refusing to trade when blind',
            };
        }

        if (check.balance > this.peakBalance) this.peakBalance = check.balance;

        // Effective floor: trailing stop only binds once we've been above starting balance.
        // Until then, the original fixed floor applies.
        let effectiveFloor = this.floorBalance;
        let trailActive = false;
        if (this.trailingAmountUsd > 0 && this.peakBalance > this.startingBalance) {
            const trailFloor = this.peakBalance - this.trailingAmountUsd;
            if (trailFloor > effectiveFloor) {
                effectiveFloor = trailFloor;
                trailActive = true;
            }
        }

        const loss = this.startingBalance - check.balance;
        const safe = check.balance > effectiveFloor;

        const reason = safe
            ? undefined
            : trailActive
                ? `Trailing stop hit: balance $${check.balance.toFixed(2)} <= trail floor $${effectiveFloor.toFixed(2)} (peak $${this.peakBalance.toFixed(2)} - $${this.trailingAmountUsd} trail)`
                : `Balance $${check.balance.toFixed(2)} <= floor $${effectiveFloor.toFixed(2)} (loss: $${loss.toFixed(2)})`;

        return {
            safe,
            currentBalance: check.balance,
            floorBalance: effectiveFloor,
            loss,
            peakBalance: this.peakBalance,
            trailActive,
            reason,
        };
    }

    /**
     * Compare expected P&L to actual on-chain balance change.
     * Use after every trade resolution to detect discrepancies.
     */
    reconcile(expectedPnl: number, balanceBefore: number, balanceAfter: number): ReconcileResult {
        const actualPnl = balanceAfter - balanceBefore;
        const discrepancy = Math.abs(actualPnl - expectedPnl);
        // Alert if discrepancy is more than $0.50 (allows for gas/rounding)
        const alert = discrepancy > 0.50;

        return { expectedPnl, actualPnl, discrepancy, alert };
    }

    getStartingBalance(): number { return this.startingBalance; }
    getFloorBalance(): number { return this.floorBalance; }
    getLastVerifiedBalance(): number { return this.lastVerifiedBalance; }
    getPeakBalance(): number { return this.peakBalance; }
    getWalletAddress(): string { return this.walletAddress; }
}
