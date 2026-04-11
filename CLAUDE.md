# CLAUDE.md - Central Reference Hub

> **Purpose**: This file is the **central reference hub** for AI agents working on this project. It provides quick-reference information and **pointers to detailed documentation files**. When context is limited, refer agents to specific documentation files rather than duplicating content here.

---

## ⚡ Current Context
- **Current State**: Bot stopped after max-loss hit. Collector running on VPS for 500+ trade paper validation.
- **Infrastructure**: All long-running processes (collector, bots) now run on VPS with `systemd`, not local Mac.
- **Strategy (CORRECTED)**: Buy T-30 leader in 54-75¢ zone, 9-signal system, no prev, no stops, maker orders. **65.8% WR, +$31/day at $10/trade, 8/13 winning days.** See `project_oos_validated_signals_2026_04_01.md` and `project_v4_strategy_2026_04_04.md` memories.
- **Critical Lessons**:
  - Win rate alone is meaningless — must check $/trade. 82% WR across all prices = -$31 P&L.
  - Analysis scripts had bid/ask bug (30% inflation), leader-at-open bug, dedup bug, and prev-chaining bug. Original $200/day claim was really $31/day.
  - Claude's code reviews have missed bugs 5 times. Use Codex review plugin as second opinion.
- **Old Strategies (DEAD)**: Underdog buying, CL-filtered favorite buying, all-price microstructure signals.
- **Wallet**: ~$79 EOA.
- **Collector**: Running on VPS via `systemd`. Logs accessible via SSH.
- **Microstructure Bot**: Stopped (max-loss). Will restart after paper validation completes.
- **Key Scripts**: `verify-collector-resolution.ts` (spot-check), `verify-strategy-winrate.ts` (strategy verification), `backfill-onchain-resolution.ts` (historical fix).
- **Codex Review**: Plugin installed globally. Use `/codex:review` or `/codex:adversarial-review` before trusting any analysis results.

---

## 📋 Project at a Glance

This is a **Polymarket prediction market bot system** for automated trading on Polymarket's CLOB (Central Limit Order Book) on Polygon. The system is currently in **experimental/testing phase** with **Proven Historical Profitability** (+32.4% Annualized).

**Planned Strategies**:
- **Selective Sniper (PRIMARY)** — High-volatility market making, maker rebate capture
- **Market Making** — Bid/ask spread quoting, oscillation capture
- **Arbitrage** — YES + NO < $1.00 detection

**Status**: 🔬 **DRY RUN** — Microstructure bot running, validating live signals before going live.

---

## 📚 Documentation Index

### Core References
- **[AGENTS.md](AGENTS.md)** - Mirror of this file for Codex/other agents
- **[docs/v4-scaling-plan.md](docs/v4-scaling-plan.md)** - **READ BEFORE TOUCHING v4 CODE.** Laddered scaling plan ($10 → $500/trade across 5 phases), graduation/abort criteria, edge monitoring framework, discipline rules
- **[journal/README.md](journal/README.md)** - Journal system usage
- **[.env.example](.env.example)** - Environment variable template
- **[docs/wallet-research-spec.md](docs/wallet-research-spec.md)** - Reverse-engineering spec for wallet behavior research

