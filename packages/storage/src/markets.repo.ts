import type { Market } from '@pulse5/models';
import type { Db } from './client.js';

export interface MarketsRepository {
  upsert(market: Market): Promise<void>;
  findById(marketId: string): Promise<Market | null>;
  markResolved(marketId: string, finalOutcome: string): Promise<void>;
}

interface MarketRow {
  market_id: string;
  event_id: string;
  slug: string;
  question: string;
  condition_id: string | null;
  up_token_id: string;
  down_token_id: string;
  start_time: Date;
  end_time: Date;
  price_to_beat: string | null;
  resolution_source: string;
  status: string;
  final_outcome: string | null;
}

function rowToMarket(row: MarketRow): Market {
  return {
    marketId: row.market_id,
    eventId: row.event_id,
    slug: row.slug,
    question: row.question,
    conditionId: row.condition_id,
    upTokenId: row.up_token_id,
    downTokenId: row.down_token_id,
    startTime: row.start_time,
    endTime: row.end_time,
    priceToBeat: row.price_to_beat === null ? null : Number(row.price_to_beat),
    resolutionSource: row.resolution_source,
    status: row.status,
    finalOutcome: row.final_outcome,
  };
}

export function createMarketsRepository(db: Db): MarketsRepository {
  return {
    async upsert(market: Market): Promise<void> {
      // Re-discovery is normal — slugs are deterministic, so we update
      // mutable fields (status, final_outcome, end_time) on conflict but
      // never rewrite the immutable identity columns.
      await db.query(
        `INSERT INTO markets (
           market_id, event_id, slug, question, condition_id,
           up_token_id, down_token_id, start_time, end_time,
           price_to_beat, resolution_source, status, final_outcome
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8, $9,
           $10, $11, $12, $13
         )
         ON CONFLICT (market_id) DO UPDATE SET
           event_id = EXCLUDED.event_id,
           slug = EXCLUDED.slug,
           question = EXCLUDED.question,
           condition_id = COALESCE(EXCLUDED.condition_id, markets.condition_id),
           up_token_id = EXCLUDED.up_token_id,
           down_token_id = EXCLUDED.down_token_id,
           start_time = EXCLUDED.start_time,
           end_time = EXCLUDED.end_time,
           price_to_beat = COALESCE(EXCLUDED.price_to_beat, markets.price_to_beat),
           resolution_source = EXCLUDED.resolution_source,
           status = EXCLUDED.status,
           final_outcome = COALESCE(EXCLUDED.final_outcome, markets.final_outcome);`,
        [
          market.marketId,
          market.eventId,
          market.slug,
          market.question,
          market.conditionId,
          market.upTokenId,
          market.downTokenId,
          market.startTime,
          market.endTime,
          market.priceToBeat,
          market.resolutionSource,
          market.status,
          market.finalOutcome,
        ]
      );
    },

    async findById(marketId: string): Promise<Market | null> {
      const result = await db.query<MarketRow>(
        `SELECT market_id, event_id, slug, question, condition_id,
                up_token_id, down_token_id, start_time, end_time,
                price_to_beat, resolution_source, status, final_outcome
           FROM markets
           WHERE market_id = $1`,
        [marketId]
      );
      const row = result.rows[0];
      return row ? rowToMarket(row) : null;
    },

    async markResolved(marketId: string, finalOutcome: string): Promise<void> {
      await db.query(
        `UPDATE markets
            SET status = 'resolved', final_outcome = $2
          WHERE market_id = $1`,
        [marketId, finalOutcome]
      );
    },
  };
}
