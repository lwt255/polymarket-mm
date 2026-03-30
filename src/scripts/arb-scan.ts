import { DataFetcher } from '../core/data-fetcher.js';

/**
 * Scan for Arbitrage Opportunities
 * 
 * Check if YES + NO < $1.00 ever occurs in our whale markets.
 * This would be "free money" after fees.
 */

async function main() {
    console.log("🔍 PURE ARBITRAGE DEEP DIVE: Scanning for YES+NO < $1.00 opportunities...\n");

    const markets = [
        { name: "Trump Deportation", yes: "101676997363687199724245607342877036148401850938023978421879460310389391082353", no: "4153292802911610701832309484716814274802943278345248636922528170020319407796" },
        { name: "Fed Jan Meeting", yes: "112838095111461683880944516726938163688341306245473734071798778736646352193304", no: "7321318078891059430231591636389479745928915782241484131001985601124919020061" },
        { name: "Patriots Super Bowl", yes: "23108802207086798801173033667711295391410673134835650507670472347957366091390", no: "49985214708919646661175099546558878672426321417556753698510266808095631910814" },
        { name: "Bears Super Bowl", yes: "98328612241005079298480588888413183448693837922137555607354456149974993923116", no: "90235318156174390107916613062725593492957057218815573793636376869202408014196" },
    ];

    const fetcher = new DataFetcher();

    for (const m of markets) {
        console.log(`📊 Scanning: ${m.name}`);

        try {
            const yesHistory = await fetcher.fetchPriceHistory({ market: m.yes, interval: '1m', fidelity: 10 });
            const noHistory = await fetcher.fetchPriceHistory({ market: m.no, interval: '1m', fidelity: 10 });

            if (yesHistory.length === 0 || noHistory.length === 0) {
                console.log(`   ⚠️ Skip: Missing data`);
                continue;
            }

            // Create a time-aligned map
            const noMap = new Map(noHistory.map(p => [p.t, p.p]));

            let arbOpportunities = 0;
            let totalArbProfit = 0;
            let maxArb = 0;
            let bestArbTime = 0;

            for (const yesPoint of yesHistory) {
                const noPrice = noMap.get(yesPoint.t);
                if (noPrice === undefined) continue;

                const combinedPrice = yesPoint.p + noPrice;

                if (combinedPrice < 0.998) { // Account for ~0.2% fees
                    arbOpportunities++;
                    const profit = 1.00 - combinedPrice - 0.002; // Assume 0.2% total fees
                    totalArbProfit += profit;

                    if ((1.00 - combinedPrice) > maxArb) {
                        maxArb = 1.00 - combinedPrice;
                        bestArbTime = yesPoint.t;
                    }
                }
            }

            if (arbOpportunities > 0) {
                console.log(`   🎯 ARB FOUND!`);
                console.log(`      Opportunities: ${arbOpportunities} (out of ${yesHistory.length} candles)`);
                console.log(`      Max Arb: ${(maxArb * 100).toFixed(2)}% at ${new Date(bestArbTime * 1000).toLocaleString()}`);
                console.log(`      Total Theoretical Profit: $${(totalArbProfit * 100).toFixed(2)} per $100 deployed`);
            } else {
                console.log(`   ❌ No arb opportunities found (YES+NO always >= $0.998)`);
            }
        } catch (e) {
            console.log(`   ❌ Error: ${e.message}`);
        }
        console.log();
    }

    console.log("=".repeat(60));
    console.log("CONCLUSION: Checking if Polymarket pricing is efficient...");
}

main().catch(console.error);
