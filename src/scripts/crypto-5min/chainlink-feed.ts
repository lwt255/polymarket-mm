/**
 * Connect to Polymarket's RTDS WebSocket for real-time Chainlink BTC/USD prices.
 * This is the EXACT price feed used to resolve 5-minute markets.
 *
 * No authentication required.
 */

// Node 22+ has native WebSocket; fallback to ws package if needed
const WS = globalThis.WebSocket ?? (await import('ws')).default;

const WS_URL = 'wss://ws-live-data.polymarket.com';

interface ChainlinkPriceUpdate {
    topic: string;
    type: string;
    payload: {
        symbol: string;
        timestamp: number;
        price: number;
    };
}

export const SUPPORTED_SYMBOLS = ['btc/usd', 'eth/usd', 'sol/usd', 'xrp/usd'] as const;
export type ChainlinkSymbol = typeof SUPPORTED_SYMBOLS[number];

export class ChainlinkFeed {
    private ws: WebSocket | null = null;
    private prices: Record<string, number> = {};
    private timestamps: Record<string, number> = {};
    private onPrice: ((symbol: string, price: number, timestamp: number) => void) | null = null;
    private pingInterval: NodeJS.Timeout | null = null;
    private reconnectTimeout: NodeJS.Timeout | null = null;
    private symbols: string[];

    constructor(symbols?: string[]) {
        this.symbols = symbols ?? [...SUPPORTED_SYMBOLS];
    }

    async connect(onPrice?: (symbol: string, price: number, timestamp: number) => void): Promise<void> {
        if (onPrice) this.onPrice = onPrice;

        return new Promise((resolve, reject) => {
            this.ws = new WS(WS_URL) as any;

            this.ws!.onopen = () => {
                console.log(`[Chainlink] Connected to Polymarket RTDS (${this.symbols.join(', ')})`);

                // Subscribe to each symbol separately (more reliable than batch)
                for (const symbol of this.symbols) {
                    this.ws!.send(JSON.stringify({
                        action: 'subscribe',
                        subscriptions: [{
                            topic: 'crypto_prices_chainlink',
                            type: '*',
                            filters: JSON.stringify({ symbol }),
                        }]
                    }));
                }

                // Start ping keepalive + periodic re-subscribe for fresh data
                // (WS sends batch on subscribe, live updates are unreliable)
                this.pingInterval = setInterval(() => {
                    if (this.ws?.readyState === 1) { // OPEN
                        this.ws.send('PING');
                        // Re-subscribe every 10s to get fresh batch data
                        for (const symbol of this.symbols) {
                            this.ws.send(JSON.stringify({
                                action: 'subscribe',
                                subscriptions: [{
                                    topic: 'crypto_prices_chainlink',
                                    type: '*',
                                    filters: JSON.stringify({ symbol }),
                                }]
                            }));
                        }
                    }
                }, 10000);

                resolve();
            };

            this.ws!.onmessage = (event: any) => {
                const data = typeof event.data === 'string' ? event.data : event.data.toString();

                if (data === 'PONG' || data.length < 5) return;

                try {
                    const msg = JSON.parse(data);

                    // Format 1: Batch data with symbol (check FIRST — these also have topic)
                    // {"payload":{"data":[{"timestamp":...,"value":...}],"symbol":"eth/usd"}}
                    if (msg.payload?.data && Array.isArray(msg.payload.data) && msg.payload.symbol) {
                        const symbol = msg.payload.symbol.toLowerCase();
                        const points = msg.payload.data;
                        if (points.length > 0) {
                            const latest = points[points.length - 1];
                            const price = parseFloat(latest.value || '0');
                            const timestamp = latest.timestamp || Date.now();
                            if (price > 0) {
                                this.prices[symbol] = price;
                                this.timestamps[symbol] = timestamp;
                                if (this.onPrice) this.onPrice(symbol, price, timestamp);
                            }
                        }
                        return;
                    }

                    // Format 2: Wrapped update with topic (single price update)
                    // {"topic":"crypto_prices_chainlink","payload":{"symbol":"btc/usd","value":70000,"timestamp":...}}
                    if (msg.payload?.symbol && (msg.payload?.value || msg.payload?.price)) {
                        const symbol = msg.payload.symbol.toLowerCase();
                        const price = parseFloat(msg.payload.value || msg.payload.price);
                        const timestamp = msg.payload.timestamp || Date.now();
                        if (price > 0) {
                            this.prices[symbol] = price;
                            this.timestamps[symbol] = timestamp;
                            if (this.onPrice) this.onPrice(symbol, price, timestamp);
                        }
                        return;
                    }

                    // Format 3: Bare update (no topic wrapper)
                    // {"symbol":"btc/usd","value":70000,"timestamp":...}
                    if (msg.symbol && (msg.value || msg.price)) {
                        const symbol = msg.symbol.toLowerCase();
                        const price = parseFloat(msg.value || msg.price);
                        const timestamp = msg.timestamp || Date.now();
                        if (price > 0) {
                            this.prices[symbol] = price;
                            this.timestamps[symbol] = timestamp;
                            if (this.onPrice) this.onPrice(symbol, price, timestamp);
                        }
                    }
                } catch {
                    // Not JSON — ignore silently
                }
            };

            this.ws!.onerror = (err: any) => {
                console.error('[Chainlink] Error:', err.message || err);
                reject(err);
            };

            this.ws!.onclose = () => {
                console.log('[Chainlink] Disconnected');
                if (this.pingInterval) clearInterval(this.pingInterval);
                // Auto-reconnect after 2s
                this.reconnectTimeout = setTimeout(() => this.connect(), 2000);
            };
        });
    }

