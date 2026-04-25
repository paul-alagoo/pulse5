# Pulse5

Polymarket BTC 5-minute Up/Down **data-capture system**. V2-first.

This README is the **actionable implementation plan** for Pulse5 v0.1.
For the full rationale, strategy rules, EV formula, and long-term roadmap, see [PULSE5_START.md](PULSE5_START.md).

---

## 1. Status

**Phase 0 (monorepo bootstrap) complete.** Schema migrations and the test pipeline are wired up. Phases 1–5 (discovery, CLOB WS, RTDS, collector) are the next implementation targets.

No trading. No wallet. No private key. No live order placement.

---

## 2. Non-goals for v0.1

- No trading of any kind (paper or live).
- No wallet signing / private-key handling.
- No machine-learning models.
- No generic Polymarket warehouse — BTC 5m Up/Down only.
- No dashboard (logs + SQL queries are sufficient at this stage).
- No direct Coinbase / Chainlink-on-chain integration (deferred to v0.1.1 cross-check).

---

## 3. Research outcome

A full research pass against GitHub, Polymarket docs, and prior-art trading bots established three decisions that shape this plan:

### 3.1 Polymarket CLOB V2 is public and ready

| Need | Chosen solution |
|---|---|
| REST / future order placement | [`@polymarket/clob-client-v2`](https://github.com/Polymarket/clob-client-v2) v1.0.2 (viem-based) |
| Market WebSocket | `wss://ws-subscriptions-clob.polymarket.com/ws/market` — **public, no auth** |
| WS wrapper with reconnect | [`@nevuamarkets/poly-websockets`](https://github.com/nevuamarkets/poly-websockets) (MIT) |

The `custom_feature_enabled: true` subscription flag activates `best_bid_ask`, `new_market`, and `market_resolved` events — adopted so resolution can be captured passively instead of polled.

### 3.2 Polymarket RTDS replaces three adapters

Polymarket operates a real-time data socket at `wss://ws-live-data.polymarket.com` (public, no auth, PING every 5 s) that publishes:

| Topic | Payload | Replaces |
|---|---|---|
| `crypto_prices` filter `btcusdt` | Binance spot price | Our planned Binance adapter |
| `crypto_prices_chainlink` filter `btc/usd` | **The exact Chainlink price Polymarket uses to resolve** | Our planned Coinbase + Chainlink-on-chain adapters |

Official TS client: [`@polymarket/real-time-data-client`](https://github.com/Polymarket/real-time-data-client). One socket now gives us both the reference market price and the oracle-truth price with identical semantics to resolution. This is the single most impactful deviation from [PULSE5_START.md](PULSE5_START.md).

### 3.3 Market discovery is deterministic

Every BTC 5-minute market has slug `btc-updown-5m-{ts}` where `ts` is a Unix timestamp divisible by 300. A single `GET https://gamma-api.polymarket.com/events?slug={slug}` returns the event, its markets, token IDs, and price-to-beat. No scanning loop needed.

### 3.4 Deviations from [PULSE5_START.md](PULSE5_START.md)

| Area | Original plan | v0.1 plan |
|---|---|---|
| BTC price feeds | Custom Binance + Coinbase adapters | Single `packages/feeds` subscribing to RTDS `crypto_prices` + `crypto_prices_chainlink`. Coinbase deferred to v0.1.1 as optional cross-check. |
| Chainlink price | Custom on-chain RPC reader (`AggregatorV3Interface`) | RTDS `crypto_prices_chainlink` — matches resolution semantics exactly. |
| Market discovery | "Find active BTC Up/Down 5-minute markets" | Deterministic slug lookup every 300 s + CLOB `new_market` event as backup. |
| CLOB WS client | Roll our own | Wrap [`@nevuamarkets/poly-websockets`](https://github.com/nevuamarkets/poly-websockets) inside `packages/polymarket-v2`. |

Everything else in [PULSE5_START.md](PULSE5_START.md) (schema, strategy rules, risk limits, success criteria) is unchanged.

---

## 4. Architecture

```text
                  ┌──────────────────────────────┐
                  │ Polymarket Gamma REST        │
                  │ gamma-api.polymarket.com     │
                  └──────────────┬───────────────┘
                                 │ slug lookup every 300 s
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│ apps/collector                                                   │
│                                                                  │
│ ┌─────────────────┐  ┌─────────────────┐  ┌──────────────────┐   │
│ │ discovery-loop  │  │ ingest-clob     │  │ ingest-rtds      │   │
│ │ (slug + gamma)  │  │ (@nevuamarkets/ │  │ (@polymarket/    │   │
│ │                 │  │  poly-websockets)│ │  real-time-data) │   │
│ └────────┬────────┘  └────────┬────────┘  └─────────┬────────┘   │
│          │                    │                     │            │
│          └────────────────────┼─────────────────────┘            │
│                               ▼                                  │
│                       packages/storage                           │
│                     (raw + normalized inserts)                   │
└───────────────────────────────┬──────────────────────────────────┘
                                ▼
                     ┌──────────────────┐
                     │ PostgreSQL       │
                     │ (Docker Compose) │
                     └──────────────────┘
```

---

## 5. Tech stack

| Layer | Choice |
|---|---|
| Runtime | Node.js 20+, TypeScript 5.x |
| Package manager | pnpm workspaces (monorepo) |
| Polymarket REST | `@polymarket/clob-client-v2` |
| Polymarket CLOB WS | `@nevuamarkets/poly-websockets` |
| Polymarket RTDS | `@polymarket/real-time-data-client` |
| Wallet lib (peer of clob-client-v2) | `viem` |
| DB | PostgreSQL 16 via Docker Compose |
| DB client | `pg` (node-postgres) |
| DB migrations | `node-pg-migrate` (v8, TS migration files; transactional, up/down, tracking table) |
| Env loading | `dotenv` (for db:migrate root `.env` resolution) |
| Validation | `zod` (resolved to v4) |
| Logging | `pino` |
| Tests | `vitest` + a marked live-smoke suite |
| Lint / format | `eslint` + `prettier` |

---

## 6. Target repository layout

```text
pulse5/
├── apps/
│   ├── collector/              # v0.1 — discovery + WS ingestion + persist
│   ├── engine/                 # v0.2 — state builder + signal engine
│   ├── executor/               # v0.3+ — paper/live execution
│   └── dashboard/              # later
├── packages/
│   ├── polymarket-v2/          # V2 SDK boundary (REST discovery + CLOB WS wrapper)
│   │   └── src/
│   │       ├── discovery.ts    # deterministic slug + gamma-api
│   │       ├── market-ws.ts    # wraps @nevuamarkets/poly-websockets
│   │       └── types.ts
│   ├── feeds/                  # price-feed adapters
│   │   └── src/
│   │       ├── rtds.ts         # @polymarket/real-time-data-client
│   │       └── types.ts
│   ├── models/                 # shared TS types (Market, BookSnapshot, Tick, ...)
│   ├── storage/                # Postgres access layer (repository pattern)
│   │   └── src/
│   │       ├── client.ts
│   │       ├── markets.repo.ts
│   │       ├── raw-events.repo.ts
│   │       ├── book-snapshots.repo.ts
│   │       └── btc-ticks.repo.ts
│   ├── strategy/               # v0.2 — rule-based signals
│   └── risk/                   # v0.3+ — kill switch
├── migrations/                 # TypeScript node-pg-migrate files, applied in order
├── research/
│   ├── notebooks/
│   ├── replay/
│   └── reports/
├── logs/
├── docker-compose.yml
├── README.md                   # ← this file
├── PULSE5_START.md             # original starter plan (reference)
├── .env.example
├── package.json
└── pnpm-workspace.yaml
```

---

## 7. v0.1 implementation plan

Branch: **`feature/pulse5-v0.1-data-capture`** (create before any code; never commit to `main`).

All phases use TDD: write unit tests first, make them pass, refactor. Target 80% coverage per package. Live smoke tests are the authoritative gate — unit tests alone are **not** sufficient.

### Phase 0 — Monorepo bootstrap
- [x] Initialize pnpm workspace, `tsconfig.base.json`, shared `eslint` + `prettier`.
- [x] `docker-compose.yml` with Postgres 16 + persistent volume.
- [x] `.env.example` listing every variable from §9.
- [x] Root scripts: `dev:collector`, `db:up`, `db:wait`, `db:migrate`, `db:reset`, `test`, `test:smoke`, `typecheck`, `lint`.
- [x] Decision log entry: **`pg` (node-postgres) + `node-pg-migrate`** — recorded in §5.
- [x] **Acceptance:** `pnpm install && pnpm typecheck && pnpm lint` all green on empty skeleton.

### Phase 1 — Database migrations
Status legend: **[x]** = implemented & verified, **[~]** = implemented but unverified end-to-end, **[ ]** = not implemented.

- [x] TypeScript `node-pg-migrate` migration file for every table: `markets`, `raw_events`, `book_snapshots`, `btc_ticks`, `market_states`, `signals`, `orders`. Schemas are defined in [PULSE5_START.md §10](PULSE5_START.md). _(Single initial migration `migrations/1714000000000_initial-schema.ts`.)_
- [x] Add indexes in the migration: `raw_events(source, event_type, receive_ts)`, `book_snapshots(market_id, ts)`, `btc_ticks(source, ts)`, plus `markets(end_time)` and `raw_events(market_id, receive_ts)`.
- [x] `pnpm db:migrate` / `pnpm db:reset` scripts wired with fail-closed behaviour: missing/unreachable `DATABASE_URL` exits non-zero, and `pnpm db:wait` exits fast (code 4) when the Docker daemon is unreachable instead of busy-waiting through the full timeout.
- [x] **Live happy-path verified.** `pnpm db:reset` runs end-to-end on Docker Desktop: volume drop → fresh Postgres 16 → `db:wait` reports healthy in ~5 s → `node-pg-migrate` creates all 7 schema tables + 5 indexes + records the migration in `pgmigrations`. The two environment gotchas that bit us during the first verification run are now caught at the seam by `scripts/db-preflight.mjs` (run automatically before every migrate up/down): (1) any shell-exported `DATABASE_URL` that disagrees with root `.env` aborts with a redacted host/port/db diff before node-pg-migrate ever connects; (2) `PULSE5_PG_HOST_PORT` and the port inside `DATABASE_URL` must match on local hosts, otherwise migrations would land on a different cluster than `pnpm db:up` started. Both behaviours are documented below in §10 along with the `PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1` escape hatch for CI / direnv setups.
- [ ] Unit test: repository insert round-trip for each table. _(Repositories not yet implemented — lands with Phase 1 consumers.)_
- [ ] **Acceptance:** schema creates from scratch on empty DB; all repo round-trip tests pass. _(Live DB happy-path is verified and the migration schema builds from a fresh DB; the remaining blocker is the repository layer plus insert round-trip tests for each table.)_

### Phase 2 — Market discovery (`packages/polymarket-v2/discovery.ts`)
- [ ] `nextWindowTimestamp(now)` — floor to nearest 300 s boundary; unit-tested with fixed clock.
- [ ] `discoverByWindow(ts)` — fetches `GET gamma-api.polymarket.com/events?slug=btc-updown-5m-{ts}`, validates with `zod`, returns `Market` model with event_id, market_id, slug, question, condition_id, up_token_id, down_token_id, start_time, end_time, resolution_source. (gamma-api does NOT expose `price_to_beat` for these markets; it is captured separately as the Chainlink BTC/USD reading at the market's `start_time` and persisted by the collector via RTDS in Phase 4.)
- [ ] Upserts into `markets` table.
- [ ] Handles 404 (window not yet created) with backoff; logs but does not crash.
- [ ] Unit tests with recorded Gamma fixtures (golden JSON).
- [ ] Live smoke: hit the real endpoint for the current window, assert shape.
- [ ] **Acceptance:** running the discovery loop for 15 minutes populates ≥3 markets with valid token IDs.

### Phase 3 — CLOB market WebSocket ingestion (`packages/polymarket-v2/market-ws.ts` + `apps/collector/ingest-clob.ts`)
- [ ] Wrap `@nevuamarkets/poly-websockets` with `custom_feature_enabled: true`.
- [ ] Handlers persist **raw** payloads to `raw_events` (always) AND normalize to `book_snapshots` for `book` and `best_bid_ask` events.
- [ ] Every event carries `source_ts` (from payload) and `receive_ts` (from `Date.now()`).
- [ ] Subscribe on discovery; unsubscribe on `market_resolved` (mark `markets.status='resolved'`, `final_outcome`).
- [ ] Unknown event types are stored as `raw_events` without crashing.
- [ ] Log reconnect events; expose a `healthcheck()` returning last-event-age per token.
- [ ] Unit tests: normalization functions with recorded fixtures for each event type.
- [ ] Live smoke: subscribe to one real BTC 5m market, verify ≥1 book + ≥1 price_change received within 30 s.
- [ ] **Acceptance:** 5-minute live run on one market produces coherent raw + normalized rows; reconnect survives a manual disconnect.

### Phase 4 — RTDS price ingestion (`packages/feeds/rtds.ts` + `apps/collector/ingest-rtds.ts`)
- [ ] Single client subscribing to two subscriptions: `crypto_prices` (`btcusdt`) and `crypto_prices_chainlink` (`btc/usd`).
- [ ] PING every 5 s per docs; auto-reconnect on drop.
- [ ] Persist raw payloads to `raw_events` (`source='rtds.binance'` or `source='rtds.chainlink'`).
- [ ] Normalize to `btc_ticks` with payload `timestamp` as `source_ts`, local receive time as `receive_ts`, and `latency_ms = receive_ts - source_ts`.
- [ ] Unit tests: payload → tick normalization for both topics.
- [ ] Live smoke: connect for 60 s, assert ≥10 ticks per source.
- [ ] **Acceptance:** 5-minute live run produces both sources at expected cadence; latency histogram logged.

### Phase 5 — Collector app wiring + health logging (`apps/collector`)
- [ ] Entrypoint wires: discovery-loop → CLOB WS subscription manager → RTDS client → storage repos.
- [ ] `pino` structured logs with required fields: `component`, `market_id`, `token_id`, `event_type`, `source_ts`, `receive_ts`, `latency_ms`.
- [ ] Periodic (every 30 s) health line: counts of raw/normalized events written, per-source last-event age, active subscriptions.
- [ ] Graceful shutdown: close WS, flush DB, exit non-zero on fatal.
- [ ] **Acceptance:** `pnpm dev:collector` runs continuously, survives manual WS disconnect, logs health every 30 s.

### Phase 6 — Tests, smoke, and docs
- [x] Vitest coverage ≥80% per file (strict superset of per-package). _(Enforced via `vitest.config.ts` `coverage.thresholds.perFile: true`; a heavily-tested file in one package can no longer mask a near-zero file in another. Smoke coverage is expected to grow alongside CLOB/RTDS ingestion work in Phases 3–4, and can be skipped offline with `pnpm test:smoke:offline` (which auto-injects `PULSE5_SKIP_SMOKE_NETWORK=1`).)_
- [x] `vitest.smoke.config.ts` exists, at least one smoke test, opt-out env flag documented. _(Live smoke probe of gamma-api in `packages/polymarket-v2/src/discovery.smoke.test.ts`; walks recent 5-minute window slugs and requires HTTP 200 plus a payload that parses into a slug-matched BTC Up/Down event with two distinct up/down token IDs on at least one window. 404, empty array, and token-shape-wrong payloads are rejected. **Note:** smoke does NOT assert a numeric `price_to_beat` because gamma-api does not expose one for these markets — resolution compares end-of-window BTC vs start-of-window BTC, and the collector captures the start-of-window Chainlink reading from RTDS at runtime (Phase 4). The parser still supports a `requirePriceToBeat` strict option exercised by unit tests in `discovery.test.ts` for callers that need it. Skip the live probe with `pnpm test:smoke:offline` (the config auto-injects `PULSE5_SKIP_SMOKE_NETWORK=1`).)_
- [x] Expand README §10 (Setup & run) with exact commands actually used.
- [ ] Add `research/replay/` README describing how to rebuild a market from `raw_events`.
- [ ] **Acceptance:** `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm test:smoke` all green; a 24-hour collector run (manual) reconstructs ≥50 resolved markets from stored data.

---

## 8. Database schema

Authoritative definitions live in [PULSE5_START.md §10](PULSE5_START.md). Quick reference:

| Table | Purpose | Primary key |
|---|---|---|
| `markets` | One row per discovered BTC 5m market | `market_id` |
| `raw_events` | Append-only audit log of every WS/REST payload | `id` (BIGSERIAL) |
| `book_snapshots` | Normalized top-of-book per token over time | `(ts, market_id, token_id)` |
| `btc_ticks` | Normalized BTC price ticks from RTDS | `(ts, source, symbol)` |
| `market_states` | v0.2 — 100–250 ms feature snapshots | `(ts, market_id)` |
| `signals` | v0.2 — accepted + rejected signal decisions | `id` |
| `orders` | v0.3+ — paper/live order lifecycle | `id` |

Every raw event must preserve: `source`, `event_type`, `source_ts` (when provided), `receive_ts`, `ingest_ts`, `market_id` (when applicable), `token_id` (when applicable), and the full raw JSON.

---

## 9. Environment variables

Copy `.env.example` → `.env` before running.
Root `.env` is the single source of truth; `pnpm db:migrate` reads it automatically via `dotenv`.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgres://pulse5:pulse5@localhost:5432/pulse5` | Postgres connection string (root `.env`; read by `pnpm db:migrate`) |
| `POLYMARKET_GAMMA_API_URL` | `https://gamma-api.polymarket.com` | Discovery REST endpoint |
| `POLYMARKET_CLOB_WS_URL` | `wss://ws-subscriptions-clob.polymarket.com/ws/market` | CLOB market channel |
| `POLYMARKET_RTDS_WS_URL` | `wss://ws-live-data.polymarket.com` | Real-time data socket |
| `POLYMARKET_RTDS_SPONSOR_KEY` | *(empty)* | Optional — Polymarket-issued key for RTDS Chainlink prod quota |
| `LOG_LEVEL` | `info` | `pino` log level |
| `DISCOVERY_INTERVAL_MS` | `5000` | How often to attempt slug lookup for the upcoming window |
| `HEALTH_LOG_INTERVAL_MS` | `30000` | Periodic collector health line cadence |

---

## 10. Setup & run

```bash
# Prereqs: Node 20+, pnpm 9+, Docker Desktop running.
# Two gotchas worth knowing up front. Both are now enforced by
# `scripts/db-preflight.mjs`, which runs before every db:migrate up/down
# and aborts before any DB connection is opened:
#   1. If your shell already exports DATABASE_URL (some teams set this
#      globally), node-pg-migrate WILL use that and not the project .env —
#      `dotenv` does not override existing env vars. The preflight fails
#      fast on this case and prints a redacted host/port/db diff between
#      the shell value and the root `.env` value. Fix by `unset
#      DATABASE_URL` in this shell, or — for CI / direnv / advanced
#      overrides — set `PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1` to bypass
#      the check.
#   2. If your machine already runs Postgres on host 5432 (common on
#      Windows / macOS), the docker container is shadowed. Set
#      `PULSE5_PG_HOST_PORT=5433` in `.env` AND update DATABASE_URL's
#      port to match; docker-compose.yml respects the override. The
#      preflight enforces port equality on local hosts (localhost /
#      127.0.0.1 / ::1) so the two values cannot drift silently.

git checkout -b feature/pulse5-v0.1-data-capture

pnpm install
cp .env.example .env
# Edit .env if 5432 is already in use locally: change PULSE5_PG_HOST_PORT
# and DATABASE_URL's port together.

pnpm db:up             # starts Postgres 16 in Docker
pnpm db:wait           # blocks until the postgres container reports `healthy` via
                       # docker inspect; cross-platform (Windows/PowerShell-safe).
                       # Fails fast (exit 4) if the Docker daemon is unreachable,
                       # so a stopped Docker Desktop does not waste the full timeout.
                       # Exits non-zero on timeout (default 60 s, configurable via
                       # PULSE5_PG_WAIT_TIMEOUT_MS).
pnpm db:migrate        # runs scripts/db-preflight.mjs (shell-vs-.env DATABASE_URL diff
                       # + PULSE5_PG_HOST_PORT/DATABASE_URL port-equality checks on
                       # local hosts; never prints credentials), then applies
                       # node-pg-migrate TS migrations via tsx (--tsx flag, v8). Exits
                       # non-zero on preflight failure or missing/unreachable DB.
                       # Set PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1 only for deliberate
                       # CI / direnv overrides.

# Or, in one shot — drops the volume, starts Postgres, waits for healthy,
# then migrates from scratch:
pnpm db:reset          # docker compose down -v && up -d postgres && db:wait && db:migrate

pnpm typecheck
pnpm lint
pnpm build             # produces dist/ in every workspace package

pnpm test              # unit tests + 80% coverage gate, enforced PER FILE (a
                       # heavily-tested file cannot mask a near-zero file).
pnpm test:smoke        # live smoke gate; hits real Polymarket endpoints (network required).
                       # The probe walks recent 5-minute window slugs and requires at
                       # least one HTTP 200 whose body parses into a slug-matched BTC
                       # Up/Down event with two distinct up/down token IDs. 404, empty
                       # array, and token-shape-wrong payloads all fail the gate.
                       # NOTE: gamma-api does not expose price_to_beat for these
                       # markets — that is captured at runtime from Chainlink/RTDS in
                       # Phase 4. The strict-mode parser flag is exercised by unit
                       # tests, not by smoke.
pnpm test:smoke:offline # smoke tests offline; PULSE5_SKIP_SMOKE_NETWORK=1 auto-injected (NOT a release gate)

pnpm dev:collector     # (Phases 3–5) runs the collector — currently a skeleton stub
```

---

## 11. v0.1 success criteria

Pulse5 v0.1 is successful only if:

> The system runs continuously, discovers BTC 5-minute markets deterministically, subscribes to their token IDs on the CLOB WS with `custom_feature_enabled`, captures Polymarket market events, captures BTC RTDS ticks (Binance-source + Chainlink-oracle), persists both raw and normalized data with replay-friendly timestamps, and allows later replay.

It is **not** required to make money, predict outcomes, or place any order in v0.1.

---

## 12. Future roadmap (one-liners)

- **v0.2 — Shadow Signal Engine:** 100–250 ms `market_states` + rule-based `signals` with full feature snapshots and outcome labels.
- **v0.3 — Paper Execution Simulator:** realistic limit-order simulation (spread, depth, latency, cancels, 5-share minimum).
- **v0.4 — Calibration:** win-rate buckets, EV reports, slippage, distance/time heatmaps. Hard gate: `p_win ≥ 0.80` signals must realize ≥0.80 actual win rate with positive net EV.
- **v0.5 — Canary Live:** very small live trades only after v0.4 passes. Strict kill switches (see [PULSE5_START.md §7](PULSE5_START.md)).

---

## 13. Safety statement

Pulse5 v0.1 **does not trade, does not place orders, and does not require a wallet.** Every deviation that could affect that guarantee must be called out in a PR description and require explicit approval before merging.

---

## 14. References

- [Polymarket CLOB V2 client](https://github.com/Polymarket/clob-client-v2)
- [Polymarket Market Channel docs](https://docs.polymarket.com/developers/CLOB/websocket/market-channel)
- [Polymarket Real-Time Data Socket — crypto prices](https://docs.polymarket.com/developers/RTDS/RTDS-crypto-prices)
- [Polymarket Real-Time Data Client (TS)](https://github.com/Polymarket/real-time-data-client)
- [nevuamarkets/poly-websockets](https://github.com/nevuamarkets/poly-websockets)
- [Polymarket Gamma API — Get Events](https://docs.polymarket.com/developers/gamma-markets-api/get-events)
- [PULSE5_START.md](PULSE5_START.md) — original starter plan (schema, strategy rules, EV, risk limits)
