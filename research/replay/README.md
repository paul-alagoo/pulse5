# Pulse5 — Replay (v0.1 capture + v0.2 shadow signals)

This directory documents how to **rebuild a single BTC 5-minute Up/Down
market from stored data** without rerunning the live collector, and — under
v0.2 — how to score that rebuilt state with the shadow signal engine.

The collector persists four tables that together are sufficient to
reconstruct every market it observed:

| Table             | What it carries                                                       |
| ----------------- | --------------------------------------------------------------------- |
| `markets`         | Per-market metadata (event, slug, condition, up/down tokens, window). |
| `raw_events`      | Append-only audit log of every WS / REST payload, with `source_ts` and `receive_ts`. |
| `book_snapshots`  | Normalized top-of-book per token over time, keyed by `(ts, market_id, token_id)`. |
| `btc_ticks`       | Normalized BTC price ticks from RTDS Binance + Chainlink, keyed by `(ts, source, symbol)`. |

v0.2 adds two analytical tables on top — `market_states` and `signals` —
populated by the same pure logic the live collector uses (see §8 below).

The collector is **strictly read-only at the boundary**: it does not place
orders, sign transactions, or hold a wallet. Replay therefore only ever
reads from these tables. v0.2 keeps that contract — no orders, no wallet,
no signer, no paper trading.

## 0. Prerequisites

- `pnpm install` ran on the repo root.
- A reachable Postgres database with the v0.1 schema applied.
- Connection: both `pnpm db:migrate` and the runtime collector resolve a
  Postgres connection in this order: (1) `DATABASE_URL` from shell env,
  (2) `DATABASE_URL` in root `.env`, (3) the JSON file at
  `PULSE5_PG_CONFIG_PATH` (default `C:\postgres.json` on Windows). The
  password is never logged or printed by either path. See
  [`packages/storage/src/config.ts`](../../packages/storage/src/config.ts)
  for the runtime loader and
  [`scripts/run-migrate.mjs`](../../scripts/run-migrate.mjs) for the
  migration wrapper.

## 1. Find a target market

Pulse5 markets always look like `btc-updown-5m-{ts}` where `ts` is on a
300 s grid. To list resolved markets ordered by most recent:

```sql
SELECT market_id,
       slug,
       start_time,
       end_time,
       price_to_beat,
       status,
       final_outcome
  FROM markets
 ORDER BY end_time DESC
 LIMIT 50;
```

To pick a specific window:

```sql
SELECT *
  FROM markets
 WHERE slug = 'btc-updown-5m-1714000200';
```

## 2. Pull the raw event stream

Every CLOB and RTDS message is preserved in `raw_events`, ordered by
`receive_ts`. To replay everything that touched a market in chronological
order:

```sql
SELECT id,
       source,
       event_type,
       source_ts,
       receive_ts,
       token_id,
       raw
  FROM raw_events
 WHERE market_id = '<market_id>'
 ORDER BY receive_ts ASC;
```

RTDS price events are not market-scoped (`market_id IS NULL`). To pull
the BTC tape that overlaps a market window:

```sql
SELECT id, source, source_ts, receive_ts, raw
  FROM raw_events
 WHERE source IN ('rtds.binance', 'rtds.chainlink')
   AND receive_ts BETWEEN
         (SELECT start_time FROM markets WHERE market_id = '<market_id>')
     AND (SELECT end_time   FROM markets WHERE market_id = '<market_id>')
 ORDER BY receive_ts ASC;
```

## 3. Pull the normalized streams

The collector ingests WS payloads twice — once verbatim into
`raw_events`, once normalized into `book_snapshots` / `btc_ticks` — so
replay can choose between fidelity (raw) and convenience (normalized).

Normalized order book per token:

```sql
SELECT ts, receive_ts, token_id,
       best_bid, best_ask, bid_size, ask_size, spread
  FROM book_snapshots
 WHERE market_id = '<market_id>'
 ORDER BY ts ASC, token_id ASC;
```

Normalized BTC ticks within the market window:

```sql
SELECT ts, receive_ts, source, symbol, price, latency_ms
  FROM btc_ticks
 WHERE ts BETWEEN
         (SELECT start_time FROM markets WHERE market_id = '<market_id>')
     AND (SELECT end_time   FROM markets WHERE market_id = '<market_id>')
 ORDER BY ts ASC, source ASC;
```

## 4. Coverage checks

Before treating a market as "replay-ready", verify each pillar has data.

