async function main() {
    const now = Math.floor(Date.now() / 1000);
    const rounded5 = Math.floor(now / 300) * 300;

    for (const crypto of ['eth', 'btc', 'sol', 'xrp']) {
        for (const ts of [rounded5, rounded5 + 300]) {
            const slug = `${crypto}-updown-5m-${ts}`;
            const resp = await fetch(`https://gamma-api.polymarket.com/markets?slug=${slug}`);
            const data = await resp.json() as any[];
            if (!data?.[0]) continue;

            const m = data[0];
            const endDate = new Date(m.endDate).getTime();
            if (endDate < Date.now()) continue;

            const tokens = JSON.parse(m.clobTokenIds || '[]');
            const outcomes: string[] = JSON.parse(m.outcomes || '[]');

            console.log(`\n=== ${slug} (${Math.round((endDate - Date.now()) / 1000)}s left) ===`);

            for (let i = 0; i < tokens.length; i++) {
                const bookResp = await fetch(`https://clob.polymarket.com/book?token_id=${tokens[i]}`);
                const book = await bookResp.json() as any;

                const bids = (book.bids || []).map((b: any) => ({ price: parseFloat(b.price), size: parseFloat(b.size) })).sort((a: any, b: any) => b.price - a.price);
                const asks = (book.asks || []).map((a: any) => ({ price: parseFloat(a.price), size: parseFloat(a.size) })).sort((a: any, b: any) => a.price - b.price);

                const bestBid = bids[0]?.price || 0;
                const bestAsk = asks[0]?.price || 1;
                const bestAskSize = asks[0]?.size || 0;
                const bestBidSize = bids[0]?.size || 0;

                // Only detail if in our 50-65c range
                const inRange = bestAsk >= 0.50 && bestAsk < 0.65;
                const shares10 = Math.floor(10 / bestAsk);

                console.log(`  ${outcomes[i]}: bid=${(bestBid * 100).toFixed(0)}¢(${bestBidSize.toFixed(0)}sh) ask=${(bestAsk * 100).toFixed(0)}¢(${bestAskSize.toFixed(0)}sh)${inRange ? ` ← IN RANGE | $10=${shares10}sh needed, ${bestAskSize.toFixed(0)} avail ${bestAskSize >= shares10 ? '✓' : '✗ THIN'}` : ''}`);

                if (inRange) {
                    // Show full ask depth
                    let cumSize = 0;
                    let cumCost = 0;
                    console.log(`    Ask depth:`);
                    for (const a of asks.slice(0, 5)) {
                        cumSize += a.size;
                        cumCost += a.size * a.price;
                        console.log(`      ${(a.price * 100).toFixed(0)}¢ × ${a.size.toFixed(0)}sh ($${(a.size * a.price).toFixed(0)}) | cum: ${cumSize.toFixed(0)}sh ($${cumCost.toFixed(0)})`);
                    }
                }
            }
            break; // only need current market per crypto
        }
    }
}
main();