### Scripts
- **[scripts/journal-entry.sh](scripts/journal-entry.sh)** - Journal helper commands
- **[src/scripts/pricing-collector.ts](src/scripts/pricing-collector.ts)** - Live multi-crypto pricing collector with raw-first quality labeling
- **[src/scripts/pricing-data-utils.ts](src/scripts/pricing-data-utils.ts)** - Shared liquidity classification and tradability helpers
- **[src/scripts/liquidity-regime-analysis.ts](src/scripts/liquidity-regime-analysis.ts)** - Liquidity/collapse timing analysis for raw collector data
- **[src/scripts/wallet-trade-schema-probe.ts](src/scripts/wallet-trade-schema-probe.ts)** - Probe Polymarket wallet-trade/public schema sources before building collectors
- **[src/scripts/wallet-trade-collector.ts](src/scripts/wallet-trade-collector.ts)** - Raw public wallet trade collector (`wallet-trades.raw.jsonl`)
- **[src/scripts/enrich-wallet-trades.ts](src/scripts/enrich-wallet-trades.ts)** - Join wallet trades to pricing collector state and regime labels
- **[src/scripts/wallet-behavior-report.ts](src/scripts/wallet-behavior-report.ts)** - Behavior-first late-window trade flow summary
- **[src/scripts/wallet-primitive-analysis.ts](src/scripts/wallet-primitive-analysis.ts)** - Primitive breadth/concentration and wallet cohort analysis
- **[src/scripts/wallet-primitive-daily-tracker.ts](src/scripts/wallet-primitive-daily-tracker.ts)** - Daily primitive tracker with resolved buy-side outcome scoring
- **[src/scripts/wallet-primitive-replicability-report.ts](src/scripts/wallet-primitive-replicability-report.ts)** - Primitive replicability filter focused on breadth, timing, and execution feasibility
- **[src/scripts/wallet-execution-diagnostics.ts](src/scripts/wallet-execution-diagnostics.ts)** - Decompose `outside_book` prints into price improvement, worse-than-visible fills, quote freshness, and tx-pairing signals
- **[src/scripts/wallet-tx-normalizer.ts](src/scripts/wallet-tx-normalizer.ts)** - Collapse matched wallet trade rows into tx events and wallet-execution events for downstream normalized analysis
- **[src/scripts/wallet-normalized-primitive-report.ts](src/scripts/wallet-normalized-primitive-report.ts)** - Primitive breadth and replicability analysis over normalized wallet-execution events
- **[src/scripts/wallet-cross-outcome-economics.ts](src/scripts/wallet-cross-outcome-economics.ts)** - Characterize whether paired cross-outcome same-side txs are exact complementary bundles or true economic dislocations
- **[src/scripts/wallet-minority-structure-report.ts](src/scripts/wallet-minority-structure-report.ts)** - Analyze primitives outside exact complementary bundles and inside minority tx structures
- **[src/scripts/wallet-underdog-feature-compare.ts](src/scripts/wallet-underdog-feature-compare.ts)** - Compare winning vs losing minority-slice `BUY_UNDERDOG | two-sided` executions using collector microstructure features
- **[src/scripts/wallet-underdog-filter-scorer.ts](src/scripts/wallet-underdog-filter-scorer.ts)** - Sweep coarse threshold rules on minority-slice `BUY_UNDERDOG | two-sided` executions and compare filtered vs baseline performance
- **[src/scripts/wallet-underdog-strategy-evaluator.ts](src/scripts/wallet-underdog-strategy-evaluator.ts)** - Evaluate named candidate strategy presets against minority-slice underdog baselines
- **[src/scripts/wallet-underdog-strategy-robustness.ts](src/scripts/wallet-underdog-strategy-robustness.ts)** - Stress-test named underdog presets by crypto, interval, and market concentration
- **[src/scripts/wallet-underdog-btc-eth-15m-report.ts](src/scripts/wallet-underdog-btc-eth-15m-report.ts)** - Compare the chosen underdog preset against the honest narrowed `BTC/ETH 15m` lane and its local baselines

### Live Bots
- **[src/scripts/crypto-5min/microstructure-bot.ts](src/scripts/crypto-5min/microstructure-bot.ts)** - **v4 live bot.** 9-signal system, buy leader at T-30, 54-75¢ zone, maker-first execution, hold to resolution (no stops). Usage: `npx tsx src/scripts/crypto-5min/microstructure-bot.ts --live --size 10 --max-loss 40`
- **[src/scripts/crypto-5min/favorite-snipe-bot.ts](src/scripts/crypto-5min/favorite-snipe-bot.ts)** - Older favorite snipe bot (Portfolio B filters). Superseded by v4 microstructure-bot.
- **[src/scripts/crypto-5min/underdog-snipe-bot.ts](src/scripts/crypto-5min/underdog-snipe-bot.ts)** - Live underdog snipe bot. DEPRECATED — edge was negative.
- **[src/scripts/crypto-5min/preflight-live.ts](src/scripts/crypto-5min/preflight-live.ts)** - No-trade preflight: wallet/env/auth/balance/market/book checks. **Run before every live launch.**

