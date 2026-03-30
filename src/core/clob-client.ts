import { ClobClient, Chain } from '@polymarket/clob-client';
import { privateKeyToAccount } from 'viem/accounts';
import { initBitwardenSecrets } from './bitwarden-loader.js';
import 'dotenv/config';

let client: ClobClient | null = null;

/**
 * Initialize and get an authenticated ClobClient.
 * Loads private key from Bitwarden if not already loaded.
 */
export async function getAuthenticatedClient(): Promise<ClobClient> {
    if (client) return client;

    // Ensure secrets are loaded
    await initBitwardenSecrets();

    const privateKey = process.env.EVM_WALLET_PRIVATE_KEY2;
    if (!privateKey) {
        throw new Error('EVM_WALLET_PRIVATE_KEY2 not found in environment');
    }

    const formattedKey = privateKey.trim();
    const finalKey = (formattedKey.startsWith('0x') ? formattedKey : `0x${formattedKey}`) as `0x${string}`;

    // Create viem account
    const account = privateKeyToAccount(finalKey);

    // Wrap viem account to look like an ethers signer for the SDK
    const ethersSigner = {
        getAddress: async () => account.address,
        signMessage: async (message: string | Uint8Array) => {
            return account.signMessage({
                message: typeof message === 'string' ? message : { raw: message }
            });
        },
        _signTypedData: async (domain: any, types: any, value: any) => {
            // Polymarket SDK uses _signTypedData for EIP-712
            // We need to map it to viem's signTypedData
            return account.signTypedData({
                domain,
                types,
                primaryType: Object.keys(types)[0],
                message: value
            } as any);
        }
    };

    // Initialize ClobClient with signer first to derive API keys if needed
    const publicClient = new ClobClient(
        'https://clob.polymarket.com',
        Chain.POLYGON,
        ethersSigner as any
    );

    // Create or Derive API Key from private key (L1 signing required)
    console.log('🔐 Authenticating with Polymarket CLOB (L1 signing)...');
    try {
        // createOrDeriveApiKey handles both new and existing keys
        const creds = await publicClient.createOrDeriveApiKey();

        if (!creds || !creds.key || !creds.secret || !creds.passphrase) {
            throw new Error('Incomplete API credentials returned from Polymarket');
        }

        // Final authenticated client with both signer and L2 credentials
        client = new ClobClient(
            'https://clob.polymarket.com',
            Chain.POLYGON,
            ethersSigner as any,
            creds
        );
        console.log('✅ Authentication successful.');
    } catch (error) {
        console.error('❌ Authentication failed:', (error as Error).message);
        console.warn('💡 Tip: Ensure the wallet has a small amount of POL/USDC on Polygon if this is a first-time registration.');
        throw error;
    }

    return client;
}

/**
 * Get a public (unauthenticated) ClobClient.
 */
export function getPublicClient(): ClobClient {
    return new ClobClient('https://clob.polymarket.com', Chain.POLYGON);
}
