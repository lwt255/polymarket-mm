# VPS Commands Reference

## Connection
```bash
ssh root@178.62.235.212
```

## Service Status
```bash
ssh root@178.62.235.212 'systemctl status polymarket-collector'
ssh root@178.62.235.212 'systemctl status polymarket-v4-bot'
ssh root@178.62.235.212 'systemctl status polymarket-strike-collector'
ssh root@178.62.235.212 'systemctl status polymarket-hourly-collector'
ssh root@178.62.235.212 'systemctl status copy-trade-bot'
```

## Tail Logs
```bash
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/v4-bot.log'
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/collector.log'
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/strike-collector.log'
ssh root@178.62.235.212 'tail -30 /home/polybot/polymarket-mm/logs/hourly-collector.log'
ssh root@178.62.235.212 'tail -30 /root/copy-trade-bot/copy-trade-bot.log'
```

## Monitoring & Ledgers
```bash
ssh root@178.62.235.212 'cat /home/polybot/polymarket-mm/monitoring/v4-daily.jsonl'
ssh root@178.62.235.212 'wc -l /root/copy-trade-bot/copy-trades.jsonl'
```

## Restart Services
```bash
ssh root@178.62.235.212 'systemctl restart polymarket-collector'
ssh root@178.62.235.212 'systemctl restart polymarket-v4-bot'
ssh root@178.62.235.212 'systemctl restart copy-trade-bot'
```

## Deploy Code
```bash
# Copy-trade bot
scp src/scripts/copy-trade-bot.ts root@178.62.235.212:/root/copy-trade-bot/copy-trade-bot.ts
ssh root@178.62.235.212 'systemctl restart copy-trade-bot'

# v4 bot (all execution files)
scp src/scripts/crypto-5min/microstructure-bot.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/crypto-5min/microstructure-bot.ts
scp src/core/execution/position-verifier.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/position-verifier.ts
scp src/core/execution/order-executor.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/order-executor.ts
scp src/core/execution/trade-ledger.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/execution/trade-ledger.ts
scp src/core/clob-client.ts root@178.62.235.212:/home/polybot/polymarket-mm/src/core/clob-client.ts
ssh root@178.62.235.212 'systemctl restart polymarket-v4-bot'

# v4 sim/monitor
scp src/scripts/v4-sim.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-sim.py
scp src/scripts/v4-daily-monitor.py root@178.62.235.212:/home/polybot/polymarket-mm/src/scripts/v4-daily-monitor.py
```

## Local Development (Mac)
```bash
caffeinate -s nohup npx tsx src/scripts/crypto-5min/microstructure-bot.ts >> logs/microstructure-bot.log 2>&1 &
caffeinate -s nohup npx tsx src/scripts/pricing-collector.ts >> logs/collector.log 2>&1 &
```