### Simulation & Monitoring
- **[src/scripts/v4-sim.py](src/scripts/v4-sim.py)** - **v4 paper sim.** Runs 9-signal filter against `pricing-data.jsonl`. Usage: `python3 src/scripts/v4-sim.py <jsonl-file>`
- **[src/scripts/v4-daily-monitor.py](src/scripts/v4-daily-monitor.py)** - Daily edge monitor (Layer 1). Cron runs at 00:07 UTC, appends to `monitoring/v4-daily.jsonl`. Usage: `python3 src/scripts/v4-daily-monitor.py [date|--all]`
- **[src/scripts/v4-sim-audit.py](src/scripts/v4-sim-audit.py)** - Deep audit of v4 sim for bug hunting

### Execution Infrastructure
- **[src/core/execution/position-verifier.ts](src/core/execution/position-verifier.ts)** - On-chain USDC balance verification and hard max loss enforcement
- **[src/core/execution/order-executor.ts](src/core/execution/order-executor.ts)** - Place orders and confirm fills via `getOpenOrders()` polling — never fire-and-forget
- **[src/core/execution/trade-ledger.ts](src/core/execution/trade-ledger.ts)** - Append-only trade log (JSONL) with P&L reconciliation
- **[src/core/clob-client.ts](src/core/clob-client.ts)** - Authenticated CLOB client singleton (viem + L2 API keys)

### Launch Docs
- **[docs/v4-live-checklist.md](docs/v4-live-checklist.md)** - Pre-launch, preflight, and first-session checklist
- **[docs/v4-scaling-plan.md](docs/v4-scaling-plan.md)** - Laddered scaling plan and edge monitoring framework

---

## 🛠️ Tech Stack & Architecture

- **Runtime**: Node.js + TypeScript (ES modules)
- **SDK**: `@polymarket/clob-client` (official Polymarket CLOB client)
- **Wallet**: `viem` for Polygon signing
- **Database**: SQLite (local) + Supabase (optional cloud analytics)
- **Network**: Polygon mainnet

### Directory Structure
```
src/
├── core/           # Shared infrastructure
│   ├── risk/       # Risk management
│   ├── db/         # Database layer
│   ├── types.ts    # Shared types
│   └── rate-limiter.ts
├── strategies/     # Trading strategies (future)
│   ├── market-maker/
│   ├── arbitrage/
│   └── rebate-farm/
└── index.ts        # Entry point

journal/            # Daily activity logs
scripts/            # Helper scripts
state/              # Runtime state files (JSON)
logs/               # Log output
systemd/            # VPS deployment templates
```

---

## 🖥️ Process Management (VPS)

All long-running processes run on the **VPS** (`178.62.235.212`) with `systemd`. Local Mac is for development only.

### VPS Connection
```bash
ssh root@178.62.235.212
```

### Services Running

**1. Pricing Collector** (`polymarket-collector.service`)
- User: `polybot`
- Working dir: `/home/polybot/polymarket-mm`
- Script: `src/scripts/pricing-collector.ts --continuous`
- Log: `/home/polybot/polymarket-mm/logs/collector.log`
- Data: `/home/polybot/polymarket-mm/pricing-data.jsonl`

