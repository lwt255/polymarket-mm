# Trading Program: BTC 5-Min Maker Arbitrage

## Strategy Overview

Post maker-only limit BUY orders on both UP and DOWN sides of Polymarket BTC 5-minute binary markets. If both fill at combined cost < $1.00, you lock in guaranteed profit at resolution regardless of outcome. Maker orders have zero fees on Polymarket.

## How It Works

1. Every 5 minutes, a new BTC UP/DOWN market opens on Polymarket
2. We place limit BUY orders below the midpoint on BOTH sides
3. If the market oscillates enough that both bids get filled, we own both UP and DOWN
4. At resolution, exactly one side pays $1.00 → profit = $1.00 - combined_cost
5. Risk: only ONE side fills → directional exposure

## Parameters You Can Tune

| Parameter | Range | Description |
|-----------|-------|-------------|
| `upBidOffset` | 0.005–0.15 | How far below UP midpoint to bid |
| `downBidOffset` | 0.005–0.15 | How far below DOWN midpoint to bid |
| `useSymmetricPricing` | bool | Use same offset for both sides |
| `entryDelaySeconds` | 0–120 | Wait before placing orders |
| `exitBeforeEndSeconds` | 5–60 | Cancel unfilled orders before resolution |
| `minSpreadCents` | 0–10 | Skip markets with tight spreads |
| `maxOverroundCents` | 0–10 | Skip if ask sum too far above $1.00 |
| `minBookDepthUsd` | 0–500 | Skip thin books |
| `sharesPerSide` | 5–200 | Position size |
| `maxSingleSideLossCents` | 1–50 | Max acceptable single-fill loss |
| `cancelOnSingleFill` | bool | Cancel other side on single fill |
| `fillThresholdCents` | 0–5 | How close ask must get to simulate fill |
| `partialFillRatio` | 0.1–1.0 | Assumed fill fraction |

## Evaluation Criteria

Your changes are scored by:
```
score = 2.0 * netPnlCents
      + 1.5 * bothFillRate * 100
      + 0.5 * marketsTraded
      - 1.0 * maxDrawdownCents
      - 0.8 * singleFillLossCents
```

**Auto-reject if**: marketsTraded < 3, netPnlCents < -200, bothFillRate < 5%

## Experimentation Guidelines

1. **Change 1-2 parameters at a time** — isolate what works
2. **State your hypothesis** — why you expect this change to improve the score
3. **Learn from history** — if wider offsets helped, try slightly wider. If they hurt, try tighter
4. **Balance fill rate vs profit** — wider offsets = more fills but less profit per fill
5. **Consider timing** — entry delay and exit-before-end affect which price action you capture
6. **Book depth matters** — thin books mean your fills may not be reliable
7. **Symmetric vs asymmetric** — BTC markets may have directional bias in some periods

## Key Insights from Live Data

- Buy-both-asks overround is typically ~1¢ (so arb from market-taking doesn't exist)
- BUT maker bids sum to LESS than $1.00 (underround is positive)
- The edge comes from getting filled at favorable limit prices, not from taking
- High-volatility moments create more fill opportunities
- Markets transition every 5 minutes — there's always a fresh opportunity

## Findings from Run 1 (10 iterations, 60min each)

These are proven insights — use them to guide your exploration.

### What We Know Works
- **cancelOnSingleFill=false is critical.** With it on, the bot got 0% both-fill rate across 6+ markets. Turning it off immediately jumped to 57-86% both-fill rate. This was the single biggest unlock (iteration 3).
- **Offset 0.02 is the sweet spot so far.** 0.03 was too wide (low fill rate), 0.05 was way too wide. 0.02 gives 57-86% both-fill rate.
- **Shares 15 performs well.** Reducing from 20 to 15 didn't hurt fill rate and reduced single-fill exposure.

### What Still Needs Exploring
The AI only touched 4 of 13 parameters in run 1. These are **unexplored and high-potential**:
- **entryDelaySeconds** (currently 10s) — waiting longer might let spreads widen, increasing fill odds
- **exitBeforeEndSeconds** (currently 15s) — adjusting could change which price action we capture
- **minSpreadCents** (currently 1) — filtering for wider spreads could improve per-trade profitability
- **maxOverroundCents** (currently 4) — loosening could add more trading opportunities
- **minBookDepthUsd** (currently 20) — adjusting affects which markets we enter
- **fillThresholdCents** (currently 0) — adding a buffer might simulate more conservative fills
- **useSymmetricPricing** (currently true) — asymmetric offsets could exploit directional biases

### The Core Challenge
Both-fill profit per market is thin (~2-4¢ when offset=0.02). Single-fill losses (~15% of markets) can wipe out multiple both-fill wins. The AI needs to find parameter combos that either:
1. Increase both-fill rate above 85%+ to overwhelm occasional losses, OR
2. Reduce single-fill loss severity (via timing, filtering, or position sizing), OR
3. Find a wider offset that still gets decent fills (more profit per both-fill)
