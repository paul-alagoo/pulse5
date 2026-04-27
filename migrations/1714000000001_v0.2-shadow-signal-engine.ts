import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Pulse5 v0.2 — Shadow Signal Engine schema.
//
// v0.2 OBSERVES, rebuilds market state from v0.1 capture data, generates a
// shadow decision, records rejection reasons, and labels outcomes after the
// market resolves. v0.2 explicitly does NOT trade, paper-trade, simulate
// orders, or hold a wallet — that contract is enforced at the schema layer
// here by introducing exactly two analytical tables (`market_states`,
// `signals`) and ZERO order / wallet / execution tables.
//
// The two tables, at a glance:
//   - market_states : per-tick numeric snapshot of everything the engine
//                     needs to make ONE decision. Pure observation.
//   - signals       : the engine's decision (BUY_UP | BUY_DOWN | REJECT)
//                     plus its features and post-resolution outcome label.
//
// `decision` and `accepted` are intentionally redundant: `accepted = true`
// iff `decision IN ('BUY_UP', 'BUY_DOWN')`. We persist both because the
// hot analytic queries are "show me all rejected signals filtered by date"
// (uses `accepted`) and "show me everything that decided BUY_DOWN"
// (uses `decision`); a CHECK keeps them consistent.
//
// `final_outcome` (UP|DOWN) is the *market settlement snapshot* copied
// from `markets.final_outcome` at label time. `outcome`
// (WIN|LOSS|NOT_APPLICABLE) is the *signal scoring* result. They answer
// different questions and are kept on separate columns on purpose.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE market_states (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      market_id TEXT NOT NULL,
      btc_price NUMERIC,
      btc_source TEXT,
      price_to_beat NUMERIC,
      distance NUMERIC,
      distance_bps NUMERIC,
      time_remaining_ms INTEGER,
      up_best_bid NUMERIC,
      up_best_ask NUMERIC,
      down_best_bid NUMERIC,
      down_best_ask NUMERIC,
      up_spread NUMERIC,
      down_spread NUMERIC,
      btc_tick_age_ms INTEGER,
      up_book_age_ms INTEGER,
      down_book_age_ms INTEGER,
      chainlink_binance_gap_bps NUMERIC,
      data_complete BOOLEAN NOT NULL,
      stale BOOLEAN NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  pgm.sql(`
    CREATE TABLE signals (
      id BIGSERIAL PRIMARY KEY,
      ts TIMESTAMPTZ NOT NULL,
      market_id TEXT NOT NULL,
      market_state_id BIGINT NOT NULL REFERENCES market_states(id),
      decision TEXT NOT NULL,
      side TEXT,
      price NUMERIC,
      estimated_probability NUMERIC,
      estimated_ev NUMERIC,
      accepted BOOLEAN NOT NULL,
      rejection_reasons JSONB NOT NULL DEFAULT '[]',
      features JSONB NOT NULL DEFAULT '{}',
      outcome TEXT,
      final_outcome TEXT,
      resolved_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT signals_decision_chk
        CHECK (decision IN ('BUY_UP', 'BUY_DOWN', 'REJECT')),
      CONSTRAINT signals_side_chk
        CHECK (side IS NULL OR side IN ('UP', 'DOWN')),
      CONSTRAINT signals_outcome_chk
        CHECK (outcome IS NULL OR outcome IN ('WIN', 'LOSS', 'NOT_APPLICABLE')),
      CONSTRAINT signals_final_outcome_chk
        CHECK (final_outcome IS NULL OR final_outcome IN ('UP', 'DOWN')),
      CONSTRAINT signals_accepted_decision_chk
        CHECK (
          (decision = 'REJECT' AND accepted = FALSE)
          OR (decision IN ('BUY_UP', 'BUY_DOWN') AND accepted = TRUE)
        )
    );
  `);

  // Hot query paths:
  //   (market_id, ts)        → "show me state/signals for this market"
  //   (accepted, ts)         → "show me all accepted signals over time"
  //   (accepted, outcome, ts)→ "show me WINs / LOSSes after labeling"
  //   (market_state_id)      → FK reverse-lookup ("which signals were
  //                            generated from this state?"). Always index
  //                            FKs to avoid sequential scans on cascade /
  //                            join paths.
  pgm.sql(`CREATE INDEX idx_market_states_market_ts ON market_states (market_id, ts);`);
  pgm.sql(`CREATE INDEX idx_signals_market_ts ON signals (market_id, ts);`);
  pgm.sql(`CREATE INDEX idx_signals_accepted_ts ON signals (accepted, ts);`);
  pgm.sql(
    `CREATE INDEX idx_signals_accepted_outcome_ts ON signals (accepted, outcome, ts);`
  );
  pgm.sql(`CREATE INDEX idx_signals_market_state_id ON signals (market_state_id);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Drop in reverse FK order (signals references market_states), and use
  // CASCADE so a future view / dependent object built on top of these
  // tables surfaces a real failure rather than being silently masked by
  // IF EXISTS.
  pgm.sql(`DROP TABLE IF EXISTS signals CASCADE;`);
  pgm.sql(`DROP TABLE IF EXISTS market_states CASCADE;`);
}
