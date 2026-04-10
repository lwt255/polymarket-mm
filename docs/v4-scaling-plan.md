# v4 Scaling Plan & Edge Monitoring Framework

> **Purpose**: A laddered, disciplined plan for scaling the v4 9-signal microstructure strategy from $10/trade paper to its practical liquidity ceiling, with explicit graduation criteria, abort triggers, and an edge-monitoring framework that catches drift before it costs real money.
>
> **Created**: 2026-04-08 (after the v4-sim.py audit confirmed the sim is faithful to backtest baseline)
>
> **Single most important rule**: Each phase is **earned by surviving the prior phase**, never jumped on intuition or hot streaks. The discipline that handles -$40 days is not the same discipline that handles -$2,000 days. Each phase rebuilds the muscle at higher stakes. Skipping levels skips the muscle-building.

---

## Strategy baseline (audited 2026-04-08)

These are the numbers the plan is built on. Verified against 5 weeks of historical collector data using corrected `v4-sim.py`:

| Metric | Value | Notes |
|---|---|---|
| Win rate | 65.8 – 67.6% | 65.8% documented backtest, 67.6% corrected sim on historical |
| Average $/trade (taker fill) | $0.49 | Conservative — sim uses pessimistic ask-side entry |
| Average $/trade (maker fill, expected) | ~$0.78 | Live bot enters at bid+1¢; ~$0.20-0.30/trade improvement |
| Per-trade std dev | ~$7.77 | Driven by 65/35 win/-$10 loss asymmetry |
| Per-day std dev (40 trades) | ~$49 | Used to size the bankroll cushion at each phase |
| Avg trades/day | 40-60 | Varies with market regime; some days 0, some days 120+ |
| Avg expected daily P&L (maker) | +$31/day at $10 size | The number that scales linearly across the ladder |
| Max practical trade size | ~$500/trade | Beyond this, top-of-book impact on thinner crypto books becomes meaningful |

---

## The scaling ladder

Each phase has the **same strategy, same code, same risk profile** — just different zeroes. The bankroll-to-trade-size ratio stays at ~50:1 throughout, which keeps the strategy at roughly **quarter-Kelly** (half the risk of half-Kelly, well below the volatility-maximizing growth rate). Quarter-Kelly is intentionally conservative — it trades growth rate for emotional survivability, which is the actual bottleneck in this strategy.

| Phase | Bankroll | Trade size | Expected daily P&L | 2-SD bad day | Apr 5 equiv |
|---|---|---|---|---|---|
| 1 | $500 | $10 | +$31 | -$67 | -$40 |
| 2 | $2,000 | $40 | +$124 | -$268 | -$160 |
| 3 | $5,000 | $100 | +$310 | -$670 | -$400 |
| 4 | $15,000 | $300 | +$930 | -$2,010 | -$1,200 |
| 5 | $25,000 | $500 | +$1,550 | -$3,350 | -$2,000 |

**Hard ceiling**: Phase 5. Beyond ~$500/trade, the strategy starts eating top-of-book depth on thinner crypto markets (typical depth: 20-40k shares; $500 ≈ 770 shares is well under, $2000 ≈ 3000 shares would be ~10% of top-of-book on thin books). The strategy does not scale beyond this without becoming a different strategy.

## Bankroll extraction policy

This strategy should not be treated like a permanent casino franchise. It is an opportunistic edge on a third-party platform, which means bankroll management should prioritize **survival first, extraction second, compounding third**.

For the current live configuration of `$10/trade`, the operating policy is:

- **Below `$500` bankroll**: extract nothing. All profits stay in the account until Phase 1 bankroll is fully built.
- **`$500` to `$600` bankroll**: still prioritize retention. Small withdrawals are allowed, but the default is to keep building cushion.
- **Above `$600` bankroll**: begin sweeping excess capital out of Polymarket.

Concrete rule:

