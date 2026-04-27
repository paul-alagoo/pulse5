import type {
  Signal,
  SignalDecision,
  SignalOutcome,
  SignalRejectionReason,
  SignalSide,
} from '@pulse5/models';
import type { Db } from './client.js';

/**
 * v0.2 signals repository.
 *
 * Stores the engine's decision (BUY_UP | BUY_DOWN | REJECT) plus the
 * features it considered, links back to the source `market_states` row, and
 * exposes an `updateOutcome` mutator the outcome-labeler uses *after* the
 * underlying market resolves. Pure persistence — the rejection logic itself
 * lives in `packages/strategy`. v0.2 still does not trade.
 */
export interface SignalsRepository {
  insert(signal: Signal): Promise<bigint>;
  /**
   * v0.2.1 idempotent insert. Returns the existing id when a row already
   * exists for `market_state_id` (the unique constraint added in
   * `migrations/1714000000002_v0.2.1-shadow-batch-replay.ts`), otherwise
   * inserts and returns the new id. Pure-function shadow scoring is
   * deterministic in the state, so a re-run for the same persisted state
   * row would always be a duplicate of the existing signal.
   */
  insertIfAbsent(signal: Signal): Promise<{ id: bigint; inserted: boolean }>;
  findById(id: bigint): Promise<Signal | null>;
  /**
   * Stamps a signal with its post-resolution scoring. `finalOutcome` is the
   * normalized market settlement snapshot (UP|DOWN); `outcome` is the signal
   * scoring (WIN|LOSS|NOT_APPLICABLE). `resolvedAt` is the label clock.
   */
  updateOutcome(
    id: bigint,
    outcome: SignalOutcome,
    finalOutcome: SignalSide | null,
    resolvedAt: Date
  ): Promise<void>;
  countByMarket(marketId: string): Promise<number>;
}

interface SignalRow {
  id: string;
  ts: Date;
  market_id: string;
  // Defensively typed nullable: the schema declares this NOT NULL, but a
  // future migration / manual SQL fix-up could leak a NULL row. We surface
  // that as a typed error rather than letting `BigInt(null)` throw a raw
  // TypeError.
  market_state_id: string | null;
  decision: string;
  side: string | null;
  price: string | null;
  estimated_probability: string | null;
  estimated_ev: string | null;
  accepted: boolean;
  rejection_reasons: unknown;
  features: unknown;
  outcome: string | null;
  final_outcome: string | null;
  resolved_at: Date | null;
}

interface IdRow {
  id: string;
}

interface CountRow {
  c: string;
}

function numOrNull(value: string | null): number | null {
  return value === null ? null : Number(value);
}

// Closed-union allow-lists for narrow CHECK-constrained columns. We
// validate at the repo boundary so a future schema regression that lets
// "buy_up" through surfaces as a typed error rather than as a silently
// bad value flowing into the rest of the system.
const DECISION_VALUES: ReadonlySet<SignalDecision> = new Set(['BUY_UP', 'BUY_DOWN', 'REJECT']);
const SIDE_VALUES: ReadonlySet<SignalSide> = new Set(['UP', 'DOWN']);
const OUTCOME_VALUES: ReadonlySet<SignalOutcome> = new Set([
  'WIN',
  'LOSS',
  'NOT_APPLICABLE',
]);
const REJECTION_REASON_VALUES: ReadonlySet<SignalRejectionReason> = new Set([
  'DATA_INCOMPLETE',
  'PRICE_TO_BEAT_MISSING',
  'STALE_BTC_TICK',
  'STALE_UP_BOOK',
  'STALE_DOWN_BOOK',
  'TIME_REMAINING_TOO_LOW',
  'TIME_REMAINING_TOO_HIGH',
  'SPREAD_TOO_WIDE',
  'BTC_FEED_GAP_TOO_LARGE',
  'BTC_TOO_CLOSE_TO_PRICE_TO_BEAT',
  'ENTRY_PRICE_TOO_EXPENSIVE',
  'NO_EDGE',
]);

function narrowDecision(raw: string): SignalDecision {
  if (DECISION_VALUES.has(raw as SignalDecision)) return raw as SignalDecision;
  throw new Error(`signals row has invalid decision: ${raw}`);
}

function narrowSide(raw: string | null): SignalSide | null {
  if (raw === null) return null;
  if (SIDE_VALUES.has(raw as SignalSide)) return raw as SignalSide;
  throw new Error(`signals row has invalid side: ${raw}`);
}

function narrowOutcome(raw: string | null): SignalOutcome | null {
  if (raw === null) return null;
  if (OUTCOME_VALUES.has(raw as SignalOutcome)) return raw as SignalOutcome;
  throw new Error(`signals row has invalid outcome: ${raw}`);
}

function parseRejectionReasons(raw: unknown): SignalRejectionReason[] {
  if (!Array.isArray(raw)) return [];
  // Drop unknown strings rather than throwing — a forward-compatible
  // reader should not crash on a future reason it has not yet learned.
  return raw.filter(
    (r): r is SignalRejectionReason =>
      typeof r === 'string' && REJECTION_REASON_VALUES.has(r as SignalRejectionReason)
  );
}

function parseFeatures(raw: unknown): Signal['features'] {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Signal['features'];
  }
  return {};
}

