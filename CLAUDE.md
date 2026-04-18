# CLAUDE.md

Polymarket prediction market bot system — automated trading on Polymarket's CLOB (Polygon). Experimental phase, bot currently stopped.

## Rules

- **NEVER delete trade ledgers** (`microstructure-trades.jsonl`, `copy-trades.jsonl`) — append only, archive if needed
- **Codex review before trusting analysis** — Claude's reviews have missed bugs 5 times. Use `/codex:review` when analysis produces numbers driving trading decisions (P&L, win rates, signal validation)
- **Dry run before live** — always validate with paper trades first
- **Verify data span** before any "all-time" analysis — print first/last timestamps, confirm coverage
- **Read `docs/v4-scaling-plan.md`** before touching v4 bot code

## Current State

- **Bot**: Stopped (max-loss hit). Collector running on VPS for 500+ trade paper validation.
- **Strategy**: v4 — buy T-30 leader in 54-75¢ zone, 9-signal system, maker-first, hold to resolution. 65.8% WR, +$31/day at $10/trade.
- **Wallet**: ~$79 EOA
- **Dead strategies**: Underdog buying, CL-filtered favorite buying, all-price microstructure signals

## VPS Services

All processes run on VPS (`178.62.235.212`) with `systemd`. Local Mac = dev only.

| Service | systemd unit | User | Key files |
|---------|-------------|------|-----------|
| Pricing Collector | `polymarket-collector` | `polybot` | `logs/collector.log`, `pricing-data.jsonl` |
| v4 Bot | `polymarket-v4-bot` | `polybot` | `logs/v4-bot.log`, `microstructure-trades.jsonl` |
| Copy-Trade Bot | `copy-trade-bot` | `root` | `/root/copy-trade-bot/copy-trade-bot.log`, `copy-trades.jsonl` |

Commands: `docs/vps-commands.md`

## Key Docs

- `docs/v4-scaling-plan.md` — Scaling plan, graduation criteria, edge monitoring
- `docs/v4-live-checklist.md` — Pre-launch checklist
- `src/scripts/crypto-5min/preflight-live.ts` — Run before every live launch
- `journal/YYYY-MM-DD.md` — Daily activity logs (check for session context)

## Secrets

Uses Bitwarden Secrets Manager (`initBitwardenSecrets()`). Never commit `.env` or plain text keys.
- `BWS_ACCESS_TOKEN`, `BWS_ORGANIZATION_ID`
- Key: `EVM_WALLET_PRIVATE_KEY2` for Polymarket testing
