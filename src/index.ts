/**
 * Polymarket-MM Entry Point
 * 
 * Prediction market bots for Polymarket.
 * Currently in experimental/testing phase.
 */

import 'dotenv/config';
import { initBitwardenSecrets } from './core/bitwarden-loader.js';
import { privateKeyToAccount } from 'viem/accounts';

async function main() {
    console.log('🎰 Polymarket-MM');
    console.log('================');

    // Load secrets from Bitwarden
    await initBitwardenSecrets();

    // Use the specific EVM wallet reserved for testing/general use from Bitwarden
    const privateKey = process.env.EVM_WALLET_PRIVATE_KEY2;
    const address = process.env.POLYMARKET_ADDRESS;

    if (privateKey) {
        const formattedKey = privateKey.trim();
        const finalKey = (formattedKey.startsWith('0x') ? formattedKey : `0x${formattedKey}`) as `0x${string}`;
        try {
            const account = privateKeyToAccount(finalKey);
            console.log(`✅ Wallet loaded: ${account.address.slice(0, 6)}...${account.address.slice(-4)}`);
            if (address && address.toLowerCase() !== account.address.toLowerCase()) {
                console.warn(`⚠️ Warning: POLYMARKET_ADDRESS (${address.slice(0, 6)}...) does not match Private Key address!`);
            }
        } catch (e) {
            console.error('❌ Failed to load wallet from private key:', (e as Error).message);
        }
    } else {
        console.log('❌ No private key found (check .env or Bitwarden)');
    }

    console.log('Status: Experimental (No live trading)');
    console.log('');
    console.log('Available strategies (planned):');
    console.log('  - Market Making');
    console.log('  - Arbitrage (YES + NO < $1.00)');
    console.log('  - Rebate Farming');
    console.log('');
    console.log('Run `npm run dev` for development mode.');
}

main().catch(console.error);
