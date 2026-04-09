# v4 Live Launch Checklist

Purpose: make the eventual v4 cutover boring. This checklist is for launch-day validation, not strategy research.

## Before Funding / Before Launch Decision

- Confirm paper validation is still on track with the corrected sim and no new audit issues.
- Re-read [v4-scaling-plan.md](/Users/levanielthompson/Documents/Projects/polymarket-mm/docs/v4-scaling-plan.md) and verify the phase-entry criteria still make sense in current conditions.
- Fund the Polymarket EOA to a bankroll level that matches the intended live size.
- Decide the first live config in advance.
  Suggested first config: `--live --size 10 --max-loss 40`
- Make the launch decision on a calm day, not on a hot streak or drawdown day.

## Launch-Day Preflight

Run the no-trade preflight first:

```bash
npx tsx src/scripts/crypto-5min/preflight-live.ts --max-loss 40
```

Preflight must confirm all of the following:

- Private key loads and wallet address derives correctly
- CLOB authentication succeeds
- Open orders can be queried
- On-chain USDC balance is readable
- Max-loss floor initializes correctly
- Current 5m and 15m crypto markets are discoverable
- Live book reads succeed for those markets

If preflight fails, do not launch.

## Process Hygiene

- Check there are no stale bots or watchdogs running.

```bash
ps aux | grep microstructure-bot | grep -v grep
ps aux | grep favorite-snipe-bot | grep -v grep
ps aux | grep bot-watchdog | grep -v grep
```

- Confirm there are no unexpected open orders before launch.
- Confirm the collector is healthy on the VPS if the live decision depends on same-day paper context.
- Make sure the live log target is known in advance.

## Launch Command

Start with the smallest intended live config only:

```bash
npx tsx src/scripts/crypto-5min/microstructure-bot.ts --live --size 10 --max-loss 40
```

## What Was Verified In Code

Current live path protections:

- On-chain USDC balance read and hard max-loss floor via [position-verifier.ts](/Users/levanielthompson/Documents/Projects/polymarket-mm/src/core/execution/position-verifier.ts)
- Maker-first, taker-fallback order execution with fill confirmation via [order-executor.ts](/Users/levanielthompson/Documents/Projects/polymarket-mm/src/core/execution/order-executor.ts)
- Append-only trade logging to JSONL and SQLite via [trade-ledger.ts](/Users/levanielthompson/Documents/Projects/polymarket-mm/src/core/execution/trade-ledger.ts)
- Live bot liquidity gate now matches the audited sim by checking total ask depth, not just best-level ask size, in [microstructure-bot.ts](/Users/levanielthompson/Documents/Projects/polymarket-mm/src/scripts/crypto-5min/microstructure-bot.ts#L402)
- Per-trade reconciliation is skipped for overlapping multi-fill candles so the ledger does not record misleading discrepancies, in [microstructure-bot.ts](/Users/levanielthompson/Documents/Projects/polymarket-mm/src/scripts/crypto-5min/microstructure-bot.ts#L781)

## Known Caveats

- Repo-wide `npm run typecheck` is not currently a reliable launch gate because unrelated older scripts fail typecheck.
- The preflight currently may log a transient `"Could not create api key"` from the Polymarket client before `createOrDeriveApiKey()` succeeds. Treat the final auth result as the real signal.
- The preflight proves connectivity and auth, not trade settlement. Real-money execution risk is reduced, not eliminated.

## First-Session Rules

- Do not change strategy rules at launch.
- Do not change trade size mid-session.
- Do not stop the bot unless an actual abort criterion fires.
- After the first live session, compare the live ledger against the sim for every trade taken.

