import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Pulse5 v0.1 initial schema — strictly the data-capture surface.
//
// The v0.1 mandate is "capture, store, and replay BTC 5-minute Up/Down
// market data". We deliberately do NOT create signals / orders /
// market_states tables here; v0.1 does no prediction, no signal generation,
// no paper trading, no live trading. Those tables land in their own
// migrations when v0.2 (signal engine) and v0.3 (execution simulator) start
// — keeping the schema minimal now means the code in this branch cannot
// accidentally write trading state.
//
// Tables created (all REQUIRED for replay):
//   - markets         : per-market metadata
//   - raw_events      : append-only audit log of every WS / REST payload
//   - book_snapshots  : normalized top-of-book per token
//   - btc_ticks       : normalized BTC price ticks from RTDS
//
// `book_snapshots.raw_event_id` and `btc_ticks.raw_event_id` are the
// linkage back to `raw_events.id` — see [packages/storage/src/*.repo.ts]
// for how the collector stamps them at insert time.
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

  // Indexes called out as critical for v0.1 query paths.
  pgm.sql(
    `CREATE INDEX idx_raw_events_source_type_receive_ts ON raw_events (source, event_type, receive_ts);`
  );
  pgm.sql(`CREATE INDEX idx_book_snapshots_market_ts ON book_snapshots (market_id, ts);`);
  pgm.sql(`CREATE INDEX idx_btc_ticks_source_ts ON btc_ticks (source, ts);`);
  pgm.sql(`CREATE INDEX idx_markets_end_time ON markets (end_time);`);
  pgm.sql(`CREATE INDEX idx_raw_events_market_receive_ts ON raw_events (market_id, receive_ts);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE IF EXISTS btc_ticks;`);
  pgm.sql(`DROP TABLE IF EXISTS book_snapshots;`);
  pgm.sql(`DROP TABLE IF EXISTS raw_events;`);
  pgm.sql(`DROP TABLE IF EXISTS markets;`);
}
