import type { BtcTick } from '@pulse5/models';
import type { Db } from './client.js';

export interface BtcTicksRepository {
  insert(tick: BtcTick): Promise<void>;
  countBySource(source: string): Promise<number>;
}

interface CountRow {
  c: string;
}

export function createBtcTicksRepository(db: Db): BtcTicksRepository {
  return {
    async insert(tick: BtcTick): Promise<void> {
      // Same composite-key rationale as book_snapshots: at sub-second
      // duplicates we drop the redundant insert; the raw payload is still
      // captured in raw_events so replay is lossless.
      await db.query(
        `INSERT INTO btc_ticks (
           ts, receive_ts, source, symbol,
           price, latency_ms, raw_event_id
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7
         )
         ON CONFLICT (ts, source, symbol) DO NOTHING`,
        [
          tick.ts,
          tick.receiveTs,
          tick.source,
          tick.symbol,
          tick.price,
          tick.latencyMs,
          tick.rawEventId === null ? null : tick.rawEventId.toString(),
        ]
      );
    },

    async countBySource(source: string): Promise<number> {
      const result = await db.query<CountRow>(
        `SELECT COUNT(*)::text AS c FROM btc_ticks WHERE source = $1`,
        [source]
      );
      return Number(result.rows[0]?.c ?? '0');
    },
  };
}
