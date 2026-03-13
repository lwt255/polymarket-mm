/**
 * Propose Change: Uses Claude Code CLI to suggest new parameter values.
 *
 * Builds a prompt with the research playbook, current params, and experiment
 * history, then calls `claude -p` to get a proposed change.
 *
 * Uses the user's Max plan — zero additional cost.
 */

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ArbBotParams } from './types.js';
import { PARAM_RANGES } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

export interface ProposedChange {
    params: ArbBotParams;
    hypothesis: string;
}

function readLastNLines(filePath: string, n: number): string {
    if (!existsSync(filePath)) return '(no history yet)';
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    return lines.slice(-n).join('\n');
}

export function buildPrompt(currentParams: ArbBotParams, historyPath: string): string {
    const playbookPath = resolve(REPO_ROOT, 'trading-program.md');
    const playbook = existsSync(playbookPath)
        ? readFileSync(playbookPath, 'utf8')
        : '(playbook not found)';

    const history = readLastNLines(historyPath, 20);

    return `You are an AI researcher optimizing a paper-trading arbitrage bot for Polymarket BTC 5-minute binary markets.

## Research Playbook
${playbook}

## Current Parameters
\`\`\`typescript
${JSON.stringify(currentParams, null, 2)}
\`\`\`

## Recent Experiment History (last 20)
\`\`\`
${history}
\`\`\`

## Your Task
1. Analyze the experiment history to understand what's been tried and what worked.
2. Propose a SINGLE change (1-2 parameters) with a clear hypothesis.
3. Output EXACTLY this format (no other text):

HYPOTHESIS: <one-line explanation of what you're testing and why>
PARAMS:
\`\`\`typescript
{
  "upBidOffset": 0.03,
  "downBidOffset": 0.03,
  "useSymmetricPricing": true,
  "entryDelaySeconds": 10,
  "exitBeforeEndSeconds": 15,
  "minSpreadCents": 1,
  "maxOverroundCents": 4,
  "minBookDepthUsd": 20,
  "sharesPerSide": 20,
  "maxSingleSideLossCents": 30,
  "cancelOnSingleFill": true,
  "fillThresholdCents": 0,
  "partialFillRatio": 1.0
}
\`\`\`

Important: Change only 1-2 parameters at a time. Keep all fields present. Stay within valid ranges.`;
}

function parseResponse(response: string): ProposedChange | null {
    // Extract hypothesis
    const hypMatch = response.match(/HYPOTHESIS:\s*(.+)/i);
    const hypothesis = hypMatch ? hypMatch[1].trim() : 'No hypothesis provided';

    // Extract JSON params block
    const jsonMatch = response.match(/```(?:typescript|json)?\s*\n(\{[\s\S]*?\})\s*\n```/);
    if (!jsonMatch) return null;

    try {
        const params = JSON.parse(jsonMatch[1]) as ArbBotParams;
        return { params, hypothesis };
    } catch {
        return null;
    }
}

export function validateParams(params: ArbBotParams): string[] {
    const errors: string[] = [];

    for (const [key, range] of Object.entries(PARAM_RANGES)) {
        if (range === null) continue; // boolean, skip
        const value = (params as any)[key];
        if (typeof value !== 'number') {
            errors.push(`${key}: expected number, got ${typeof value}`);
            continue;
        }
        if (value < range.min || value > range.max) {
            errors.push(`${key}: ${value} outside range [${range.min}, ${range.max}]`);
        }
    }

    // Check booleans
    if (typeof params.useSymmetricPricing !== 'boolean') {
        errors.push(`useSymmetricPricing: expected boolean`);
    }
    if (typeof params.cancelOnSingleFill !== 'boolean') {
        errors.push(`cancelOnSingleFill: expected boolean`);
    }

    return errors;
}

export async function proposeChange(currentParams: ArbBotParams, historyPath: string): Promise<ProposedChange> {
    const prompt = buildPrompt(currentParams, historyPath);

    let response: string;
    try {
        // Pipe prompt via stdin for long prompts
        // Must unset CLAUDECODE to avoid nested-session detection
        const env = { ...process.env };
        delete env.CLAUDECODE;

        response = execSync(
            `claude -p --model sonnet --no-session-persistence --tools "" --permission-mode default`,
            {
                input: prompt,
                encoding: 'utf8',
                timeout: 60000,
                maxBuffer: 1024 * 1024,
                env,
            }
        );
    } catch (err: any) {
        throw new Error(`Claude CLI failed: ${err.message}`);
    }

    const parsed = parseResponse(response);
    if (!parsed) {
        throw new Error(`Could not parse Claude response:\n${response.slice(0, 500)}`);
    }

    const errors = validateParams(parsed.params);
    if (errors.length > 0) {
        throw new Error(`Invalid params from Claude:\n${errors.join('\n')}`);
    }

    return parsed;
}

// --- CLI test ---
if (import.meta.url === `file://${process.argv[1]}`) {
    const { PARAMS: currentParams } = await import('./arb-bot-params.js');
    const historyPath = resolve(REPO_ROOT, 'experiment-history.jsonl');

    console.log('Calling Claude CLI for parameter suggestion...');
    try {
        const change = await proposeChange(currentParams, historyPath);
        console.log(`\nHypothesis: ${change.hypothesis}`);
        console.log(`\nProposed params:`);
        console.log(JSON.stringify(change.params, null, 2));
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}