- **Operating bankroll cap**: `$600`
- **Sweep amount**: withdraw `75%` of bankroll above `$600`
- **Residual kept live**: leave `25%` of the excess in the account unless intentionally building toward the next phase
- **Sweep cadence**: at a calm checkpoint, preferably daily close or weekly review, not intraday highs

Examples:

- If bankroll is `$540`, do nothing.
- If bankroll is `$615`, excess is `$15`; sweep about `$11` and leave about `$4` in the account.
- If bankroll is `$800`, excess is `$200`; sweep `$150` and leave `$50`, resulting in a new bankroll near `$650`.

This policy matches the project's actual objective: extract as much money as practical while the edge exists, but keep enough operating capital live that a normal drawdown does not force a premature stop.

---

## Phase entry criteria (when to graduate)

A phase is **complete and graduation-eligible** only when ALL of these are true:

1. **Trade count threshold met** for the phase (see below)
2. **Realized win rate** is within ±5pp of the 67% backtest baseline over the phase's full sample
3. **Realized $/trade** is within ±30% of the expected per-trade EV for the phase's fill mode (maker)
4. **Drawdown experience** has occurred — the trader has survived at least one -2 SD day or worse in the phase WITHOUT intervening
5. **No new bugs found** in the bot, sim, or supporting infrastructure for at least 50% of the phase's duration
6. **Trader headspace check**: graduation decision is made on a calm, neutral day — not after a winning streak or losing streak

| Phase | Min trades to graduate | Min duration | Trader requirement |
|---|---|---|---|
| 1 → 2 | 500 paper + 200 live | 3 weeks | Survived ≥1 -2 SD day live without bot intervention |
| 2 → 3 | 1,000 live (cumulative) | 4 weeks | Survived ≥1 -3 SD day or 5-day losing streak without size change |
| 3 → 4 | 3,000 live (cumulative) | 6 weeks | Survived a 10-day losing streak; documented decision log for drawdowns |
| 4 → 5 | 6,000 live (cumulative) | 8 weeks | Has had a -$5,000 single-day drawdown experience and did not stop the bot |

**The trader requirement is harder to satisfy than the trade-count requirement.** This is by design. People with the math knowledge to run this strategy fail at scaling not because they can't read numbers but because they intervene during drawdowns. The graduation gate is a discipline gate, not a sample-size gate.

---

## Phase abort/back-off criteria (when to step DOWN)

Step DOWN one phase (or stop entirely) if ANY of these triggers fire:

| Trigger | Action |
|---|---|
| Realized 30-day WR < 55% | **Pause bot.** Re-audit sim, re-audit bot code, re-check collector. Investigate before any restart. |
| Realized 30-day $/trade < $0.20 (maker fill) | **Pause bot.** Edge has compressed — possible competition encroaching. Investigate. |
| Drawdown > 50% of bankroll within any 14-day window | **Step down one phase.** This is beyond expected variance for the phase; either the strategy has shifted or trade size is too large for current edge. |
| Drawdown > 70% of bankroll at any time | **Stop completely.** Strategy is not behaving as expected. Full re-validation required. |
| Single-trade ledger discrepancy (live ≠ collector) > 5% | **Pause bot.** Infrastructure bug — repeat of the phantom-fill class. Investigate before restart. |
| Trader has intervened (manual stop, manual position close) more than 1× per month | **Stay at current phase.** The discipline isn't ready for the next phase, regardless of P&L. |

**Backing off is not failure.** It's the strategy doing its job — telling you that the current size doesn't fit the current edge or current discipline. Stepping down is cheap; blowing up is expensive.

---

## Edge monitoring framework (NEW — the iteration loop)

This is the part that catches edge shift **before** it shows up as a blowup. Three layers, each running at a different cadence.

### Layer 1: Daily — automated, cheap

**What runs**:
- `v4-sim.py` against the previous UTC day's collector data
- Computes: trade count, WR, $/trade, P&L, rejection breakdown
- Appends one row to a rolling log: `monitoring/v4-daily.jsonl`