**2. v4 Microstructure Bot** (`polymarket-v4-bot.service`)
- User: `polybot`
- Working dir: `/home/polybot/polymarket-mm`
- Script: `src/scripts/crypto-5min/microstructure-bot.ts --live --size 10 --max-loss 40`
- Log: `/home/polybot/polymarket-mm/logs/v4-bot.log`
- Trade ledger: `/home/polybot/polymarket-mm/microstructure-trades.jsonl` (**NEVER DELETE**)
- Monitoring: `/home/polybot/polymarket-mm/monitoring/v4-daily.jsonl`
- Preflight: `npx tsx src/scripts/crypto-5min/preflight-live.ts --max-loss 40`

**3. Copy-Trade Bot** (`copy-trade-bot.service`)
- User: `root`
- Working dir: `/root/copy-trade-bot`
- Script: `copy-trade-bot.ts` (standalone, not in repo)
- Log: `/root/copy-trade-bot/copy-trade-bot.log`
- Trade ledger: `/root/copy-trade-bot/copy-trades.jsonl` (**NEVER DELETE**)
- State: `/root/copy-trade-bot/state/copy-trade-seen.json`
- Auth: Bullpen CLI credentials at `/root/.bullpen/credentials.json`
- Known issue: JWT expires every ~3 hours; auto-refresh built in but untested due to rate limiting

### Common Commands
```bash
# Check service status
ssh root@178.62.235.212 'systemctl status polymarket-collector'
ssh root@178.62.235.212 'systemctl status polymarket-v4-bot'
ssh root@178.62.235.212 'systemctl status copy-trade-bot'

# Tail v4 bot logs (live)
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/v4-bot.log'

# Tail collector logs
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/collector.log'

# Tail copy-trade bot logs
ssh root@178.62.235.212 'tail -30 /root/copy-trade-bot/copy-trade-bot.log'

# Check v4 daily monitoring
ssh root@178.62.235.212 'cat /home/polybot/polymarket-mm/monitoring/v4-daily.jsonl'

# Check copy-trade ledger (NEVER delete this file)
ssh root@178.62.235.212 'wc -l /root/copy-trade-bot/copy-trades.jsonl'

# Restart (preserves trade data)
ssh root@178.62.235.212 'systemctl restart copy-trade-bot'
ssh root@178.62.235.212 'systemctl restart polymarket-collector'

# Deploy updated copy-trade bot code
scp src/scripts/copy-trade-bot.ts root@178.62.235.212:/root/copy-trade-bot/copy-trade-bot.ts
ssh root@178.62.235.212 'systemctl restart copy-trade-bot'

# Deploy updated v4 bot code
scp src/scripts/crypto-5min/microstructure-bot.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/crypto-5min/microstructure-bot.ts
scp src/core/execution/position-verifier.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/position-verifier.ts
scp src/core/execution/order-executor.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/order-executor.ts
scp src/core/execution/trade-ledger.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/trade-ledger.ts
scp src/core/clob-client.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/clob-client.ts
ssh root@178.62.235.212 'systemctl restart polymarket-v4-bot'

# Deploy updated v4 sim/monitor scripts
scp src/scripts/v4-sim.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-sim.py
scp src/scripts/v4-daily-monitor.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-daily-monitor.py
scp ~/.bullpen/credentials.json root@178.62.235.212:/root/.bullpen/credentials.json
```

### Local Development (Mac)
For local testing only, use `caffeinate -s nohup`:
```bash
caffeinate -s nohup npx tsx src/scripts/crypto-5min/microstructure-bot.ts >> logs/microstructure-bot.log 2>&1 &
caffeinate -s nohup npx tsx src/scripts/pricing-collector.ts >> logs/collector.log 2>&1 &
```

---

## 🔍 Codex Review (Second Opinion)

The Codex plugin (GPT-5.4) is installed globally. **ALWAYS use it before trusting analysis results** — Claude's own code reviews have missed bugs 5 times in this project.

```bash
# Standard review of current changes
/codex:review

# Adversarial review (challenges assumptions and design)
/codex:adversarial-review

# Hand off deep investigation to Codex
/codex:rescue
```