```sql
-- 1. Market metadata exists.
SELECT COUNT(*) AS market_rows
  FROM markets
 WHERE market_id = '<market_id>';

-- 2. CLOB raw events exist for both tokens.
SELECT token_id, COUNT(*) AS rows
  FROM raw_events
 WHERE market_id = '<market_id>'
   AND source = 'clob'
 GROUP BY token_id;

-- 3. Normalized book snapshots exist for both tokens.
SELECT token_id,
       COUNT(*)        AS snapshots,
       MIN(ts)         AS first_ts,
       MAX(ts)         AS last_ts
  FROM book_snapshots
 WHERE market_id = '<market_id>'
 GROUP BY token_id;

-- 4. BTC ticks during the market window from both RTDS sources.
SELECT source,
       COUNT(*) AS rows,
       AVG(latency_ms) AS avg_latency_ms
  FROM btc_ticks
 WHERE ts BETWEEN
         (SELECT start_time FROM markets WHERE market_id = '<market_id>')
     AND (SELECT end_time   FROM markets WHERE market_id = '<market_id>')
 GROUP BY source;
```

A market is replay-ready when:

- `market_rows = 1` and `up_token_id`, `down_token_id` are present.
- CLOB raw events exist for **both** Up and Down token IDs over the window.
- `book_snapshots` has at least one row per token covering ≥80% of the
  300 s window (every 5–10 s is typical).
- `btc_ticks` covers the window for **both** `rtds.binance` and
  `rtds.chainlink`.
- Optional: `markets.status = 'resolved'` once the v0.2 / settlement
  layer fills in `final_outcome`. (v0.1 leaves these unset; v0.1 also
  does not create `signals` / `orders` / `market_states` — those tables
  are added by the v0.2 / v0.3 migrations when those phases begin.)

## 5. 24-hour soak verification (manual gate)

The v0.1 acceptance criterion is "≥50 resolved BTC 5m markets reconstructable
from the database after a 24-hour collector run." Pulse5 cannot self-attest
this — it must be observed manually.

Run the collector for 24 hours, then:

```sql
-- How many full 5-minute windows did we cover?
SELECT COUNT(*) AS market_count
  FROM markets
 WHERE end_time < now()
   AND end_time > now() - interval '24 hours';

-- Of those, how many have BOTH tokens' CLOB raw events AND coverage from
-- both RTDS sources within their window?
WITH wnd AS (
  SELECT m.market_id, m.up_token_id, m.down_token_id, m.start_time, m.end_time
    FROM markets m
   WHERE m.end_time < now()
     AND m.end_time > now() - interval '24 hours'
),
clob_ok AS (
  SELECT w.market_id
    FROM wnd w
    JOIN raw_events r ON r.market_id = w.market_id
   WHERE r.source = 'clob'
   GROUP BY w.market_id, w.up_token_id, w.down_token_id
  HAVING COUNT(DISTINCT r.token_id) >= 2
),
rtds_ok AS (
  SELECT w.market_id
    FROM wnd w
    JOIN btc_ticks t
      ON t.ts BETWEEN w.start_time AND w.end_time
   WHERE t.source IN ('rtds.binance', 'rtds.chainlink')
   GROUP BY w.market_id
  HAVING COUNT(DISTINCT t.source) >= 2
)
SELECT COUNT(*) AS replay_ready_markets
  FROM clob_ok c
  JOIN rtds_ok r USING (market_id);
```

The `replay_ready_markets` count is the v0.1 success metric. Target:
`>= 50`.

## 6. Out of scope (v0.1)

- Replay does **not** simulate orders, fills, or PnL — that lands in v0.3.
- No wallet, no signing, no live or paper trading at any point.
- v0.2 layers a **shadow signal engine** on top of replay (see §8) but
  still does not trade.

## 8. v0.2 Shadow Signal Engine — replay flow

v0.2 adds three pure functions in [`packages/strategy`](../../packages/strategy):

- `buildMarketState({ market, upBook, downBook, chainlinkTick, binanceTick, … }, config)`
- `generateSignal(state, config)`
- `labelSignalOutcome({ signal, rawFinalOutcome, resolvedAt })`

In **this PR**, the replay path is the only consumer of these functions
that also writes to the `market_states` / `signals` tables. The collector
exposes `PULSE5_ENABLE_SHADOW_SIGNALS=1` as a marker-only flag — it logs
a single observation line and does **not** build state or generate
signals at runtime. Live periodic emission is deferred to a follow-up
PR, which will reuse the exact same pure functions exercised here, so
there will still be no separate replay-only engine when it lands.