**What I (the agent) check** when starting a session:
- 7-day rolling WR vs 30-day baseline
- 7-day rolling $/trade vs 30-day baseline
- 7-day trade count vs 30-day baseline
- Flag any metric > 1.5 SD from baseline as **YELLOW**
- Flag any metric > 2.5 SD from baseline as **RED**

**Action thresholds**:
- **Green** (within 1.5 SD): no action, business as usual
- **Yellow** (1.5-2.5 SD off): note in journal, watch closely, no size changes
- **Red** (>2.5 SD off, in either direction, for 3+ days): formal investigation. Suspect bug or genuine edge shift.

> **Important**: red flags fire in BOTH directions. A 3-day +3 SD streak is just as suspicious as a 3-day -3 SD streak. Hot weeks are exactly when bugs sneak in unnoticed because they look like profit. The Apr 7-8 audit is the template — the WR was suspiciously high, that triggered the audit, the audit found two real bugs even though they happened to be diluting rather than inflating edge.

### Layer 2: Weekly — manual review

Every Sunday night (UTC), spend 15 minutes reviewing:

1. **Run `v4-sim.py` on the past 7 days** of collector data. Compare to backtest baseline AND to last week.
2. **Re-run `v4-sim.py` on the full historical file** (1.7GB+). The 5-week historical WR should not drift. If the corrected sim's historical WR moves more than ±3pp from 67.6% baseline, something has changed in the data pipeline (collector schema, resolution lookup, etc.).
3. **Spot-check 5 random trades** from the past week: pick 5 entries from the live ledger, verify the resolution against on-chain CTF, verify the P&L calculation by hand. This catches resolution-lookup bugs.
4. **Check the rejection breakdown** — are the same proportion of records being rejected for the same reasons? A sudden shift in `zone` rejects (e.g., from 85% to 95%) means market conditions have moved away from the strategy's sweet spot.
5. **Update the weekly row** in `journal/weekly-v4-review.md` (one row per week, all the above metrics).

### Layer 3: Monthly — deep audit

Once per month, spend 1-2 hours doing a serious re-validation:

1. **Run a full Codex review** on `v4-sim.py` and the parts of `microstructure-bot.ts` that compute signals and place orders. The user has a documented memory that Claude's audits have missed bugs 5 times — Codex is the second opinion that catches what I miss.
2. **Re-run the full historical backtest** with the corrected sim. The 67.6% number should be stable. If it drifts, the historical data has changed (rare but possible — collector backfills, resolution corrections).
3. **Compare live ledger vs sim predictions** for the past month. For each live trade, ask: "would the sim have taken this trade with this entry, and what does the sim say the outcome should have been?" Live and sim should agree on at least 90% of trades. Disagreements are bugs to investigate.
4. **Re-derive the per-trade std dev** from live data. If the realized variance is meaningfully different from the $7.77 baseline, the bankroll math is wrong and phase sizing needs to be reconsidered.
5. **Read the bot logs end-to-end** for one full day. Look for warnings, retries, partial fills, anything weird. Bots accumulate small misbehaviors that don't trip alarms but slowly erode edge.

### Layer 4: Triggered investigation

These run **only when something fires**, not on a schedule:

| Trigger | Investigation |
|---|---|
| Red flag fires for 3+ days | Full audit: rerun v4-sim-audit.py, check for new bugs, Codex review of any code changes since last audit |
| Phase abort criterion hits | Stop bot, document hypothesis, run focused investigation, no restart until hypothesis is confirmed or rejected |
| Single trade has unexpected P&L (e.g., expected -$10 but actually -$15) | Pull the on-chain trade record, verify against ledger, suspect partial fill or fee bug |
| Collector schema change | Re-run v4-sim against pre-change and post-change data, verify the corrected sim still produces identical results on identical input |

---

## Discipline rules (the unchanging core)

These rules apply at every phase. Violating them means restarting at Phase 1 regardless of where you currently are:

