# Pulse5 — Polymarket BTC 5-Minute Trading System Starter Plan

## 0. Purpose

Pulse5 is a new, V2-first Polymarket micro-trading system focused only on:

```text
BTC Up/Down 5-Minute markets
```

The system is not a general Polymarket data warehouse.

The goal is to detect short-lived pricing inefficiencies where BTC price movement is already visible from faster feeds, but Polymarket odds have not fully adjusted.

Core hypothesis:

```text
BTC price / Chainlink proxy has already moved meaningfully away from the 5-minute opening price,
but Polymarket CLOB odds are temporarily lagging or mispriced.
```

The system must start as data-capture and replay infrastructure only.

No live trading in the first stage.

---

## 1. Current Strategic Decision

DataEngine is deprecated for this use case.

Reason:

- Polymarket is moving to CLOB V2.
- The old architecture is too broad and too slow for 5-minute BTC micro-markets.
- This project needs low-latency market discovery, WebSocket ingestion, replay, shadow signals, and later paper/live execution.
- The new system should be V2-first and purpose-built.

---

## 2. System Name

```text
Pulse5
```

---

## 3. Target Market

Only target:

```text
Polymarket BTC Up or Down - 5 Minutes
```

Resolution rule:

```text
If the final BTC/USD price is greater than or equal to the opening price, Up wins.
Otherwise, Down wins.
```

Resolution source:

```text
Chainlink BTC/USD data stream
```

---

## 4. High-Level Architecture

```text
Pulse5
├── pulse-discovery        # Discover active BTC 5m markets
├── pulse-feed             # Polymarket CLOB WebSocket + BTC exchange feeds
├── pulse-oracle           # Chainlink / BTC composite proxy
├── pulse-state            # Live state builder per market
├── pulse-signal           # Rule-based signal engine
├── pulse-risk             # Risk checks and kill switch
├── pulse-execution        # Paper/live execution later
├── pulse-replay           # Replay and backtest engine
├── pulse-settlement       # Market outcome reconciliation
└── pulse-dashboard        # Monitoring and reports
```

---

## 5. Technology Stack

Recommended initial stack:

| Layer | Technology |
|---|---|
| Runtime | TypeScript / Node.js |
| Package manager | pnpm |
| Polymarket integration | CLOB V2 SDK or V2-ready wrapper |
| Storage | PostgreSQL |
| Tick / replay export | Parquet / DuckDB later |
| Research | Python later |
| Dashboard | Grafana or lightweight web dashboard later |
| Deployment | Docker Compose |

Initial version should avoid:

- wallet integration
- live order placement
- ML model training
- over-engineered warehouse design
- generic market support

---

## 6. Repository Layout

```text
pulse5/
├── apps/
│   ├── collector/          # Market discovery + WebSocket ingestion
│   ├── engine/             # State builder + signal engine
│   ├── executor/           # Paper/live execution later
│   └── dashboard/          # Monitoring later
│
├── packages/
│   ├── polymarket-v2/      # Polymarket API / SDK wrapper
│   ├── feeds/              # Binance / Coinbase / Chainlink adapters
│   ├── models/             # Shared TypeScript types
│   ├── storage/            # PostgreSQL access layer
│   ├── strategy/           # Rule-based strategy logic
│   └── risk/               # Risk engine and kill switch
│
├── research/
│   ├── notebooks/
│   ├── replay/
│   └── reports/
│
├── migrations/
├── logs/
├── docker-compose.yml
├── README.md
├── .env.example
└── package.json
```

---

## 7. Development Stages

## Pulse5 v0.1 — V2 Data Capture Foundation

Goal:

```text
Build the minimum data-capture system.
No trading.
No wallet.
No order placement.
```

Scope:

- Create a fresh TypeScript monorepo.
- Add PostgreSQL schema migrations.
- Discover active BTC Up/Down 5-minute markets.
- Extract:
  - event ID
  - market ID
  - slug
  - question
  - condition ID
  - Up token ID
  - Down token ID
  - start time
  - end time
  - price to beat when available
  - resolution source
- Connect to Polymarket market WebSocket.
- Subscribe to Up and Down token IDs.
- Capture raw WebSocket events.
- Normalize:
  - best bid
  - best ask
  - spread
  - bid size
  - ask size
  - last trade price
- Capture BTC price feeds from at least:
  - Binance
  - Coinbase
- Persist all raw and normalized events.
- Add replay-friendly timestamps:
  - source timestamp
  - receive timestamp
  - ingest timestamp
