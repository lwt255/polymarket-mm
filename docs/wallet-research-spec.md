# Wallet Research Spec

## Objective

Reverse-engineer repeatable structure in Polymarket crypto markets without drifting into copy trading.

The core question is not "which wallet won recently?" It is:

- which market behaviors recur,
- which regimes those behaviors exploit,
- whether those behaviors remain profitable out of sample,
- and whether they are executable with our own infrastructure.

## Research Principles

- Treat wallets as observation points, not signals.
- Prefer `behavior x regime` over `wallet x recent PnL` as the primary unit of analysis.
- Keep raw-first storage and preserve full payloads until the event model is stable.
- Separate observed facts from inferred intent.
- Penalize any edge that depends on superior queue position, latency, or hidden information.

## Main Hypotheses

1. Some repeat participants in `btc/eth/sol/xrp` `5m/15m` markets consistently trade specific microstructure regimes rather than trading randomly.
2. The most interesting recurring behaviors will align with the same structural features already visible in collector data:
   - two-sided books that persist through at least `T-60`
   - underdog/favorite dislocations
   - CL-aligned reversals or overreactions
   - late collapse timing
3. A meaningful subset of profitable observed behavior will be non-replicable because it depends on maker queue priority, superior infra, or hidden hedging.
4. The actionable edge will come from translating replicable behavior into our own rules, not from following individual wallets.

## Non-Goals

- Blind copy trading
- Ranking wallets by short-term profit and treating that as alpha
- Assuming every visible trade is a directional entry
- Assuming Polymarket address identity is clean or one-to-one with a human trader

## Failure Modes To Guard Against

- Survivorship bias: recent winners are often just recent lucky variance.
- Identity fragmentation: one trader may control multiple addresses.
- Identity collision: one address may execute multiple distinct behaviors.
- Proxy confusion: Polymarket wallet/proxy mechanics can blur attribution.
- Hidden hedge risk: a trade may be one leg of a broader neutral book.
- Endogeneity: some wallets may move price rather than predict it.
- Non-replicable infra edge: maker queue or latency advantage may explain apparent alpha.
- Regime drift: behavior that works in one liquidity regime may fail in another.
- Storytelling risk: reconstructing trader intent with more confidence than the data supports.

## Required Guardrails

### Evidence hierarchy

Highest confidence:
- raw trade/event payloads
- raw quote/book states
- market resolution

Medium confidence:
- joined regime labels at trade time
- wallet-level position reconstruction with consistent fills

Low confidence:
- inferred intent such as "entry", "exit", "hedge", or "inventory rebalance"

### Replicability filter

Any discovered pattern must answer all of these:

1. Can we detect the setup before the opportunity is gone?
2. Can we express the trade with our own infra and latency?
3. Does it survive worse execution assumptions than the observed wallet likely had?
4. Does it still work if we remove maker-only assumptions?

If not, the pattern is interesting but non-actionable.

Current implementation note:
- `src/scripts/wallet-primitive-replicability-report.ts` applies a provisional primitive-level replicability score using breadth, timing, regime, and likely execution-style mix.
- Treat that score as a screening layer, not a final verdict, until more forward days accumulate.
- `src/scripts/wallet-execution-diagnostics.ts` is the follow-on check for any primitive blocked by heavy `outside_book` fills; use it to separate stale-book artifacts from price improvement or harder-to-replicate execution paths.

### Validation gates

- No serious wallet study before minimum sample thresholds are met.
- Every behavior hypothesis must be tested on forward data after discovery.
- Results should be segmented by:
  - asset
  - interval
  - time-to-expiry bucket
  - liquidity regime
  - aggressor/passive orientation if observable
- Reports should compare candidate patterns against a baseline cohort in the same regimes.

## Research Phases

### Phase 0: Schema Discovery

Goal:
- verify what Polymarket trade endpoints expose for crypto markets

Outputs:
- raw event samples
- raw trade samples
- field inventory
- identity field inventory

Questions:
- do we get `user.address` from market trade events?
- do we get `owner`, `maker_address`, and `maker_orders` from authenticated trade endpoints?
- are timestamps and condition/token references stable enough to join with collector data?

