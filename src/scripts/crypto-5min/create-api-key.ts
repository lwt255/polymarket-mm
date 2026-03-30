import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
    console.log(`Wallet: ${wallet.address}`);

    const client = new ClobClient('https://clob.polymarket.com', 137, wallet);

    console.log('Creating/deriving API key...');
    const creds = await client.createOrDeriveApiKey();
    console.log('Creds received:');
    console.log('  All keys:', Object.keys(creds));
    console.log(`  key: ${(creds as any).key?.slice(0, 16)}...`);
    console.log(`  secret: ${creds.secret?.slice(0, 16)}...`);
    console.log(`  passphrase: ${creds.passphrase?.slice(0, 16)}...`);

    const apiKey = (creds as any).key;
    if (!apiKey) {
        console.error('\nNo API key returned! The wallet may not be registered with Polymarket.');
        console.error('Make sure you have traded at least once through the Polymarket website.');
        return;
    }

    // Re-init with proper creds
    console.log('\nRe-initializing with credentials...');
    const authedClient = new ClobClient('https://clob.polymarket.com', 137, wallet, {
        key: apiKey,
        secret: creds.secret,
        passphrase: creds.passphrase,
    });

    console.log('Checking balance...');
    try {
        const bal = await authedClient.getBalanceAllowance({
            asset_type: 'USDC',
        } as any);
        console.log('Balance:', JSON.stringify(bal));
    } catch (e: any) {
        console.log('Balance error:', e.message?.slice(0, 100));
    }

    console.log('\nChecking open orders...');
    try {
        const orders = await authedClient.getOpenOrders();
        console.log(`Open orders: ${orders?.length || 0}`);
    } catch (e: any) {
        console.log('Orders error:', e.message?.slice(0, 100));
    }

    console.log('\nChecking trade history...');
    try {
        const trades = await authedClient.getTrades();
        console.log(`Trades: ${trades?.length || 0}`);
    } catch (e: any) {
        console.log('Trades error:', e.message?.slice(0, 100));
    }
}

main().catch(e => console.error('Fatal:', e.message));
