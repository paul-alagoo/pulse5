import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Initial Pulse5 v0.1 schema.
// Source of truth: PULSE5_START.md section 10 (Database Schema Draft).
// README section 8 flags the first four tables as critical for v0.1 data capture;
// the remaining three (market_states, signals, orders) land in v0.2/v0.3 but the
// DDL is inexpensive so we create everything in the initial migration to avoid
// schema churn on the next phase.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  pgm.sql(`
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
  `);

  // Indexes called out in README section 7 (Phase 1 critical path).
  pgm.sql(
    `CREATE INDEX idx_raw_events_source_type_receive_ts ON raw_events (source, event_type, receive_ts);`
  );
  pgm.sql(`CREATE INDEX idx_book_snapshots_market_ts ON book_snapshots (market_id, ts);`);
  pgm.sql(`CREATE INDEX idx_btc_ticks_source_ts ON btc_ticks (source, ts);`);

  // Supporting indexes for common v0.1 query paths.
  pgm.sql(`CREATE INDEX idx_markets_end_time ON markets (end_time);`);
  pgm.sql(`CREATE INDEX idx_raw_events_market_receive_ts ON raw_events (market_id, receive_ts);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in reverse dependency order. No FKs are declared, but we still drop
  // leaves before trunks to keep the rollback readable.
  pgm.sql(`DROP TABLE IF EXISTS orders;`);
  pgm.sql(`DROP TABLE IF EXISTS signals;`);
  pgm.sql(`DROP TABLE IF EXISTS market_states;`);
  pgm.sql(`DROP TABLE IF EXISTS btc_ticks;`);
  pgm.sql(`DROP TABLE IF EXISTS book_snapshots;`);
  pgm.sql(`DROP TABLE IF EXISTS raw_events;`);
  pgm.sql(`DROP TABLE IF EXISTS markets;`);
}
