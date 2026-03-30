/**
 * Binary Option Fair Value Calculator
 *
 * Uses Black-Scholes N(d2) to calculate the statistically fair probability
 * that BTC will close a 5-minute candle UP (close >= open).
 *
 * Fair_Price = N(d2) where:
 *   d2 = [ln(S/K) + (r - sigma^2/2) * T] / (sigma * sqrt(T))
 *
 * For "Up or Down" markets: K = opening price, S = current price
 * The question is: P(S_T >= K) = N(d2)
 */

// Standard normal CDF (Abramowitz & Stegun approximation)
function normalCDF(x: number): number {
    const a1 = 0.254829592;
    const a2 = -0.284496736;
    const a3 = 1.421413741;
    const a4 = -1.453152027;
    const a5 = 1.061405429;
    const p = 0.3275911;

    const sign = x < 0 ? -1 : 1;
    x = Math.abs(x) / Math.sqrt(2);

    const t = 1.0 / (1.0 + p * x);
    const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);

    return 0.5 * (1.0 + sign * y);
}

export interface FairValueParams {
    spotPrice: number;       // Current BTC price (S)
    strikePrice: number;     // Opening/strike price (K)
    timeToExpiryMin: number; // Minutes until expiry
    annualizedVol: number;   // Annualized volatility (sigma), e.g., 0.50 = 50%
}

export interface FairValueResult {
    fairPrice: number;       // Fair probability of "Up" (0-1)
    d2: number;
    moneyness: number;       // ln(S/K) - how far in/out of the money
    timeValue: number;       // How much time decay is left
    edge: number;            // fairPrice - 0.50 (deviation from coin flip)
}

/**
 * Calculate fair value of "Up" outcome using N(d2)
 */
export function calculateFairValue(params: FairValueParams): FairValueResult {
    const { spotPrice, strikePrice, timeToExpiryMin, annualizedVol } = params;

    // Convert minutes to years
    const T = timeToExpiryMin / (365.25 * 24 * 60);

    // Risk-free rate negligible for 5-min, set to 0
    const r = 0;

    const moneyness = Math.log(spotPrice / strikePrice);
    const sqrtT = Math.sqrt(T);

    // Handle edge cases
    if (T <= 0 || sqrtT === 0) {
        // At expiry: deterministic
        return {
            fairPrice: spotPrice >= strikePrice ? 1.0 : 0.0,
            d2: spotPrice >= strikePrice ? Infinity : -Infinity,
            moneyness,
            timeValue: 0,
            edge: spotPrice >= strikePrice ? 0.5 : -0.5,
        };
    }

    if (annualizedVol <= 0) {
        // Zero vol: deterministic
        return {
            fairPrice: spotPrice >= strikePrice ? 1.0 : 0.0,
            d2: spotPrice >= strikePrice ? Infinity : -Infinity,
            moneyness,
            timeValue: 0,
            edge: spotPrice >= strikePrice ? 0.5 : -0.5,
        };
    }

    const d2 = (moneyness + (r - (annualizedVol ** 2) / 2) * T) / (annualizedVol * sqrtT);
    const fairPrice = normalCDF(d2);

    return {
        fairPrice,
        d2,
        moneyness,
        timeValue: annualizedVol * sqrtT,
        edge: fairPrice - 0.50,
    };
}

/**
 * Calculate realized volatility from recent price returns
 * Uses 5-minute returns over a lookback window
 */
export function calculateRealizedVol(prices: number[], intervalMinutes: number = 5): number {
    if (prices.length < 2) return 0;

    // Calculate log returns
    const returns: number[] = [];
    for (let i = 1; i < prices.length; i++) {
        if (prices[i] > 0 && prices[i - 1] > 0) {
            returns.push(Math.log(prices[i] / prices[i - 1]));
        }
    }

    if (returns.length < 2) return 0;

    // Standard deviation of returns
    const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
    const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / (returns.length - 1);
    const stdDev = Math.sqrt(variance);

    // Annualize: multiply by sqrt(periods per year)
    const periodsPerYear = (365.25 * 24 * 60) / intervalMinutes;
    const annualizedVol = stdDev * Math.sqrt(periodsPerYear);

    return annualizedVol;
}

/**
 * Calculate the edge of trading at a given market price vs fair value
 */
export function calculateEdge(marketPrice: number, fairPrice: number, side: 'buy' | 'sell'): {
    edge: number;
    edgePct: number;
    profitable: boolean;
} {
    if (side === 'buy') {
        // Buying: profit if fair > market
        const edge = fairPrice - marketPrice;
        return {
            edge,
            edgePct: (edge / marketPrice) * 100,
            profitable: edge > 0,
        };
    } else {
        // Selling: profit if fair < market
        const edge = marketPrice - fairPrice;
        return {
            edge,
            edgePct: (edge / marketPrice) * 100,
            profitable: edge > 0,
        };
    }
}

/**
 * Calculate dynamic taker fee for crypto markets
 * Fee = p * (1 - p) where p is the price/probability
 */
export function calculateTakerFee(price: number): number {
    return price * (1 - price);
}

// --- Demo / Testing ---
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('=== Binary Option Fair Value Calculator ===\n');

    const btcPrice = 90000;
    const strike = 89950; // BTC moved up $50 from open

    // Test different time remaining scenarios
    const scenarios = [
        { timeMin: 5.0, label: 'Market just opened (5 min left)' },
        { timeMin: 4.0, label: '1 min elapsed (4 min left)' },
        { timeMin: 3.0, label: '2 min elapsed (3 min left)' },
        { timeMin: 2.0, label: '3 min elapsed (2 min left)' },
        { timeMin: 1.0, label: '4 min elapsed (1 min left)' },
        { timeMin: 0.5, label: '4.5 min elapsed (30s left)' },
    ];

    // Test with different volatility regimes
    const vols = [0.30, 0.50, 0.80, 1.20];

    for (const vol of vols) {
        console.log(`\n--- Annualized Vol: ${(vol * 100).toFixed(0)}% ---`);
        console.log(`BTC Spot: $${btcPrice.toLocaleString()} | Strike: $${strike.toLocaleString()} | Move: +$${btcPrice - strike}`);
        console.log('');

        for (const { timeMin, label } of scenarios) {
            const result = calculateFairValue({
                spotPrice: btcPrice,
                strikePrice: strike,
                timeToExpiryMin: timeMin,
                annualizedVol: vol,
            });

            const takerFee = calculateTakerFee(result.fairPrice);
            console.log(
                `  ${label.padEnd(38)} | Fair: ${(result.fairPrice * 100).toFixed(2)}% | ` +
                `Edge vs 50/50: ${(result.edge * 100).toFixed(2)}% | ` +
                `Taker fee: ${(takerFee * 100).toFixed(2)}%`
            );
        }
    }

    // Show vol calculation example
    console.log('\n=== Realized Vol Calculation ===');
    // Simulate some 5-min BTC prices
    const fakePrices = [89000, 89050, 88980, 89100, 89020, 89150, 89080, 89200, 89120, 89250, 89180, 89300];
    const realizedVol = calculateRealizedVol(fakePrices, 5);
    console.log(`Sample prices (${fakePrices.length} points): ${fakePrices.join(', ')}`);
    console.log(`Realized annualized vol: ${(realizedVol * 100).toFixed(1)}%`);
}
