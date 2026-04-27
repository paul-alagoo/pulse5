import type { MigrationBuilder, ColumnDefinitions } from 'node-pg-migrate';

export const shorthands: ColumnDefinitions | undefined = undefined;

// Pulse5 v0.2.1 — Shadow Batch Replay schema deltas.
//
// v0.2.1 adds *batch* replay over many resolved BTC 5-minute markets so we can
// measure shadow-signal density before deciding whether v0.3 paper simulation
// is worth pursuing. Batch replay must be re-runnable without producing
// duplicate `market_states` / `signals` rows; this migration enforces that
// idempotency at the schema layer rather than relying on application code.
//
// Two unique constraints are added:
//
//   - `market_states (market_id, ts)` — one shadow state per (market, replay
//     timestamp). Repeated persisted runs of the same batch over the same
//     window collapse to the same row instead of stacking duplicates.
//
//   - `signals (market_state_id)` — at most one signal per persisted state.
//     The shadow engine is a pure function of the state, so a second insert
//     for the same state would always be a duplicate of the first.
//
// v0.2.1 still does NOT introduce orders, simulated_orders, fills, positions,
// execution adapters, wallets, signers, or private-key handling. The schema
// surface added by this migration is exactly two unique indexes — there are
// no new tables, columns, or trading paths.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Use CREATE UNIQUE INDEX rather than ALTER TABLE ... ADD CONSTRAINT so we
  // can name the indexes explicitly and so the migration is reversible by
  // index name in down().
  pgm.sql(
    `CREATE UNIQUE INDEX uq_market_states_market_ts ON market_states (market_id, ts);`
  );
  pgm.sql(
    `CREATE UNIQUE INDEX uq_signals_market_state_id ON signals (market_state_id);`
  );
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX IF EXISTS uq_signals_market_state_id;`);
  pgm.sql(`DROP INDEX IF EXISTS uq_market_states_market_ts;`);
}
