# v4 Live Launch Checklist

Purpose: make the eventual v4 cutover boring. This checklist is for launch-day validation, not strategy research.

## Before Funding / Before Launch Decision

- Confirm paper validation is still on track with the corrected sim and no new audit issues.
- Re-read [v4-scaling-plan.md](/Users/levanielthompson/Documents/Projects/polymarket-mm/docs/v4-scaling-plan.md) and verify the phase-entry criteria still make sense in current conditions.
- Fund the Polymarket EOA to a bankroll level that matches the intended live size.
- Decide the first live config in advance.
  Suggested first config: `--live --size 10 --max-loss 40`
- Make the launch decision on a calm day, not on a hot streak or drawdown day.

## Deploy to VPS

Deploy updated code from local Mac:

```bash
# Deploy bot and execution infra
scp src/scripts/crypto-5min/microstructure-bot.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/crypto-5min/microstructure-bot.ts
scp src/core/execution/position-verifier.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/position-verifier.ts
scp src/core/execution/order-executor.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/order-executor.ts
scp src/core/execution/trade-ledger.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/trade-ledger.ts
scp src/core/clob-client.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/clob-client.ts

# Deploy sim/monitor scripts
scp src/scripts/v4-sim.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-sim.py
scp src/scripts/v4-daily-monitor.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-daily-monitor.py

# Update systemd service (if changed)
scp systemd/polymarket-v4-bot.service root@178.62.235.212:/etc/systemd/system/polymarket-v4-bot.service
ssh root@178.62.235.212 'systemctl daemon-reload'

# Set permissions
ssh root@178.62.235.212 'chown -R polybot:polybot /home/polybot/polymarket-mm/src/ /home/polybot/polymarket-mm/state/'
```

## Dry-Run Test on VPS

Before going live, verify the bot starts without errors:

```bash
ssh root@178.62.235.212 'cd /home/polybot/polymarket-mm && timeout 15 npx tsx src/scripts/crypto-5min/microstructure-bot.ts 2>&1 | head -30'
```

Must see: "MICROSTRUCTURE BOT v4 — 9-Signal System", "Mode: DRY RUN", Chainlink connected, no transform/syntax errors.

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
ssh root@178.62.235.212 'ps aux | grep microstructure-bot | grep -v grep'
ssh root@178.62.235.212 'ps aux | grep favorite-snipe-bot | grep -v grep'
ssh root@178.62.235.212 'ps aux | grep bot-watchdog | grep -v grep'
```

- Confirm there are no unexpected open orders before launch.
- Confirm the collector is healthy on the VPS if the live decision depends on same-day paper context.
- Make sure the live log target is known in advance.

## Go Live

Start the bot via systemd:

```bash
ssh root@178.62.235.212 'systemctl enable polymarket-v4-bot && systemctl start polymarket-v4-bot'
```

Verify it's running and live:

```bash
ssh root@178.62.235.212 'systemctl status polymarket-v4-bot'
ssh root@178.62.235.212 'tail -20 /home/polybot/polymarket-mm/logs/v4-bot.log'
```

Must see: "Mode: LIVE TRADING", correct balance, Chainlink connected, waiting for next candle.

To stop the bot:

```bash
ssh root@178.62.235.212 'systemctl stop polymarket-v4-bot'
```

## Check Daily Monitoring

After the first full day, verify the daily monitor ran:

```bash
ssh root@178.62.235.212 'cat /home/polybot/polymarket-mm/monitoring/v4-daily.jsonl | tail -1'
ssh root@178.62.235.212 'cat /home/polybot/polymarket-mm/logs/v4-daily-monitor.log | tail -5'
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

