# Pulse5 Roadmap

This roadmap starts from the current v0.2 state:

- v0.1 captures BTC 5-minute Up/Down market data.
- v0.2 adds pure shadow signal logic, `market_states`, `signals`, and replay labeling.
- In the current v0.2 PR, the collector flag is marker-only; live periodic signal emission is deferred.
- Pulse5 still does not trade, paper trade, place orders, connect wallets, handle private keys, or use signers.

The guiding rule for v0.3+ is simple:

> Research can kill a strategy, but only realistic paper simulation plus calibration can promote it.

## Non-Negotiable Gates

- Do not skip v0.3 paper execution simulation.
- Do not mix simulated and live execution rows in the same table.
- Do not introduce wallet/private-key/signer handling before the canary-live phase.
- Do not treat shadow EV as executable EV.
- If calibration fails, return to v0.2 signal-engine design. Do not merely wait for more data or tune thresholds around a broken model.

## Recommended Path

```text
v0.2.1 -> v0.3 -> v0.4 -> v0.5 -> v0.6
```

Removed path:

```text
v0.2.1 -> v0.4-lite -> v0.3
```

Reason: shadow signals ignore spread traversal, queue position, partial fills, cancellations, minimum order size, and practical liquidity. Shadow results can reject a strategy, but cannot approve it for live work.

## v0.2.1 - Shadow Signal Batch + Live Marker Follow-Through

Status: batch replay path delivered and real-data dry-run verified on branch
`codex/v0.2.1-shadow-batch-replay`. Optional live collector emission was
**not** added in this PR — the marker-only flag from v0.2 is unchanged.
Live emission can land in a focused follow-up once a real density report
demonstrates it is needed.

Goal:

Make v0.2 produce enough labeled shadow data to decide whether v0.3 simulation is worth running seriously.

Scope:

- Add batch replay over historical markets. _(Done — `research/replay/replay-batch.ts`.)_
- Estimate signal density from real captured data before setting sample targets. _(Done — local `pulse5tester` dry-run report: 200 observed, 187 replay-ready, 11,033 states/signals, 0 accepted.)_
- Run at least one week of replay to estimate:
  - markets observed
  - states built
  - total signals
  - accepted signals
  - accepted signal rate
  - rejection reason distribution
  - `p_win` bucket distribution
  _(All emitted by the v0.2.1 signal-density report; the actual one-week
  run remains a manual operational step against a longer live database window.)_
