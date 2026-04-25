import type { RawEventRecord } from '@pulse5/models';
import type { Db } from './client.js';

export interface RawEventsRepository {
  /** Insert and return the BIGSERIAL id, so callers can link normalized rows. */
  insert(record: RawEventRecord): Promise<bigint>;
  countBySource(source: string): Promise<number>;
}

interface IdRow {
  id: string;
}

interface CountRow {
  c: string;
}

export function createRawEventsRepository(db: Db): RawEventsRepository {
  return {
    async insert(record: RawEventRecord): Promise<bigint> {
      const result = await db.query<IdRow>(
        `INSERT INTO raw_events (
           source, event_type, source_ts, receive_ts,
           market_id, token_id, raw
         ) VALUES (
           $1, $2, $3, $4,
           $5, $6, $7::jsonb
         )
         RETURNING id`,
        [
          record.source,
          record.eventType,
          record.sourceTs,
          record.receiveTs,
          record.marketId,
          record.tokenId,
          JSON.stringify(record.payload ?? null),
        ]
      );
      const idStr = result.rows[0]?.id;
      if (!idStr) {
        throw new Error('raw_events insert returned no id');
      }
      return BigInt(idStr);
    },

    async countBySource(source: string): Promise<number> {
      const result = await db.query<CountRow>(
        `SELECT COUNT(*)::text AS c FROM raw_events WHERE source = $1`,
        [source]
      );
      const c = result.rows[0]?.c ?? '0';
      return Number(c);
    },
  };
}
