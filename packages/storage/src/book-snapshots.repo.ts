import type { BookSnapshot } from '@pulse5/models';
import type { Db } from './client.js';

export interface BookSnapshotsRepository {
  insert(snapshot: BookSnapshot): Promise<void>;
  countByMarket(marketId: string): Promise<number>;
}

interface CountRow {
  c: string;
}

export function createBookSnapshotsRepository(db: Db): BookSnapshotsRepository {
  return {
    async insert(snapshot: BookSnapshot): Promise<void> {
      // (ts, market_id, token_id) is the primary key. Two CLOB events at
      // the exact same `source_ts` for the same token are a race we drop:
      // the second one's normalized snapshot is redundant because the raw
      // event is still recorded in `raw_events` with full payload. We use
      // ON CONFLICT DO NOTHING rather than crashing the ingest loop.
      await db.query(
        `INSERT INTO book_snapshots (
           ts, receive_ts, market_id, token_id,
           best_bid, best_ask, bid_size, ask_size, spread,
           raw_event_id
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7, $8, $9,
           $10
         )
         ON CONFLICT (ts, market_id, token_id) DO NOTHING`,
        [
          snapshot.ts,
          snapshot.receiveTs,
          snapshot.marketId,
          snapshot.tokenId,
          snapshot.bestBid,
          snapshot.bestAsk,
          snapshot.bidSize,
          snapshot.askSize,
          snapshot.spread,
          snapshot.rawEventId === null ? null : snapshot.rawEventId.toString(),
        ]
      );
    },

    async countByMarket(marketId: string): Promise<number> {
      const result = await db.query<CountRow>(
        `SELECT COUNT(*)::text AS c FROM book_snapshots WHERE market_id = $1`,
        [marketId]
      );
      return Number(result.rows[0]?.c ?? '0');
    },
  };
}