- Add live endpoint smoke tests.
- Add README.md.

Out of scope:

- No trading.
- No wallet signing.
- No private key.
- No live order placement.
- No prediction model.
- No ML.
- No automated capital allocation.

Completion criteria:

```text
The collector can run for 24 hours and reconstruct each BTC 5m market state from stored data.
```

---

## Pulse5 v0.2 — Shadow Signal Engine

Goal:

```text
Generate trading signals without executing trades.
```

Scope:

- Build market state snapshots every 100–250ms.
- Calculate:
  - seconds remaining
  - BTC composite price
  - distance from price to beat
  - distance percentage
  - Up bid / ask
  - Down bid / ask
  - spread
  - short-term BTC returns
  - realized volatility
  - feed health
- Implement rule-based signal logic.
- Store every accepted and rejected signal.
- Include full decision reason.

No order simulation yet.

Completion criteria:

```text
At least 300 candidate signals are collected with full feature snapshots and final outcome labels.
```

---

## Pulse5 v0.3 — Paper Execution Simulator

Goal:

```text
Simulate limit orders realistically.
```

Scope:

- Simulate limit order placement.
- Simulate partial fills.
- Include spread.
- Include depth.
- Include latency.
- Include cancellation logic.
- Record simulated PnL.
- Replay historical data and reproduce decisions.

Completion criteria:

```text
Paper PnL can be replayed deterministically from stored events.
```

---

## Pulse5 v0.4 — Calibration

Goal:

```text
Validate whether the rule-based edge is real.
```

Scope:

- Produce win-rate bucket reports.
- Produce EV reports.
- Produce distance/time heatmaps.
- Produce slippage reports.
- Produce latency reports.
- Compare expected win rate against actual win rate.

Minimum gate:

```text
Signals with estimated p_win >= 0.80 must show actual win rate close to or above 0.80.
Net EV after spread, slippage, and latency must remain positive.
```

If this fails:

```text
Do not proceed to live trading.
```

---

## Pulse5 v0.5 — Canary Live

Goal:

```text
Run very small live trades only after paper validation passes.
```

Limits:

```text
max_position_per_market = bankroll * 0.25%
daily_max_loss = bankroll * 2%
daily_max_drawdown = bankroll * 3%
max_consecutive_losses = 4
```

Live trading must stop immediately if:

- Polymarket WebSocket is stale.
- BTC feed is stale.
- Chainlink/proxy feed is stale.
- local clock drift is too high.
- order confirmation times out.
- unexpected open position exists.
- API errors spike.
- daily loss limit is hit.
- consecutive loss limit is hit.

---

## 8. Core Strategy Rules

Initial rule-based system only.

### Up Candidate

```text
seconds_remaining between 12 and 60
distance_pct >= +0.08%
return_15s >= -0.02%
up_ask <= 0.78
up_spread <= 0.05
up_ask_depth >= min_size
btc_feed_fresh = true
clob_feed_fresh = true
oracle_or_proxy_valid = true
```

### Down Candidate

```text
seconds_remaining between 12 and 60
distance_pct <= -0.08%
return_15s <= +0.02%
down_ask <= 0.78
down_spread <= 0.05
down_ask_depth >= min_size
btc_feed_fresh = true
clob_feed_fresh = true
oracle_or_proxy_valid = true
```

### Reject Conditions

```text
seconds_remaining < 10
seconds_remaining > 90
abs(distance_pct) < 0.05%
ask > 0.82
spread > 0.05
orderbook depth too thin
BTC feeds disagree too much
Chainlink/proxy feed stale
Polymarket WebSocket stale
system clock drift too high
daily loss limit reached
```

Plain-language rule:

```text
Only buy the side that is already clearly ahead, near the end of the 5-minute window, and only if the market price is still cheap.
```

---

## 9. EV Formula

```text
EV = p_win * (1 - entry_price) - (1 - p_win) * entry_price
```

Initial trade gate:

```text
p_win >= 0.80
EV >= 0.05
entry_price <= 0.78
```

Example:

```text
p_win = 0.84
entry_price = 0.72

EV = 0.84 * 0.28 - 0.16 * 0.72
EV = 0.2352 - 0.1152
EV = 0.12
```

This is a valid candidate.

Counterexample:

```text
p_win = 0.80
entry_price = 0.90

EV = 0.80 * 0.10 - 0.20 * 0.90
EV = 0.08 - 0.18
EV = -0.10
```

