/**
 * Evaluator: Scores a dry-run result for the autoresearch loop.
 *
 * Weighted composite score balances profitability, fill rate, sample size,
 * and risk. Auto-rejects catastrophic outcomes.
 */

import type { DryRunResult, DryRunSummary } from './types.js';

export interface EvalResult {
    score: number;
    verdict: 'accepted' | 'rejected' | 'inconclusive';
    reason: string;
}

/** Compute a composite score from a dry run summary */
export function computeScore(summary: DryRunSummary): number {
    return (
        2.0 * summary.netPnlCents +
        1.5 * summary.bothFillRate * 100 +
        0.5 * summary.marketsTraded -
        1.0 * summary.maxDrawdownCents -
        0.8 * summary.singleFillLossCents
    );
}

/** Evaluate a dry run result against minimum viability checks */
export function evaluate(result: DryRunResult, previousScore: number): EvalResult {
    const { summary } = result;

    // Auto-reject: insufficient data
    if (summary.marketsTraded < 3) {
        return {
            score: computeScore(summary),
            verdict: 'inconclusive',
            reason: `Only ${summary.marketsTraded} markets traded (need ≥3)`,
        };
    }

    // Auto-reject: catastrophic loss
    if (summary.netPnlCents < -50) {
        return {
            score: computeScore(summary),
            verdict: 'rejected',
            reason: `Catastrophic loss: ${summary.netPnlCents.toFixed(1)}¢ net P&L`,
        };
    }

    // Auto-reject: broken strategy (no fills at all)
    if (summary.bothFillRate < 0.05) {
        return {
            score: computeScore(summary),
            verdict: 'rejected',
            reason: `Both-fill rate too low: ${(summary.bothFillRate * 100).toFixed(1)}%`,
        };
    }

    const score = computeScore(summary);

    // Low sample size → inconclusive rather than reject
    if (summary.marketsTraded < 6) {
        return {
            score,
            verdict: score > previousScore ? 'accepted' : 'inconclusive',
            reason: `Small sample (${summary.marketsTraded} markets). Score: ${score.toFixed(1)} vs prev ${previousScore.toFixed(1)}`,
        };
    }

    // Normal comparison
    if (score > previousScore) {
        return {
            score,
            verdict: 'accepted',
            reason: `Improved: ${score.toFixed(1)} > ${previousScore.toFixed(1)} (+${(score - previousScore).toFixed(1)})`,
        };
    }

    return {
        score,
        verdict: 'rejected',
        reason: `No improvement: ${score.toFixed(1)} ≤ ${previousScore.toFixed(1)}`,
    };
}

// --- CLI: pipe in DryRunResult JSON ---
if (import.meta.url === `file://${process.argv[1]}`) {
    let input = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { input += chunk; });
    process.stdin.on('end', () => {
        try {
            const result: DryRunResult = JSON.parse(input);
            const prevScore = parseFloat(process.argv[2] || '0');
            const evalResult = evaluate(result, prevScore);
            console.log(JSON.stringify(evalResult, null, 2));
        } catch (err) {
            console.error('Failed to parse input:', err);
            process.exit(1);
        }
    });
}
