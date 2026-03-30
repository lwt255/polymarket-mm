import 'dotenv/config';
import { Wallet } from '@ethersproject/wallet';

const CLOB = 'https://clob.polymarket.com';

async function main() {
    const wallet = new Wallet(process.env.POLYMARKET_PRIVATE_KEY!);
    console.log(`Wallet: ${wallet.address}\n`);

    // Step 1: Try the auth/derive endpoint manually
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = 0;

    // Sign the message for derive
    const deriveMsg = `${timestamp}`;
    // The CLOB uses a specific signing scheme, let's just use the SDK but inspect the raw response

    // Try raw API call to create key
    console.log('1. Trying POST /auth/api-key (create)...');
    const sig = await wallet.signMessage(`I am signing this message to create an API key on Polymarket. Nonce: ${nonce}. Timestamp: ${timestamp}`);

    const createResp = await fetch(`${CLOB}/auth/api-key`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'POLY_ADDRESS': wallet.address,
            'POLY_SIGNATURE': sig,
            'POLY_TIMESTAMP': timestamp,
            'POLY_NONCE': nonce.toString(),
        },
    });
    const createData = await createResp.json();
    console.log(`   Status: ${createResp.status}`);
    console.log(`   Response:`, JSON.stringify(createData, null, 2));

    // Step 2: Try derive endpoint
    console.log('\n2. Trying GET /auth/derive-api-key...');
    const deriveSig = await wallet.signMessage(`I am signing this message to derive my API key on Polymarket. Nonce: ${nonce}. Timestamp: ${timestamp}`);

    const deriveResp = await fetch(`${CLOB}/auth/derive-api-key`, {
        method: 'GET',
        headers: {
            'POLY_ADDRESS': wallet.address,
            'POLY_SIGNATURE': deriveSig,
            'POLY_TIMESTAMP': timestamp,
            'POLY_NONCE': nonce.toString(),
        },
    });
    const deriveData = await deriveResp.json();
    console.log(`   Status: ${deriveResp.status}`);
    console.log(`   Response:`, JSON.stringify(deriveData, null, 2));

    // Step 3: If we got creds, try to use them
    const apiKey = createData.apiKey || deriveData.apiKey;
    const secret = createData.secret || deriveData.secret;
    const passphrase = createData.passphrase || deriveData.passphrase;

    if (apiKey) {
        console.log(`\n3. Got API key: ${apiKey.slice(0, 12)}...`);
        console.log('   Testing balance endpoint...');

        // HMAC sign for authenticated request
        const crypto = await import('crypto');
        const ts = Math.floor(Date.now() / 1000).toString();
        const method = 'GET';
        const path = '/balance-allowance?asset_type=USDC&signature_type=0';
        const body = '';
        const message = ts + method + path + body;
        const hmac = crypto.createHmac('sha256', Buffer.from(secret, 'base64'))
            .update(message).digest('base64');

        const balResp = await fetch(`${CLOB}${path}`, {
            headers: {
                'POLY_ADDRESS': wallet.address,
                'POLY_SIGNATURE': hmac,
                'POLY_TIMESTAMP': ts,
                'POLY_API_KEY': apiKey,
                'POLY_PASSPHRASE': passphrase,
            },
        });
        console.log(`   Status: ${balResp.status}`);
        const balData = await balResp.json();
        console.log(`   Response:`, JSON.stringify(balData));
    } else {
        console.log('\n3. No API key obtained. Checking all response fields...');
        console.log('   Create response keys:', Object.keys(createData));
        console.log('   Derive response keys:', Object.keys(deriveData));
    }

    // Step 4: Check the SDK version
    console.log('\n4. SDK info:');
    const pkg = await import('@polymarket/clob-client/package.json', { with: { type: 'json' }}).catch(() => null);
    if (pkg) console.log(`   Version: ${(pkg as any).default?.version}`);
}

main().catch(console.error);