**When to use**: Any time an analysis produces a number that will drive a trading decision (strategy P&L, win rates, signal validation). The review should specifically check:
1. Is P&L computed using ASK price (not BID)?
2. Is the leader determined at T-30 (not market open)?
3. Is data deduped (no duplicate slugs)?
4. Does prev only chain from 5m candles?
5. Are there any lookahead biases (using data the bot wouldn't have at decision time)?

---

## 🔧 Environment Variables (from .env)

```bash
# Required
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_ADDRESS=0x...

# Optional
SUPABASE_CONNECTION_STRING=  # Cloud analytics
POLYGON_RPC_URL=             # Custom RPC
```

### Bitwarden Secrets Manager
- **BWS_ACCESS_TOKEN**: API token for secrets
- **BWS_ORGANIZATION_ID**: Organization ID for secrets
- **Key naming**: Uses `EVM_WALLET_PRIVATE_KEY2` for Polymarket testing.


**Security**: Never commit `.env` or plain text private keys. Use `initBitwardenSecrets()` to load at runtime.

---

## 📓 Polymarket-MM Journal System

**Location**: `journal/YYYY-MM-DD.md`

Track daily activities, observations, insights, and bot performance:
```bash
# View today's journal
cat journal/$(date +%Y-%m-%d).md

# Add new session entry
./scripts/journal-entry.sh add "Activity Title"

# Create today's journal
./scripts/journal-entry.sh new
```

**For AI agents**: When starting a new session, check today's journal for context on:
- Recent testing and observations
- Issues being investigated
- Decisions made earlier
- Pending tasks

See [journal/README.md](journal/README.md) for complete documentation.

---

## 🚀 Development Workflow

### Setup
```bash
npm install
cp .env.example .env
# Edit .env with your credentials
```

### Run (Development)
```bash
npm run dev
```

### Type Check
```bash
npm run typecheck
```

---

## 🎯 Polymarket API Quick Reference

### CLOB Client (Order Execution)
```typescript
import { ClobClient } from '@polymarket/clob-client';

const client = new ClobClient(
  'https://clob.polymarket.com',
  137, // Polygon chainId
  wallet
);

// Get market info
const market = await client.getMarket(tokenId);

// Place order
const order = await client.createOrder({
  tokenId,
  side: 'BUY',
  price: 0.55,
  size: 100,
});
```

### Key Concepts
- **Token ID**: Each outcome (YES/NO) has a unique token ID
- **Price**: 0.00 to 1.00 (probability)
- **Maker rebate**: Earn rebate for providing liquidity
- **Taker fee**: Pay fee for taking liquidity

---

## 🎓 AI Agent Guidelines

### When Context is Limited
1. **Read this file first** for project overview and navigation
2. **Check journal/** for recent activity and decisions
3. **Keep `CLAUDE.md` and `AGENTS.md` mirrored** when updating shared agent context
4. **Reference specific docs** instead of duplicating content

### Key Strategies to Explore
1. **Arbitrage**: If YES + NO prices < $1.00, buy both for guaranteed profit
2. **Market Making**: Quote bid/ask spread, earn maker rebates
3. **Rebate Farming**: Maximize maker rebate by providing liquidity

### Safety First
- This is **experimental** - no live trading yet
- Always test strategies with backtests/simulation first
- Document all findings in journal
- Treat collector-derived win rates as **provisional** after any sampling or data-quality bug until enough clean replacement data is collected

---

## 📈 Performance Tracking

### 🏁 90-Day Definitive Portfolio Proof
- **Period**: Oct 2025 - Jan 2026
- **Aggregate ROI**: **+8.10%** (+32.4% Annualized)
- **Primary Strategy**: Selective Sniper
- **Top Market (Trump)**: +21.30% ROI
- **Top Market (Bears SB)**: +15.49% ROI
- **Infrastructure**: Validated on high-fidelity 1m/1h hybrid dataset.

---

**Last Updated**: April 6, 2026
