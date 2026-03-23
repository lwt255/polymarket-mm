# CLAUDE.md - Central Reference Hub

> **Purpose**: This file is the **central reference hub** for AI agents working on this project. It provides quick-reference information and **pointers to detailed documentation files**. When context is limited, refer agents to specific documentation files rather than duplicating content here.

---

## ⚡ Current Context
- **Current State**: Bot Stopped; Collector Running Locally With Raw / Strategy / Rejected Dataset Split
- **Last Commit**: `d012931` — fix: collector throughput and data-quality guards
- **Recent Changes**: Fixed collector under-sampling to reach the true 64 markets/hour ceiling, added liquidity profiling plus a tradable `T-120` gate, and split outputs into `pricing-data.raw.jsonl` (2,193 rows), `pricing-data.jsonl` strategy-grade (2,144 rows), and `pricing-data.rejected.jsonl` (16 rows). Empty early books now appear to be a real market-liquidity constraint rather than a collector failure.

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

### Scripts
- **[scripts/journal-entry.sh](scripts/journal-entry.sh)** - Journal helper commands
- **[src/scripts/pricing-collector.ts](src/scripts/pricing-collector.ts)** - Live multi-crypto pricing collector with quality rejection
- **[src/scripts/pricing-data-utils.ts](src/scripts/pricing-data-utils.ts)** - Shared liquidity classification and tradability helpers

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

**Last Updated**: March 23, 2026
