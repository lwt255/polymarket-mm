/**
 * Bitwarden Secrets Loader
 *
 * Fetches secrets from Bitwarden Secrets Manager.
 * - On Mac/x64: Uses the official SDK directly
 * - On Pi/ARM: Fetches via SSH from Mac (SDK doesn't support ARM)
 *
 * Falls back to .env if Bitwarden is not configured or fails.
 *
 * Usage:
 *   Set BWS_ACCESS_TOKEN and BWS_ORGANIZATION_ID environment variables
 *   For ARM/Pi: Also set SECRETS_SSH_HOST (e.g., "macbook" or "user@192.168.1.x")
 *   Call initSecrets() at the start of your bot
 */

import { execSync } from 'child_process';
import * as os from 'os';

export interface SecretsLoaderConfig {
  /** Bitwarden API URL (default: https://api.bitwarden.com) */
  apiUrl?: string;
  /** Bitwarden Identity URL (default: https://identity.bitwarden.com) */
  identityUrl?: string;
  /** User agent string for API calls */
  userAgent?: string;
  /** SSH host for ARM devices to fetch secrets from (e.g., "macbook") */
  sshHost?: string;
  /** Remote project directory (default: ~/Documents/Projects/lp-bot) */
  sshProjectDir?: string;
}

/**
 * Detect if running on Raspberry Pi (Linux ARM)
 * Apple Silicon Macs are ARM but have SDK support, so we only check for Linux ARM
 */
function isLinuxARM(): boolean {
  const arch = os.arch();
  const platform = os.platform();
  return platform === 'linux' && (arch === 'arm' || arch === 'arm64');
}

/**
 * Load secrets using the Bitwarden SDK (Mac/x64 only)
 */
async function loadSecretsWithSDK(config: SecretsLoaderConfig): Promise<Record<string, string>> {
  // Dynamic import to avoid loading SDK on ARM where it doesn't work
  const sdk = await import('@bitwarden/sdk-napi');

  const accessToken = process.env.BWS_ACCESS_TOKEN!;
  const organizationId = process.env.BWS_ORGANIZATION_ID!;

  const settings = {
    apiUrl: config.apiUrl || 'https://api.bitwarden.com',
    identityUrl: config.identityUrl || 'https://identity.bitwarden.com',
    userAgent: config.userAgent || 'LP-Bot/1.0',
  };

  const client = new sdk.BitwardenClient(settings);

  // Authenticate with machine account token
  await client.auth().loginAccessToken(accessToken);

  // Sync all secrets from the organization
  const syncResult = await client.secrets().sync(organizationId);

  const secrets: Record<string, string> = {};

  if (syncResult.secrets) {
    for (const secret of syncResult.secrets) {
      secrets[secret.key] = secret.value;
    }
  }

  return secrets;
}

/**
 * Load secrets via SSH from a Mac (for ARM/Pi devices)
 */
async function loadSecretsViaSSH(config: SecretsLoaderConfig): Promise<Record<string, string>> {
  const sshHost = config.sshHost || process.env.SECRETS_SSH_HOST;
  const projectDir = config.sshProjectDir || process.env.SECRETS_SSH_PROJECT_DIR || '~/Documents/Projects/lp-bot';

  if (!sshHost) {
    throw new Error('SECRETS_SSH_HOST not set - required for ARM devices to fetch secrets from Mac');
  }

  console.log(`Fetching secrets via SSH from ${sshHost}...`);

  try {
    const cmd = `ssh -o ConnectTimeout=10 -o BatchMode=yes "${sshHost}" "cd ${projectDir} && ./scripts/serve-secrets.sh"`;
    const output = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });

    const secrets = JSON.parse(output.trim());

    if (secrets.error) {
      throw new Error(secrets.error);
    }

    return secrets;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to fetch secrets via SSH: ${message}`);
  }
}

/**
 * Load secrets from Bitwarden if configured
 */
export async function loadSecrets(config: SecretsLoaderConfig = {}): Promise<Record<string, string>> {
  const accessToken = process.env.BWS_ACCESS_TOKEN;
  const organizationId = process.env.BWS_ORGANIZATION_ID;

  // Check if we should use SSH mode (Linux ARM or explicit config)
  const useSSH = isLinuxARM() || process.env.SECRETS_USE_SSH === 'true';

  if (useSSH) {
    // ARM mode: fetch via SSH from Mac
    const sshHost = config.sshHost || process.env.SECRETS_SSH_HOST;
    if (!sshHost) {
      console.log('Linux ARM detected but SECRETS_SSH_HOST not set, using .env only');
      return {};
    }

    console.log(`Linux ARM device detected - fetching secrets via SSH from ${sshHost}...`);
    try {
      const secrets = await loadSecretsViaSSH(config);
      console.log(`Loaded ${Object.keys(secrets).length} secrets via SSH`);
      return secrets;
    } catch (error) {
      console.warn(`SSH secrets fetch failed, using .env only: ${error}`);
      return {};
    }
  }

  // Standard mode: use SDK directly
  if (!accessToken || !organizationId) {
    console.log('BWS_ACCESS_TOKEN or BWS_ORGANIZATION_ID not set, using .env only');
    return {};
  }

  console.log('Fetching secrets from Bitwarden...');
  try {
    const secrets = await loadSecretsWithSDK(config);
    console.log(`Loaded ${Object.keys(secrets).length} secrets from Bitwarden`);
    return secrets;
  } catch (error) {
    console.warn(`Bitwarden SDK failed, using .env only: ${error}`);
    return {};
  }
}

/**
 * Inject secrets into process.env, but DON'T overwrite existing values
 * This allows .env to provide non-sensitive values while Bitwarden provides private keys
 */
export function injectToProcessEnv(secrets: Record<string, string>): void {
  for (const [key, value] of Object.entries(secrets)) {
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

/**
 * Main entry point - load secrets from Bitwarden and fall back to .env for missing values
 */
export async function initSecrets(): Promise<Record<string, string>> {
  // First, load .env for non-sensitive values
  const dotenv = await import('dotenv');
  dotenv.config();

  // Then load secrets from Bitwarden (only sets values not already present)
  const secrets = await loadSecrets();
  injectToProcessEnv(secrets);

  return secrets;
}

/**
 * Convenience function for one-liner initialization
 */
export async function initBitwardenSecrets(): Promise<Record<string, string>> {
  return initSecrets();
}
