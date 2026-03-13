/**
 * Autoresearch Loop: Main Orchestrator
 *
 * Per iteration:
 * 1. Call Claude → get proposed params + hypothesis
 * 2. Write to arb-bot-params.ts, git commit
 * 3. Spawn arb-bot.ts, capture stdout (JSON)
 * 4. Evaluate → score
 * 5. If better: KEEP. If worse: git revert. If inconclusive: keep but flag.
 * 6. Append to experiment-history.jsonl
 * 7. Loop
 *
 * Usage: npx tsx src/scripts/autoresearch/loop.ts --iterations 20 --duration 60
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DryRunResult, ExperimentRecord, ArbBotParams } from './types.js';
import { evaluate, computeScore } from './evaluate.js';
import { proposeChange } from './propose-change.js';
import {
    createExperimentBranch,
    commitChange,
    revertLastCommit,
    getCurrentHash,
} from './git-ops.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const PARAMS_FILE = resolve(REPO_ROOT, 'src/scripts/autoresearch/arb-bot-params.ts');
const HISTORY_FILE = resolve(REPO_ROOT, 'experiment-history.jsonl');
const BOT_SCRIPT = resolve(REPO_ROOT, 'src/scripts/autoresearch/arb-bot.ts');

function log(...args: any[]) {
    const ts = new Date().toISOString().slice(11, 19);
    console.log(`[${ts}]`, ...args);
}

function writeParamsFile(params: ArbBotParams): void {
    const content = `/**
 * Tunable Parameters for the BTC 5-min Maker Arbitrage Bot
 *
 * THIS IS THE ONLY FILE THE AI EDITS.
 * Keep it small and isolated for clean git diffs.
 */

import type { ArbBotParams } from './types.js';