High win rate but bad trade.

---

## 10. Database Schema Draft

### markets

```sql
CREATE TABLE markets (
    market_id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL,
    slug TEXT NOT NULL,
    question TEXT NOT NULL,
    condition_id TEXT,
    up_token_id TEXT NOT NULL,
    down_token_id TEXT NOT NULL,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    price_to_beat NUMERIC,
    resolution_source TEXT NOT NULL,
    status TEXT NOT NULL,
    final_outcome TEXT,
    discovered_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### raw_events

```sql
CREATE TABLE raw_events (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,
    event_type TEXT NOT NULL,
    source_ts TIMESTAMPTZ,
    receive_ts TIMESTAMPTZ NOT NULL,
    ingest_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    market_id TEXT,
    token_id TEXT,
    raw JSONB NOT NULL
);
```

### book_snapshots

```sql
CREATE TABLE book_snapshots (
    ts TIMESTAMPTZ NOT NULL,
    receive_ts TIMESTAMPTZ NOT NULL,
    market_id TEXT NOT NULL,
    token_id TEXT NOT NULL,
    best_bid NUMERIC,
    best_ask NUMERIC,
    bid_size NUMERIC,
    ask_size NUMERIC,
    spread NUMERIC,
    raw_event_id BIGINT,
    PRIMARY KEY (ts, market_id, token_id)
);
```

### btc_ticks

```sql
CREATE TABLE btc_ticks (
    ts TIMESTAMPTZ NOT NULL,
    receive_ts TIMESTAMPTZ NOT NULL,
    source TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price NUMERIC NOT NULL,
    latency_ms INTEGER,
    raw_event_id BIGINT,
    PRIMARY KEY (ts, source, symbol)
);
```

### market_states

```sql
CREATE TABLE market_states (
    ts TIMESTAMPTZ NOT NULL,
    market_id TEXT NOT NULL,
    seconds_remaining INTEGER NOT NULL,

    price_to_beat NUMERIC,
    btc_composite NUMERIC,
    chainlink_price NUMERIC,
    distance_pct NUMERIC,

    up_bid NUMERIC,
    up_ask NUMERIC,
    down_bid NUMERIC,
    down_ask NUMERIC,
    up_spread NUMERIC,
    down_spread NUMERIC,

    return_5s NUMERIC,
    return_15s NUMERIC,
    return_30s NUMERIC,
    realized_vol_30s NUMERIC,

    feed_health JSONB NOT NULL,

    PRIMARY KEY (ts, market_id)
);
```

### signals

```sql
CREATE TABLE signals (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,

    p_win NUMERIC,
    fair_price NUMERIC,
    entry_cap NUMERIC,
    best_ask NUMERIC,
    ev NUMERIC,

    decision TEXT NOT NULL,
    reject_reason TEXT,
    features JSONB NOT NULL
);
```

### orders

```sql
CREATE TABLE orders (
    id BIGSERIAL PRIMARY KEY,
    ts TIMESTAMPTZ NOT NULL,
    mode TEXT NOT NULL,
    market_id TEXT NOT NULL,
    side TEXT NOT NULL,
    token_id TEXT NOT NULL,

    limit_price NUMERIC NOT NULL,
    size NUMERIC NOT NULL,
    status TEXT NOT NULL,

    filled_price NUMERIC,
    filled_size NUMERIC,
    exchange_order_id TEXT,
    cancel_reason TEXT,

    final_outcome TEXT,
    pnl NUMERIC,
    raw JSONB
);
```

---

## 11. v0.1 Implementation Prompt

Use this prompt to start implementation.

```text
You are implementing Pulse5 v0.1 from scratch.

Pulse5 is a V2-first Polymarket BTC 5-minute Up/Down data-capture system.

The goal of v0.1 is data capture only.

Do not implement trading.
Do not place orders.
Do not require a wallet.
Do not add private-key handling.
Do not implement ML.
Do not implement live execution.
Do not build a generic Polymarket warehouse.

Branch policy:
- Create a new non-main branch before starting.
- Branch name: feature/pulse5-v0.1-data-capture
- Do not work directly on main.
- Commit and push to the remote feature branch after completion.

Technology:
- TypeScript / Node.js.
- pnpm monorepo.
- PostgreSQL for storage.
- Docker Compose for local PostgreSQL.
- Use Polymarket CLOB V2 SDK if available; otherwise create a V2-ready wrapper with isolated API boundaries.
- Use public market-data endpoints only.
- Use live public endpoint smoke tests.

