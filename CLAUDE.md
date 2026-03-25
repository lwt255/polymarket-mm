# CLAUDE.md - Central Reference Hub

> **Purpose**: This file is the **central reference hub** for AI agents working on this project. It provides quick-reference information and **pointers to detailed documentation files**. When context is limited, refer agents to specific documentation files rather than duplicating content here.

---

## ⚡ Current Context
- **Current State**: Bot Stopped; Collector Running Locally With Enriched Microstructure Metrics; Wallet Reverse-Engineering Pipeline Added And Refreshed
- **Last Commit**: `35cf0e8` — feat: add wallet reverse-engineering research pipeline
- **Recent Changes**: Added a wallet reverse-engineering research pipeline on top of the collector stack. New scripts probe Polymarket trade schemas, collect raw public wallet trade prints from the Data API into `wallet-trades.raw.jsonl`, enrich them against `pricing-data.raw.jsonl`, and analyze behavior primitives, wallet cohorts, daily primitive outcome tracking, primitive replicability, execution diagnostics, tx-normalized execution events, normalized primitive scoring, cross-outcome bundle economics, minority-structure slices, success/failure feature comparisons, concrete threshold scoring, and named strategy presets. Current read: broad `BUY_FAVORITE` flow dominates one-sided regimes, while the best structural candidates remain `BUY_UNDERDOG` in two-sided regimes. The dominant paired tx structure is overwhelmingly exact complementary `UP + DOWN = $1.00` with matched sizes, so much of that flow is matching structure rather than standalone alpha. Once those exact complement bundles are stripped out, two-sided underdog flow still looks strong, especially `31-60s` and `0-30s`. The first preset evaluator says the cleanest build target is a `31-60s` downside-continuation rule (`finalTrend <= 0`, preferably `clMove <= -1`, optionally thinner favorite depth). The earlier `121-210s` variant does not survive as a first strategy.

---

## 📋 Project at a Glance

This is a **Polymarket prediction market bot system** for automated trading on Polymarket's CLOB (Central Limit Order Book) on Polygon. The system is currently in **experimental/testing phase** with **Proven Historical Profitability** (+32.4% Annualized).

**Planned Strategies**:
- **Selective Sniper (PRIMARY)** — High-volatility market making, maker rebate capture
- **Market Making** — Bid/ask spread quoting, oscillation capture
- **Arbitrage** — YES + NO < $1.00 detection

**Status**: 💎 **PROVEN PROFITABILITY** - 8.10% Portfolio ROI (90-Day Proof)

---

## 📚 Documentation Index

### Core References
- **[AGENTS.md](AGENTS.md)** - Mirror of this file for Codex/other agents
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

**Last Updated**: March 24, 2026