### 8a. No-lookahead rule

Replay must construct each `MarketState` using **only data visible at the
target timestamp `t`**. Concretely:

- For `chainlinkTick` / `binanceTick`, query the latest tick with
  `receive_ts <= t`. **Do not** use `receive_ts` from the future.
- For `upBook` / `downBook`, query the latest `book_snapshots` row per
  token with `receive_ts <= t`. **Do not** use future snapshots.
- For the `price_to_beat` Chainlink fallback (§8b), the same `receive_ts
  <= t` filter applies — even though that query orders by `ts` proximity
  to `market.start_time`, candidate rows must have already been received
  at the replay target.
- The state builder and signal engine **never** read
  `markets.final_outcome` or `markets.status`. Those are only consulted by
  the outcome labeler, and only after the underlying market has resolved.

```sql
-- Latest BTC tick visible at timestamp t.
SELECT * FROM btc_ticks
 WHERE source = 'rtds.chainlink'
   AND receive_ts <= $1::timestamptz
 ORDER BY receive_ts DESC
 LIMIT 1;

-- Latest top-of-book per token visible at timestamp t.
SELECT * FROM book_snapshots
 WHERE market_id = $1 AND token_id = $2 AND receive_ts <= $3::timestamptz
 ORDER BY receive_ts DESC
 LIMIT 1;
```

### 8b. price_to_beat fallback

`markets.price_to_beat` is *not* always populated by v0.1's discovery
(gamma-api responses sometimes omit it). The state builder applies an
explicit fallback:

1. Prefer `market.priceToBeat` when present.
2. Otherwise, derive from the **Chainlink BTC tick nearest
   `market.startTime`** within
   `config.priceToBeatToleranceMs` (default 10 s) **whose `receive_ts <=
   targetTimestamp`** (the no-lookahead rule from §8a applies to the
   fallback query too — a tick emitted near `start_time` but received
   *after* the replay target is still in the future relative to the
   moment we are scoring and must NOT be used).
3. If neither is available, `dataComplete = false` and the engine rejects
   with `PRICE_TO_BEAT_MISSING`.

Documented as a **v0.2 fallback for shadow scoring**, not a tuned trading
assumption.

```sql
-- Chainlink tick nearest market.start_time, restricted to ticks already
-- received at timestamp t.
SELECT * FROM btc_ticks
 WHERE source = 'rtds.chainlink'
   AND receive_ts <= $2::timestamptz
 ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $1::timestamptz)))
 LIMIT 1;
```

### 8c. outcome vs. final_outcome

`signals` records two separate fields after labeling:

| Column           | What it is                                                |
| ---------------- | --------------------------------------------------------- |
| `final_outcome`  | Normalized market settlement snapshot (`UP` \| `DOWN`).   |
| `outcome`        | Signal scoring (`WIN` \| `LOSS` \| `NOT_APPLICABLE`).     |

Rules:

- Accepted `BUY_UP` wins iff `final_outcome = UP`.
- Accepted `BUY_DOWN` wins iff `final_outcome = DOWN`.
- Accepted losers get `LOSS`.
- Rejected signals always get `NOT_APPLICABLE` — they made no claim, so
  scoring is undefined. Their `final_outcome` is still recorded for
  analytics.

### 8d. A small example

[`replay-market.ts`](./replay-market.ts) walks one resolved market end to
end: pull v0.1 data, build a state, generate a shadow signal, label the
outcome, persist to v0.2 tables. It is intentionally minimal — not a batch
runner or dashboard.

## 7. Pointers to the implementation

- Discovery: [`packages/polymarket-v2/src/discovery-loop.ts`](../../packages/polymarket-v2/src/discovery-loop.ts)
- Discovery client: [`packages/polymarket-v2/src/discovery-client.ts`](../../packages/polymarket-v2/src/discovery-client.ts)
- CLOB WS wrapper: [`packages/polymarket-v2/src/market-ws.ts`](../../packages/polymarket-v2/src/market-ws.ts)
- RTDS client: [`packages/feeds/src/rtds-client.ts`](../../packages/feeds/src/rtds-client.ts)
- RTDS parser: [`packages/feeds/src/rtds-parser.ts`](../../packages/feeds/src/rtds-parser.ts)
- Storage repos: [`packages/storage/src`](../../packages/storage/src)
- Collector: [`apps/collector/src/collector.ts`](../../apps/collector/src/collector.ts)
- Schema migration: [`migrations/1714000000000_initial-schema.ts`](../../migrations/1714000000000_initial-schema.ts)
