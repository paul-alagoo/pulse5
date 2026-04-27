import type { BtcSource, MarketState } from '@pulse5/models';
import type { Db } from './client.js';

/**
 * v0.2 market_states repository.
 *
 * `market_states` is the per-tick numeric snapshot the signal engine
 * consumes. Insertion returns the BIGSERIAL id so callers can persist a
 * matching row in `signals` with `market_state_id` pointing back. v0.2 is
 * read-only at the boundary — no orders, no wallet, no signer.
 */
export interface MarketStatesRepository {
  insert(state: MarketState): Promise<bigint>;
  /**
   * v0.2.1 idempotent insert. Returns the existing id when a row already
   * exists for `(market_id, ts)` (the unique constraint added in
   * `migrations/1714000000002_v0.2.1-shadow-batch-replay.ts`), otherwise
   * inserts and returns the new id. Used by batch replay so re-running the
   * same persisted window never stacks duplicate rows.
   */
  insertIfAbsent(state: MarketState): Promise<{ id: bigint; inserted: boolean }>;
  findById(id: bigint): Promise<MarketState | null>;
  countByMarket(marketId: string): Promise<number>;
}

interface MarketStateRow {
  id: string;
  ts: Date;
  market_id: string;
  btc_price: string | null;
  btc_source: string | null;
  price_to_beat: string | null;
  distance: string | null;
  distance_bps: string | null;
  time_remaining_ms: number | null;
  up_best_bid: string | null;
  up_best_ask: string | null;
  down_best_bid: string | null;
  down_best_ask: string | null;
  up_spread: string | null;
  down_spread: string | null;
  btc_tick_age_ms: number | null;
  up_book_age_ms: number | null;
  down_book_age_ms: number | null;
  chainlink_binance_gap_bps: string | null;
  data_complete: boolean;
  stale: boolean;
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

function rowToState(row: MarketStateRow): MarketState {
  return {
    ts: row.ts,
    marketId: row.market_id,
    btcPrice: numOrNull(row.btc_price),
    btcSource: row.btc_source as BtcSource | null,
    priceToBeat: numOrNull(row.price_to_beat),
    distance: numOrNull(row.distance),
    distanceBps: numOrNull(row.distance_bps),
    timeRemainingMs: row.time_remaining_ms,
    upBestBid: numOrNull(row.up_best_bid),
    upBestAsk: numOrNull(row.up_best_ask),
    downBestBid: numOrNull(row.down_best_bid),
    downBestAsk: numOrNull(row.down_best_ask),
    upSpread: numOrNull(row.up_spread),
    downSpread: numOrNull(row.down_spread),
    btcTickAgeMs: row.btc_tick_age_ms,
    upBookAgeMs: row.up_book_age_ms,
    downBookAgeMs: row.down_book_age_ms,
    chainlinkBinanceGapBps: numOrNull(row.chainlink_binance_gap_bps),
    dataComplete: row.data_complete,
    stale: row.stale,
  };
}

export function createMarketStatesRepository(db: Db): MarketStatesRepository {
  return {
    async insert(state: MarketState): Promise<bigint> {
      const result = await db.query<IdRow>(
        `INSERT INTO market_states (
           ts, market_id,
           btc_price, btc_source,
           price_to_beat, distance, distance_bps,
           time_remaining_ms,
           up_best_bid, up_best_ask, down_best_bid, down_best_ask,
           up_spread, down_spread,
           btc_tick_age_ms, up_book_age_ms, down_book_age_ms,
           chainlink_binance_gap_bps,
           data_complete, stale
         ) VALUES (
           $1, $2,
           $3, $4,
           $5, $6, $7,
           $8,
           $9, $10, $11, $12,
           $13, $14,
           $15, $16, $17,
           $18,
           $19, $20
         )
         RETURNING id`,
        [
          state.ts,
          state.marketId,
          state.btcPrice,
          state.btcSource,
          state.priceToBeat,
          state.distance,
          state.distanceBps,
          state.timeRemainingMs,
          state.upBestBid,
          state.upBestAsk,
          state.downBestBid,
          state.downBestAsk,
          state.upSpread,
          state.downSpread,
          state.btcTickAgeMs,
          state.upBookAgeMs,
          state.downBookAgeMs,
          state.chainlinkBinanceGapBps,
          state.dataComplete,
          state.stale,
        ]
      );
      const idStr = result.rows[0]?.id;
      if (!idStr) {
        throw new Error('market_states insert returned no id');
      }
      return BigInt(idStr);
    },

    async insertIfAbsent(
      state: MarketState
    ): Promise<{ id: bigint; inserted: boolean }> {
      // ON CONFLICT DO NOTHING returns zero rows when the unique index hits,
      // so we follow up with a SELECT for the existing id. The two-step
      // dance is intentional — using ON CONFLICT DO UPDATE would silently
      // overwrite the original state row, which we never want for replay
      // determinism (the row already there came from an earlier run that
      // saw the same inputs).
      const insert = await db.query<IdRow>(
        `INSERT INTO market_states (
           ts, market_id,
           btc_price, btc_source,
           price_to_beat, distance, distance_bps,
           time_remaining_ms,
           up_best_bid, up_best_ask, down_best_bid, down_best_ask,
           up_spread, down_spread,
           btc_tick_age_ms, up_book_age_ms, down_book_age_ms,
           chainlink_binance_gap_bps,
           data_complete, stale
         ) VALUES (
           $1, $2,
           $3, $4,
           $5, $6, $7,
           $8,
           $9, $10, $11, $12,
           $13, $14,
           $15, $16, $17,
           $18,
           $19, $20
         )
         ON CONFLICT (market_id, ts) DO NOTHING
         RETURNING id`,
        [
          state.ts,
          state.marketId,
          state.btcPrice,
          state.btcSource,
          state.priceToBeat,
          state.distance,
          state.distanceBps,
          state.timeRemainingMs,
          state.upBestBid,
          state.upBestAsk,
          state.downBestBid,
          state.downBestAsk,
          state.upSpread,
          state.downSpread,
          state.btcTickAgeMs,
          state.upBookAgeMs,
          state.downBookAgeMs,
          state.chainlinkBinanceGapBps,
          state.dataComplete,
          state.stale,
        ]
      );
      const insertedId = insert.rows[0]?.id;
      if (insertedId) {
        return { id: BigInt(insertedId), inserted: true };
      }
      const existing = await db.query<IdRow>(
        `SELECT id FROM market_states WHERE market_id = $1 AND ts = $2`,
        [state.marketId, state.ts]
      );
      const existingId = existing.rows[0]?.id;
      if (!existingId) {
        throw new Error(
          'market_states insertIfAbsent: conflict reported but no existing row found'
        );
      }
      return { id: BigInt(existingId), inserted: false };
    },

    async findById(id: bigint): Promise<MarketState | null> {
      const result = await db.query<MarketStateRow>(
        `SELECT id, ts, market_id,
                btc_price, btc_source,
                price_to_beat, distance, distance_bps,
                time_remaining_ms,
                up_best_bid, up_best_ask, down_best_bid, down_best_ask,
                up_spread, down_spread,
                btc_tick_age_ms, up_book_age_ms, down_book_age_ms,
                chainlink_binance_gap_bps,
                data_complete, stale
           FROM market_states
          WHERE id = $1`,
        [id.toString()]
      );
      const row = result.rows[0];
      return row ? rowToState(row) : null;
    },

    async countByMarket(marketId: string): Promise<number> {
      const result = await db.query<CountRow>(
        `SELECT COUNT(*)::text AS c FROM market_states WHERE market_id = $1`,
        [marketId]
      );
      return Number(result.rows[0]?.c ?? '0');
    },
  };
}
