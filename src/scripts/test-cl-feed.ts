import { ChainlinkFeed } from './crypto-5min/chainlink-feed.js';

async function main() {
    const feed = new ChainlinkFeed();
    await feed.connect();

    console.log('Waiting 3s...');
    await new Promise(r => setTimeout(r, 3000));
    const btc1 = feed.getPrice('btc/usd');
    const eth1 = feed.getPrice('eth/usd');
    console.log(`BTC: $${btc1.toFixed(2)} | ETH: $${eth1.toFixed(2)}`);

    console.log('Waiting 12s for re-subscribe...');
    await new Promise(r => setTimeout(r, 12000));
    const btc2 = feed.getPrice('btc/usd');
    const eth2 = feed.getPrice('eth/usd');
    console.log(`BTC: $${btc2.toFixed(2)} (change: $${(btc2-btc1).toFixed(2)}) | ETH: $${eth2.toFixed(2)} (change: $${(eth2-eth1).toFixed(2)})`);

    console.log('Waiting 12s more...');
    await new Promise(r => setTimeout(r, 12000));
    const btc3 = feed.getPrice('btc/usd');
    const eth3 = feed.getPrice('eth/usd');
    console.log(`BTC: $${btc3.toFixed(2)} (change: $${(btc3-btc1).toFixed(2)}) | ETH: $${eth3.toFixed(2)} (change: $${(eth3-eth1).toFixed(2)})`);

    feed.disconnect();
    process.exit(0);
}

main();