function rowToSignal(row: SignalRow): Signal {
  if (row.market_state_id === null) {
    throw new Error(`signals row id=${row.id} has null market_state_id`);
  }
  return {
    id: BigInt(row.id),
    ts: row.ts,
    marketId: row.market_id,
    marketStateId: BigInt(row.market_state_id),
    decision: narrowDecision(row.decision),
    side: narrowSide(row.side),
    price: numOrNull(row.price),
    estimatedProbability: numOrNull(row.estimated_probability),
    estimatedEv: numOrNull(row.estimated_ev),
    accepted: row.accepted,
    rejectionReasons: parseRejectionReasons(row.rejection_reasons),
    features: parseFeatures(row.features),
    outcome: narrowOutcome(row.outcome),
    finalOutcome: narrowSide(row.final_outcome),
    resolvedAt: row.resolved_at,
  };
}

export function createSignalsRepository(db: Db): SignalsRepository {
  return {
    async insert(signal: Signal): Promise<bigint> {
      if (signal.marketStateId === null) {
        throw new Error('signals.insert requires a marketStateId');
      }
      // CHECK constraints in the migration enforce decision/side/accepted
      // consistency. We deliberately don't re-validate here so a strategy
      // bug surfaces as a Postgres error rather than as silently-rewritten
      // data — the caller is supposed to be a pure function in
      // packages/strategy.
      const result = await db.query<IdRow>(
        `INSERT INTO signals (
           ts, market_id, market_state_id,
           decision, side, price,
           estimated_probability, estimated_ev,
           accepted, rejection_reasons, features,
           outcome, final_outcome, resolved_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8,
           $9, $10::jsonb, $11::jsonb,
           $12, $13, $14
         )
         RETURNING id`,
        [
          signal.ts,
          signal.marketId,
          signal.marketStateId.toString(),
          signal.decision,
          signal.side,
          signal.price,
          signal.estimatedProbability,
          signal.estimatedEv,
          signal.accepted,
          JSON.stringify(signal.rejectionReasons),
          JSON.stringify(signal.features),
          signal.outcome,
          signal.finalOutcome,
          signal.resolvedAt,
        ]
      );
      const idStr = result.rows[0]?.id;
      if (!idStr) {
        throw new Error('signals insert returned no id');
      }
      return BigInt(idStr);
    },

    async insertIfAbsent(
      signal: Signal
    ): Promise<{ id: bigint; inserted: boolean }> {
      if (signal.marketStateId === null) {
        throw new Error('signals.insertIfAbsent requires a marketStateId');
      }
      const insert = await db.query<IdRow>(
        `INSERT INTO signals (
           ts, market_id, market_state_id,
           decision, side, price,
           estimated_probability, estimated_ev,
           accepted, rejection_reasons, features,
           outcome, final_outcome, resolved_at
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6,
           $7, $8,
           $9, $10::jsonb, $11::jsonb,
           $12, $13, $14
         )
         ON CONFLICT (market_state_id) DO NOTHING
         RETURNING id`,
        [
          signal.ts,
          signal.marketId,
          signal.marketStateId.toString(),
          signal.decision,
          signal.side,
          signal.price,
          signal.estimatedProbability,
          signal.estimatedEv,
          signal.accepted,
          JSON.stringify(signal.rejectionReasons),
          JSON.stringify(signal.features),
          signal.outcome,
          signal.finalOutcome,
          signal.resolvedAt,
        ]
      );
      const insertedId = insert.rows[0]?.id;
      if (insertedId) {
        return { id: BigInt(insertedId), inserted: true };
      }
      const existing = await db.query<IdRow>(
        `SELECT id FROM signals WHERE market_state_id = $1`,
        [signal.marketStateId.toString()]
      );
      const existingId = existing.rows[0]?.id;
      if (!existingId) {
        throw new Error(
          'signals insertIfAbsent: conflict reported but no existing row found'
        );
      }
      return { id: BigInt(existingId), inserted: false };
    },

    async findById(id: bigint): Promise<Signal | null> {
      const result = await db.query<SignalRow>(
        `SELECT id, ts, market_id, market_state_id,
                decision, side, price,
                estimated_probability, estimated_ev,
                accepted, rejection_reasons, features,
                outcome, final_outcome, resolved_at
           FROM signals
          WHERE id = $1`,
        [id.toString()]
      );
      const row = result.rows[0];
      return row ? rowToSignal(row) : null;
    },

    async updateOutcome(
      id: bigint,
      outcome: SignalOutcome,
      finalOutcome: SignalSide | null,
      resolvedAt: Date
    ): Promise<void> {
      const result = await db.query(
        `UPDATE signals
            SET outcome = $2,
                final_outcome = $3,
                resolved_at = $4
          WHERE id = $1`,
        [id.toString(), outcome, finalOutcome, resolvedAt]
      );
      // Fire-and-forget UPDATEs leave stale ids permanently unlabeled with
      // no observable failure. Treat "no row updated" as an explicit error
      // so the outcome-labeler caller can decide how to handle it.
      if (result.rowCount === 0) {
        throw new Error(`signals.updateOutcome: no row found for id=${id.toString()}`);
      }
    },

    async countByMarket(marketId: string): Promise<number> {
      const result = await db.query<CountRow>(
        `SELECT COUNT(*)::text AS c FROM signals WHERE market_id = $1`,
        [marketId]
      );
      return Number(result.rows[0]?.c ?? '0');
    },
  };
}