1. **Trade size is fixed within a phase.** Do not increase size mid-phase no matter how good the streak is. Do not decrease size mid-phase no matter how bad the drawdown is. Phase transitions are the only time size changes.
2. **The bot does not stop during a normal drawdown.** "Normal" = anything within 2 SD of expected for the phase. Stopping the bot is reserved for **abort criteria**, not for emotional pain.
3. **Hot streaks are not signals to scale.** They are signals to investigate the sim for bugs. Today's +$199 day triggered the audit that found two real bugs. Future hot streaks should trigger the same reflex.
4. **Cold streaks are not signals to abort.** They are signals to check the abort criteria. If the criteria aren't met, the cold streak is variance, and variance is what bankroll exists to absorb.
5. **No tweaking the strategy mid-phase.** If you have a new idea, write it down, fork the strategy, paper-test it on the historical data. Do not modify the live bot mid-phase.
6. **Weekly review is non-negotiable.** Even if nothing is wrong. Even on vacation. Even on a hot streak. Especially on a hot streak.
7. **Decisions are made on calm days, not on volatile days.** A graduation decision on a +$200 day is a bad decision. A pause decision on a -$200 day is a bad decision. Wait for a flat day to make calls.
8. **Every decision goes in the journal.** Phase changes, audits, investigations, hypothesis tests. Future-you needs to be able to reconstruct why current-you did what you did.

---

## Success metrics (what "the plan worked" actually looks like)

Concrete, falsifiable, and aligned with what the math says is realistic:

| Milestone | Timeframe | What it means |
|---|---|---|
| Complete Phase 1 paper validation (500 trades) | ~10-15 days from 2026-04-08 | Sim and strategy confirmed; ready for live |
| Complete Phase 1 live validation (200 trades) | ~7-10 days after phase 1 paper | Live infrastructure works at $10 size; first emotional drawdown survived |
| Reach Phase 2 ($2,000 bankroll, $40/trade) | ~6-8 weeks from now | Strategy is producing real money at meaningful-but-low size |
| Reach Phase 3 ($5,000 bankroll, $100/trade) | ~6 months from now | Strategy is producing $200-500/week realized — first phase where it's "real income" |
| Reach Phase 4 ($15,000 bankroll, $300/trade) | ~12-18 months from now | Strategy is producing $1,000+/week — meaningful income |
| Reach Phase 5 ($25,000 bankroll, $500/trade) | ~24 months from now | Strategy is at its practical liquidity ceiling — top of the ladder |

**These are ceilings on expectations, not floors on commitment.** If the strategy decays at any phase, the timeline stops there. If the strategy scales faster than expected, the timeline still doesn't compress — the gates are hard. The point is to have a real picture of what success looks like AND how long it takes, so the brain doesn't keep over-projecting after good days or under-projecting after bad days.

---

## What this plan is NOT

- It's not a promise. The strategy could decay at any phase. Edge can disappear. New competition can encroach. The plan is "what to do conditional on the strategy continuing to work."
- It's not a hedge against bad luck. Even a perfect 67% strategy will have bad weeks and occasionally bad months. The plan accepts that and provides for it via bankroll cushion and graduation gates, not by predicting away the variance.
- It's not the only strategy. The copy-trade bot (v2, swisstony, DRY_RUN) is a separate, uncorrelated strategy with its own scaling considerations and its own future plan. v4 and copy-trade can coexist and probably should.
- It's not optimized for fastest growth. It's optimized for **highest probability of still being in the game in 24 months.** The boring path is the path that survives.

---

## How to use this document

- **Re-read it on every phase transition.** Before each graduation, re-read the entry criteria and confirm honestly.
- **Re-read it on every drawdown that hurts.** The discipline rules are the antidote to emotional decisions.
- **Re-read it monthly, even when nothing is wrong.** Drift in execution discipline is hard to notice without a reference point.
- **Update it when the strategy or infrastructure changes.** This document should evolve with the project — but additions should come from observed reality, not from hypothetical concerns.
- **The next agent (or future you) starting a session should read this before touching any v4 trading code.** It will be referenced from CLAUDE.md.