- Add optional live collector state/signal emission behind an explicit flag, if the implementation can stay read-only and small. _(Deferred — kept v0.2's marker-only flag for review-surface minimisation. Future PR.)_
- Keep the collector default behavior unchanged. _(Done — collector code paths untouched in v0.2.1.)_
- Keep all v0.2 logic pure and shared between replay and future live emission. _(Done — batch replay reuses `buildMarketState` / `generateSignal` / `labelSignalOutcome` from `@pulse5/strategy`; no replay-only signal engine was introduced.)_

Sample gate:

- Do not use a fixed "300-1000 total signals" target until signal rate is measured.
- After signal density is measured, set sample goals by `p_win` bucket.
- Key buckets should each have at least 30 labeled accepted signals before treating that bucket as informative.

Measured v0.2.1 result:

- `pulse5tester` limit-200 dry-run built 11,033 states and generated 11,033 signals.
- Accepted signal density was 0% (`accepted = 0`), so every key `p_win` bucket had `labeledAccepted = 0`.
- Batch replay/reporting can close, but v0.3 paper execution should not be promoted from this result.

Suggested initial buckets:

| Bucket | Meaning |
| --- | --- |
| `0.50 <= p_win < 0.60` | weak edge / baseline |
| `0.60 <= p_win < 0.70` | moderate edge |
| `0.70 <= p_win < 0.80` | strong edge |
| `p_win >= 0.80` | high-confidence gate bucket |

Completion criteria:

- Batch replay can process multiple resolved markets deterministically.
- Replay uses no future data: all book/tick inputs obey `receive_ts <= target_timestamp`.
- Outcome labels are attached after resolution only.
- Signal density report exists.
- Key `p_win` buckets have enough samples, or the roadmap explicitly records that more data is required.
- No trading, wallet, signer, private-key, live execution, or paper execution path exists yet.

## v0.3 - Paper Execution Simulator

Goal:

Simulate executable outcomes realistically from stored market data.

Important naming decision:

Use `simulated_*` table names. Do not create a generic `orders` table for paper work.

Recommended schema surface:

- `simulation_runs`
- `simulated_orders`
- `simulated_fills`
- `simulated_positions`

The reason is to avoid future ambiguity where one `orders` table contains both fake and real rows. Paper and live execution must stay structurally separate.

Core design:

- Introduce an `ExecutionAdapter` interface at the start of v0.3.
- Implement `PaperExecutionAdapter` in v0.3.
- Define but do not implement `LiveExecutionAdapter` until v0.6.
- Route execution through the same shape the live system will eventually use:

```text
signal -> risk check -> ExecutionAdapter -> result
```

The simulator should not be a standalone `runPaperSimulation()` path that later needs to be rewritten. It should exercise the same adapter boundary live execution will use.

Paper simulation requirements:

- Simulate limit order placement.
- Simulate queue position conservatively.
- Simulate partial fills.
- Include spread traversal.
- Include depth.
- Include latency.
- Include cancellations.
- Include Polymarket minimum size constraints, including the 5-share minimum where applicable.
- Record simulated PnL.
- Reproduce decisions deterministically from stored data.

Risk interface requirement:

- v0.3 should introduce the risk-check call boundary even if the first implementation is minimal.
- The simulator should call risk before simulated execution.
- v0.5 will harden the risk engine; v0.3 should establish the seam.

Completion criteria:

- Paper PnL can be replayed deterministically from stored v0.1/v0.2 data.
- Simulated orders and fills are stored only in `simulated_*` tables.
- No wallet, signer, private-key, or live order path exists.
- The simulator can run from a fixed replay window and produce identical output on repeated runs.

## v0.4 - Calibration

Goal:

Validate whether the signal engine plus paper execution model still shows an edge after realistic fills.

Reports:

- Win-rate by `p_win` bucket.
- Expected EV vs realized paper EV.
- Fill rate by side, time remaining, distance, and price.
- Slippage by side and order book depth.
- Distance/time heatmaps.
- Rejection reason distribution.
- Latency sensitivity.
- Chainlink/Binance gap sensitivity.

Hard gate:

- High-confidence buckets must be statistically meaningful.
- Key `p_win` buckets should each have at least 30 labeled accepted signals.
- `p_win >= 0.80` signals must realize close to or above the expected win rate after paper execution effects.
- Net paper EV must remain positive after spread, simulated slippage, partial fills, cancellations, and latency.

Failure rule:

If calibration fails, the signal engine is considered wrong for this market regime.

The response is:

```text
return to v0.2 signal-engine design
```

Not:

- wait two more weeks and hope
- tune thresholds until the report looks better
- promote to live because shadow EV looked good

Completion criteria:

- Calibration report exists.
- Pass/fail decision is explicit.
- If failed, a new v0.2 signal-engine redesign cycle is opened before any further execution work.

## v0.5 - Risk Engine

Goal:

Build the risk engine as a standalone decision layer before live trading exists.

This phase is intentionally not live trading.

Scope:

- Create `packages/risk`.
- Define risk input/output models.
- Enforce bankroll-independent dry-run limits first.
- Add kill-switch state.
- Add feed staleness checks.
- Add local clock drift checks.
- Add max exposure checks.
- Add daily loss / drawdown simulation checks.
- Add max consecutive loss checks.
- Integrate risk checks into paper simulation and replay reports.

Why separate from canary live:

Risk must be tested in paper mode before it protects real funds. By v0.6, the risk layer should already be boring and proven; only the adapter changes.

Completion criteria:

- Paper simulator cannot execute a simulated order without a risk decision.
- Risk decisions are logged and replayable.
- Risk behavior is deterministic under replay.
- No live adapter exists yet.
- No wallet/private-key/signer handling exists yet.

## v0.6 - Canary Live

Goal:

Run very small live trades only after v0.3 paper simulation, v0.4 calibration, and v0.5 risk gates pass.

Scope:

- Implement `LiveExecutionAdapter`.
- Keep `PaperExecutionAdapter` and `LiveExecutionAdapter` separate.
- Use explicit manual enablement.
- Use separate live environment variables.
- Add audit logging for every decision, risk check, adapter call, and response.
- Default all kill switches to safe/off.

Initial limits:

```text
max_position_per_market = bankroll * 0.25%
daily_max_loss = bankroll * 2%
daily_max_drawdown = bankroll * 3%
max_consecutive_losses = 4
```

Live must stop immediately if:

- Polymarket WebSocket is stale.
- BTC feed is stale.
- Chainlink/proxy feed is stale.
- local clock drift is too high.
- order confirmation times out.
- unexpected open position exists.
- API errors spike.
- risk engine returns anything other than allow.

Completion criteria:

- Canary can run with tiny size and full audit trail.
- Every live action is attributable to a signal, market state, risk decision, and adapter response.
- Kill switch can stop live execution immediately.
- No scaling logic exists.

## v0.7 - Operations, Dashboard, and Scaling Decision

Goal:

Decide whether the system deserves more capital, not merely whether it can trade.

Scope:

- Lightweight dashboard or reports for:
  - data freshness
  - live/paper divergence
  - signal rate
  - fill rate
  - realized PnL
  - kill-switch events
  - calibration drift
- Post-canary review.
- Decide whether to:
  - keep collecting
  - redesign strategy
  - continue tiny canary
  - scale cautiously
  - shut down the strategy

Completion criteria:

- Scaling decision is explicit and evidence-based.
- No automatic capital scaling without a new review gate.

## Summary

The roadmap is intentionally conservative:

1. v0.2.1 measures signal density and collects enough labeled data.
2. v0.3 simulates execution realistically with `simulated_*` tables and an `ExecutionAdapter`.
3. v0.4 calibrates the full signal-plus-paper system.
4. v0.5 hardens risk before live exists.
5. v0.6 introduces tiny canary live only after all previous gates pass.
6. v0.7 decides whether the strategy deserves continuation or scaling.

The main discipline is this:

```text
shadow edge is not executable edge
paper edge is not live edge
failed calibration means redesign the signal engine
```