Required repository structure:

pulse5/
├── apps/
│   ├── collector/
│   ├── engine/
│   ├── executor/
│   └── dashboard/
├── packages/
│   ├── polymarket-v2/
│   ├── feeds/
│   ├── models/
│   ├── storage/
│   ├── strategy/
│   └── risk/
├── research/
│   ├── notebooks/
│   ├── replay/
│   └── reports/
├── migrations/
├── logs/
├── docker-compose.yml
├── README.md
├── .env.example
└── package.json

v0.1 required scope:

1. Project bootstrap
- Initialize a TypeScript pnpm monorepo.
- Add lint, format, typecheck, test scripts.
- Add Docker Compose PostgreSQL.
- Add .env.example.
- Add README.md.

2. Database migrations
Create migrations for:
- markets
- raw_events
- book_snapshots
- btc_ticks
- market_states
- signals
- orders

The schema must be replay-friendly.
Every raw event must preserve:
- source
- event_type
- source_ts when available
- receive_ts
- ingest_ts
- market_id when available
- token_id when available
- raw JSON payload

3. Polymarket discovery
Implement active BTC 5-minute market discovery.

The collector must:
- find active BTC Up/Down 5-minute markets
- extract event ID
- extract market ID
- extract slug
- extract question
- extract condition ID when available
- extract Up token ID
- extract Down token ID
- extract start time
- extract end time
- extract price to beat when available
- extract resolution source
- persist discovered markets

Discovery logic must be isolated in packages/polymarket-v2.

4. Polymarket market WebSocket ingestion
Implement public market WebSocket ingestion for discovered Up/Down token IDs.

Capture raw events for:
- book
- price_change
- best_bid_ask when available
- last_trade_price when available
- market_resolved when available
- any unknown event type as raw_events without crashing

Normalize best bid / best ask / spread / visible size into book_snapshots where possible.

5. BTC price feeds
Implement at least two public BTC price feed adapters:
- Binance BTCUSDT
- Coinbase BTC-USD

Each adapter must:
- connect to public WebSocket or public streaming endpoint
- persist raw events
- persist normalized btc_ticks
- include receive timestamp
- include source timestamp when available
- include latency estimate when possible

6. Runtime commands
Add commands:
- pnpm dev:collector
- pnpm db:migrate
- pnpm db:reset
- pnpm test
- pnpm typecheck
- pnpm lint

7. Health and logging
Collector must log:
- discovered markets
- subscribed token IDs
- WebSocket connection status
- reconnects
- stale feed warnings
- number of raw events persisted
- number of normalized snapshots persisted

8. Tests
Add unit tests for:
- market discovery parsing
- token ID extraction
- WebSocket event normalization
- BTC tick normalization
- database insert mapping

Add at least one live smoke test using public endpoints.
The live smoke test must be clearly marked and documented.

Do not mock the entire system as a substitute for live validation.

9. Documentation
README.md must be English only.

README.md must include:
- project purpose
- v0.1 scope
- explicit non-goals
- setup
- environment variables
- database setup
- run commands
- live smoke test instructions
- current limitations
- safety statement: v0.1 does not trade, does not place orders, and does not require a wallet

10. Final validation
Run and report:
- pnpm install
- pnpm typecheck
- pnpm lint
- pnpm test
- database migration test
- live public endpoint smoke test

Final response must include:
- branch name
- files created
- commands run
- tests passed / failed
- live endpoint validation result
- known limitations
- whether anything could not be completed

Important:
- Do not overbuild.
- Do not implement trading.
- Do not add wallet support.
- Do not introduce private-key handling.
- Do not hide failed tests.
- Do not claim V2 compatibility unless the implementation boundary is actually V2-ready.
```

---

## 12. v0.1 Success Criteria

Pulse5 v0.1 is successful only if:

```text
The system can run continuously,
discover BTC 5-minute markets,
subscribe to their token IDs,
capture Polymarket market events,
capture BTC exchange ticks,
persist raw and normalized data,
and allow later replay.
```

It is not required to make money in v0.1.

It is not required to predict outcomes in v0.1.

It is not allowed to trade in v0.1.

---

## 13. Plain-Language Summary

Pulse5 starts as a recorder, not a trader.

First prove that the system can see the market correctly.

Then prove that the signals would have worked.

Then prove that simulated execution survives spread, slippage, and latency.

Only after that should tiny live trading be considered.
