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

export interface ClaudeUsage {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    totalCostUsd: number;
    durationMs: number;
}

function readLastNLines(filePath: string, n: number): string {
    if (!existsSync(filePath)) return '(no history yet)';
    const lines = readFileSync(filePath, 'utf8').trim().split('\n');
    return lines.slice(-n).join('\n');
}

/** Format experiment history as a readable table for Claude */
function formatHistoryTable(historyPath: string, maxEntries: number): string {
    if (!existsSync(historyPath)) return '(no history yet)';
    const lines = readFileSync(historyPath, 'utf8').trim().split('\n').filter(Boolean);
    if (lines.length === 0) return '(no history yet)';

    const entries = lines.slice(-maxEntries).map(l => JSON.parse(l));
    const header = '| # | offset | cancel | shares | entry | exit | spread | overround | depth | fillThresh | traded | both | single | pnl¢ | score | verdict |';
    const sep =    '|---|--------|--------|--------|-------|------|--------|-----------|-------|------------|--------|------|--------|------|-------|---------|';
    const rows = entries.map(d => {
        const p = d.params;
        const s = d.summary || {};
        return `| ${d.iteration} | ${p.upBidOffset} | ${p.cancelOnSingleFill} | ${p.sharesPerSide} | ${p.entryDelaySeconds}s | ${p.exitBeforeEndSeconds}s | ${p.minSpreadCents} | ${p.maxOverroundCents} | ${p.minBookDepthUsd} | ${p.fillThresholdCents} | ${s.marketsTraded ?? '?'} | ${s.bothFills ?? '?'}(${((s.bothFillRate || 0) * 100).toFixed(0)}%) | ${s.singleFills ?? '?'} | ${(s.netPnlCents ?? 0).toFixed(0)} | ${d.score.toFixed(0)} | ${d.verdict} |`;
    });

    return [header, sep, ...rows].join('\n');
}

export function buildPrompt(currentParams: ArbBotParams, historyPath: string): string {
    const playbookPath = resolve(REPO_ROOT, 'trading-program.md');
    const playbook = existsSync(playbookPath)
        ? readFileSync(playbookPath, 'utf8')
        : '(playbook not found)';

    const historyTable = formatHistoryTable(historyPath, 30);

    return `You are an AI researcher optimizing a paper-trading arbitrage bot for Polymarket BTC 5-minute binary markets.

## Research Playbook
${playbook}

## Current Parameters
\`\`\`json
${JSON.stringify(currentParams, null, 2)}
\`\`\`

## Experiment History
${historyTable}

## Your Task
1. Analyze the experiment history to understand what's been tried and what worked.
2. Propose a SINGLE change (1-2 parameters) with a clear hypothesis.
3. Output EXACTLY this format (no other text):

HYPOTHESIS: <one-line explanation of what you're testing and why>
PARAMS:
\`\`\`json
${JSON.stringify(currentParams, null, 2)}
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

export async function proposeChange(
    currentParams: ArbBotParams,
    historyPath: string,
): Promise<{ change: ProposedChange; usage: ClaudeUsage }> {
    const prompt = buildPrompt(currentParams, historyPath);

    // Must unset CLAUDECODE to avoid nested-session detection
    const env = { ...process.env };
    delete env.CLAUDECODE;

    let rawOutput: string;
    try {
        // Use --output-format json to get usage stats alongside the response
        rawOutput = execSync(
            `claude -p --output-format json --model sonnet --no-session-persistence --tools "" --permission-mode default`,
            {
                input: prompt,
                encoding: 'utf8',
                timeout: 90000,
                maxBuffer: 1024 * 1024,
                env,
            }
        );
    } catch (err: any) {
        throw new Error(`Claude CLI failed: ${err.message}`);
    }

    // Parse the JSON envelope
    let envelope: any;
    try {
        envelope = JSON.parse(rawOutput);
    } catch {
        throw new Error(`Could not parse Claude CLI JSON output:\n${rawOutput.slice(0, 500)}`);
    }

    if (envelope.is_error) {
        throw new Error(`Claude CLI returned error: ${envelope.result}`);
    }

    // Extract usage
    const u = envelope.usage || {};
    const usage: ClaudeUsage = {
        inputTokens: u.input_tokens || 0,
        outputTokens: u.output_tokens || 0,
        cacheReadTokens: u.cache_read_input_tokens || 0,
        cacheCreationTokens: u.cache_creation_input_tokens || 0,
        totalCostUsd: envelope.total_cost_usd || 0,
        durationMs: envelope.duration_ms || 0,
    };

    // Parse the actual response text
    const responseText = envelope.result || '';
    const parsed = parseResponse(responseText);
    if (!parsed) {
        throw new Error(`Could not parse Claude response:\n${responseText.slice(0, 500)}`);
    }

    const errors = validateParams(parsed.params);
    if (errors.length > 0) {
        throw new Error(`Invalid params from Claude:\n${errors.join('\n')}`);
    }

    return { change: parsed, usage };
}

// --- CLI test ---
if (import.meta.url === `file://${process.argv[1]}`) {
    const { PARAMS: currentParams } = await import('./arb-bot-params.js');
    const historyPath = resolve(REPO_ROOT, 'experiment-history.jsonl');

    console.log('Calling Claude CLI for parameter suggestion...');
    try {
        const { change, usage } = await proposeChange(currentParams, historyPath);
        console.log(`\nHypothesis: ${change.hypothesis}`);
        console.log(`\nProposed params:`);
        console.log(JSON.stringify(change.params, null, 2));
        console.log(`\nUsage: ${usage.inputTokens} in + ${usage.outputTokens} out | Cache: ${usage.cacheReadTokens} read | Cost: $${usage.totalCostUsd.toFixed(4)} | Time: ${usage.durationMs}ms`);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}