Current implementation note:
- do not assume CLOB `getTrades()` is a public market tape endpoint; official docs describe it as user trade history
- the public Data API `/trades` endpoint is the more promising source for market-level wallet research because it returns `proxyWallet`, profile metadata, and transaction hashes by market

### Phase 1: Raw Trade Collection

Goal:
- build an append-only event corpus for crypto markets

Outputs:
- `wallet-trades.raw.jsonl`

Requirements:
- store full raw payload
- add only minimal normalization
- never discard identity or execution-side fields

### Phase 2: Market-State Enrichment

Goal:
- join each trade to the observed market state at or near trade time

Outputs:
- `wallet-trades.enriched.jsonl`

Required joined fields:
- market metadata
- time-to-expiry
- T-120/T-90/T-60 state
- two-sided / one-sided / not-tradable regime
- spread, depth, slippage-at-size, quote freshness
- CL move and short-horizon underlying features
- favorite/underdog context at trade time

### Phase 3: Identity and Position Reconstruction

Goal:
- group raw prints into wallet-level behavior while preserving uncertainty

Requirements:
- maintain confidence labels on inferred actions
- do not pretend we can perfectly infer intent

Outputs:
- wallet aliases
- wallet trade facts
- wallet market positions
- reconstruction confidence metrics

Current implementation note:
- before deeper intent reconstruction, normalize matched enriched rows into tx-level events and wallet-execution events with `src/scripts/wallet-tx-normalizer.ts`
- use normalized execution events as the default unit when a public feed transaction hash clearly represents a multi-row paired execution
- rerun primitive scoring on `wallet-wallet-executions.normalized.jsonl` before drawing conclusions from raw-row primitive reports; `src/scripts/wallet-normalized-primitive-report.ts` is the current normalized pass
- use `src/scripts/wallet-cross-outcome-economics.ts` to test whether dominant paired structures are just exact complementary bundles; if `UP + DOWN` is almost always `$1.00` with matched sizes, treat that structure as matching plumbing first and alpha second
- after identifying exact complement plumbing, isolate the minority slice with `src/scripts/wallet-minority-structure-report.ts`; this is the current path for finding standalone signal that survives outside venue-level paired bundles
- after isolating the minority slice, use `src/scripts/wallet-underdog-feature-compare.ts` to compare winning vs losing `BUY_UNDERDOG | two-sided` executions on book depth, churn, freshness, and CL/underlying path features
- after feature comparison, use `src/scripts/wallet-underdog-filter-scorer.ts` to translate the strongest feature splits into coarse candidate rules and compare filtered vs baseline economics by bucket
- finally, use `src/scripts/wallet-underdog-strategy-evaluator.ts` to reduce the threshold sweep into a few named candidate strategy presets and decide which one is worth treating as the first real hypothesis

### Phase 4: Behavior Primitive Analysis

Goal:
- discover recurring patterns before ranking wallets

Examples:
- late underdog buy
- favorite chase
- passive maker placement
- rapid scale-in after move
- scale-out before expiry
- repeated same-side participation across consecutive windows

Primary question:
- which primitives outperform by regime?

### Phase 5: Wallet Analysis

Goal:
- identify which wallets repeatedly express the most interesting primitives

Wallets should be evaluated on:
- sample size
- consistency
- regime specialization
- asset specialization
- aggressor/passive mix
- estimated PnL
- forward stability
- replicability

### Phase 6: Strategy Translation

Goal:
- promote only replicable patterns into bot hypotheses

A pattern should only advance if:
- it survives forward validation
- it survives worse execution assumptions
- it appears causal rather than purely correlative

## Minimum Acceptance Criteria

The wallet-research effort is succeeding only if it can answer:

1. Are repeat profitable behaviors present in these crypto markets?
2. Which regimes do those behaviors target?
3. Are those behaviors detectable ex ante?
4. Are they still attractive under our own execution assumptions?

If the result is only "wallet X made money," the project has failed its objective.
