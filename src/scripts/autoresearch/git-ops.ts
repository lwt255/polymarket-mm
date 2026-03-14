/**
 * Git Operations for the Autoresearch Loop
 *
 * All operations are scoped to arb-bot-params.ts only.
 * Runs on a dedicated experiment branch.
 */

import { execSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const PARAMS_FILE = 'src/scripts/autoresearch/arb-bot-params.ts';
const AUTORESEARCH_DIR = 'src/scripts/autoresearch';

function git(cmd: string): string {
    return execSync(`git ${cmd}`, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

/** Ensure all autoresearch files are committed to the current branch before branching */
export function ensureFilesCommitted(): void {
    const status = git(`status --porcelain -- ${AUTORESEARCH_DIR} trading-program.md`);
    if (status) {
        git(`add ${AUTORESEARCH_DIR}`);
        try { git(`add trading-program.md`); } catch { /* may not exist */ }
        try {
            execSync(`git commit -m "autoresearch: add baseline files"`, {
                cwd: REPO_ROOT,
                encoding: 'utf8',
            });
            console.log('[git] Committed autoresearch baseline files to current branch');
        } catch {
            // Nothing new to commit
        }
    }
}

/** Create experiment branch (files must already be committed) */
export function createExperimentBranch(): string {
    ensureFilesCommitted();
    const branchName = `autoresearch-${Date.now()}`;
    git(`checkout -b ${branchName}`);
    console.log(`[git] Created branch: ${branchName}`);
    return branchName;
}

/** Stage and commit the params file */
export function commitChange(message: string): string {
    git(`add ${PARAMS_FILE}`);
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
        cwd: REPO_ROOT,
        encoding: 'utf8',
    });
    const hash = getCurrentHash();
    console.log(`[git] Committed: ${hash.slice(0, 8)} — ${message}`);
    return hash;
}

/** Revert the last commit (failed experiment) */
export function revertLastCommit(): void {
    try {
        git('revert HEAD --no-edit');
        console.log('[git] Reverted last commit');
    } catch (err: any) {
        console.error(`[git] Revert failed: ${err.message}`);
        // Fallback: reset the params file to previous commit's version
        try {
            git(`checkout HEAD~1 -- ${PARAMS_FILE}`);
            git(`commit -m "revert: reset params after failed revert"`);
            console.log('[git] Recovered params via checkout');
        } catch {
            console.error('[git] Recovery also failed — manual intervention needed');
        }
    }
}

/** Get current commit hash */
export function getCurrentHash(): string {
    return git('rev-parse HEAD');
}

/** Get current branch name */
export function getCurrentBranch(): string {
    return git('rev-parse --abbrev-ref HEAD');
}