export const PARAMS: ArbBotParams = ${JSON.stringify(params, null, 4)};
`;
    writeFileSync(PARAMS_FILE, content);
}

function readCurrentParams(): ArbBotParams {
    const content = readFileSync(PARAMS_FILE, 'utf8');
    // Extract the object literal from the TS file
    const match = content.match(/export const PARAMS: ArbBotParams = ({[\s\S]*});/);
    if (!match) throw new Error('Could not parse current params file');

    // Convert TS object literal to valid JSON:
    // 1. Remove comments  2. Quote unquoted keys  3. Remove trailing commas
    const jsonStr = match[1]
        .replace(/\/\/.*$/gm, '')                    // strip line comments
        .replace(/\/\*[\s\S]*?\*\//g, '')            // strip block comments
        .replace(/(\w+)\s*:/g, '"$1":')              // quote keys
        .replace(/,(\s*[}\]])/g, '$1');              // remove trailing commas
    return JSON.parse(jsonStr);
}

function runBot(durationMinutes: number): Promise<DryRunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn('npx', ['tsx', BOT_SCRIPT, '--duration', String(durationMinutes)], {
            cwd: REPO_ROOT,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (data) => { stdout += data.toString(); });
        child.stderr.on('data', (data) => {
            const line = data.toString();
            stderr += line;
            process.stderr.write(line); // forward bot logs
        });

        // Store child ref for cleanup
        (runBot as any)._child = child;

        child.on('close', (code) => {
            (runBot as any)._child = null;
            if (code !== 0) {
                reject(new Error(`Bot exited with code ${code}\nStderr: ${stderr.slice(-500)}`));
                return;
            }
            try {
                // stdout may have non-JSON lines; find the last JSON line
                const lines = stdout.trim().split('\n');
                const jsonLine = lines.reverse().find(l => l.startsWith('{'));
                if (!jsonLine) throw new Error('No JSON output from bot');
                resolve(JSON.parse(jsonLine));
            } catch (err) {
                reject(new Error(`Failed to parse bot output: ${err}\nStdout: ${stdout.slice(-500)}`));
            }
        });

        child.on('error', (err) => {
            (runBot as any)._child = null;
            reject(err);
        });
    });
}

function appendHistory(record: ExperimentRecord): void {
    appendFileSync(HISTORY_FILE, JSON.stringify(record) + '\n');
}

// --- Main Loop ---

async function main() {
    const args = process.argv.slice(2);
    const iterIdx = args.indexOf('--iterations');
    const durIdx = args.indexOf('--duration');
    const resetIdx = args.indexOf('--reset-history');

    const maxIterations = iterIdx !== -1 ? parseInt(args[iterIdx + 1] || '10') : 10;
    const botDuration = durIdx !== -1 ? parseInt(args[durIdx + 1] || '60') : 60;

    if (resetIdx !== -1 && existsSync(HISTORY_FILE)) {
        writeFileSync(HISTORY_FILE, '');
        log('Reset experiment history');
    }

    log(`=== Autoresearch Loop ===`);
    log(`Iterations: ${maxIterations} | Bot duration: ${botDuration}min`);
    log(`History: ${HISTORY_FILE}`);

    // Setup
    const branch = createExperimentBranch();
    log(`Working on branch: ${branch}`);

    let currentScore = 0;
    let consecutiveFailures = 0;
    let stopped = false;

    // Graceful shutdown
    const cleanup = () => {
        if (stopped) return;
        stopped = true;
        log('Shutting down...');
        const child = (runBot as any)._child;
        if (child) {
            child.kill('SIGTERM');
            log('Killed bot child process');
        }
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);

    for (let i = 1; i <= maxIterations && !stopped; i++) {
        log(`\n${'='.repeat(60)}`);
        log(`ITERATION ${i}/${maxIterations}`);
        log(`${'='.repeat(60)}`);

        // Step 1: Get proposed change from Claude
        let proposed;
        try {
            const currentParams = readCurrentParams();
            proposed = await proposeChange(currentParams, HISTORY_FILE);
            log(`Hypothesis: ${proposed.hypothesis}`);
            consecutiveFailures = 0;
        } catch (err: any) {
            log(`Claude CLI error: ${err.message}`);
            consecutiveFailures++;
            if (consecutiveFailures >= 3) {
                log('3 consecutive Claude failures, pausing 5 minutes...');
                await new Promise(r => setTimeout(r, 5 * 60 * 1000));
                consecutiveFailures = 0;
            }
            continue;
        }

        // Step 2: Write params and commit
        writeParamsFile(proposed.params);
        const hash = commitChange(`experiment ${i}: ${proposed.hypothesis.slice(0, 60)}`);

        // Step 3: Run bot
        let result: DryRunResult;
        try {
            log(`Running bot for ${botDuration} minutes...`);
            result = await runBot(botDuration);
        } catch (err: any) {
            log(`Bot error: ${err.message}`);
            revertLastCommit();
            appendHistory({
                iteration: i,
                timestamp: Date.now(),
                gitHash: hash,
                hypothesis: proposed.hypothesis,
                params: proposed.params,
                score: 0,
                previousScore: currentScore,
                accepted: false,
                verdict: 'rejected',
                summary: {} as any,
                durationMinutes: 0,
                error: err.message,
            });
            continue;
        }

        // Step 4: Evaluate
        const evalResult = evaluate(result, currentScore);
        log(`Score: ${evalResult.score.toFixed(1)} | Verdict: ${evalResult.verdict} | ${evalResult.reason}`);

        // Step 5: Keep or revert
        if (evalResult.verdict === 'rejected') {
            revertLastCommit();
            log('Reverted changes');
        } else {
            if (evalResult.verdict === 'accepted') {
                currentScore = evalResult.score;
                log(`New best score: ${currentScore.toFixed(1)}`);
            } else {
                log('Inconclusive — keeping changes but not updating best score');
            }
        }

        // Step 6: Log
        const record: ExperimentRecord = {
            iteration: i,
            timestamp: Date.now(),
            gitHash: hash,
            hypothesis: proposed.hypothesis,
            params: proposed.params,
            score: evalResult.score,
            previousScore: currentScore,
            accepted: evalResult.verdict !== 'rejected',
            verdict: evalResult.verdict,
            summary: result.summary,
            durationMinutes: result.summary.durationMinutes,
        };
        appendHistory(record);
    }

    log(`\n=== Autoresearch Complete ===`);
    log(`Branch: ${branch}`);
    log(`Final score: ${currentScore.toFixed(1)}`);
    log(`History: ${HISTORY_FILE}`);
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