    /** Get price for a symbol (e.g. 'btc/usd'). Falls back to legacy single-asset. */
    getPrice(symbol?: string): number {
        if (!symbol) {
            // Legacy: return BTC price for backwards compatibility
            return this.prices['btc/usd'] ?? Object.values(this.prices)[0] ?? 0;
        }
        return this.prices[symbol.toLowerCase()] ?? 0;
    }

    getTimestamp(symbol?: string): number {
        if (!symbol) {
            return this.timestamps['btc/usd'] ?? Object.values(this.timestamps)[0] ?? 0;
        }
        return this.timestamps[symbol.toLowerCase()] ?? 0;
    }

    getAllPrices(): Record<string, number> {
        return { ...this.prices };
    }

    disconnect() {
        if (this.pingInterval) clearInterval(this.pingInterval);
        if (this.reconnectTimeout) clearTimeout(this.reconnectTimeout);
        if (this.ws) this.ws.close();
    }
}

// --- CLI test ---
if (import.meta.url === `file://${process.argv[1]}`) {
    console.log('=== Chainlink BTC/USD Real-Time Feed ===');
    console.log('Connecting to Polymarket RTDS WebSocket...\n');

    const feed = new ChainlinkFeed();
    let updateCount = 0;
    const firstPrices: Record<string, number> = {};

    feed.connect((symbol, price, timestamp) => {
        updateCount++;
        if (!firstPrices[symbol]) firstPrices[symbol] = price;
        const move = price - firstPrices[symbol];
        const moveStr = (move >= 0 ? '+' : '') + move.toFixed(2);
        const time = new Date(typeof timestamp === 'number' && timestamp > 1e12 ? timestamp : timestamp * 1000).toLocaleTimeString();

        console.log(
            `[${updateCount.toString().padStart(4)}] ${time} | ${symbol} ` +
            `$${price.toFixed(2)} | ` +
            `Move: ${moveStr}`
        );
    });

    // Run for 60 seconds then summarize
    setTimeout(() => {
        console.log(`\n=== Summary ===`);
        console.log(`Total updates: ${updateCount}`);
        console.log(`Last price: $${feed.getPrice().toFixed(2)}`);
        console.log(`Duration: 60 seconds`);
        console.log(`Avg updates/sec: ${(updateCount / 60).toFixed(1)}`);
        feed.disconnect();
        process.exit(0);
    }, 60000);
}
