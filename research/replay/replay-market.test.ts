// Replay no-lookahead tests.
//
// Focused on the price_to_beat Chainlink fallback helper. The fallback
// query is conceptually "Chainlink tick whose ts is closest to
// market.start_time", but the no-lookahead rule (§8a / §8b) says that any
// candidate tick must already have been received at the replay target —
// `receive_ts <= targetTimestamp`. Without that filter, a tick whose ts
// happens to land near start_time but whose receive_ts is in the future
// of the moment we are scoring would silently leak future data into the
// shadow signal.

import { describe, it, expect } from 'vitest';
import type { Db, QueryResult } from '@pulse5/storage';
import type { QueryResultRow } from 'pg';
import {
  __testOnlyChainlinkTickNearestStartTime,
  __testOnlyLatestBookByReceiveTs,
  __testOnlyLatestTickByReceiveTs,
} from './replay-market.js';

interface RecordedCall {
  text: string;
  params: ReadonlyArray<unknown>;
}

interface ScriptedQuery {
  rows: QueryResultRow[];
}

function fakeDb(scripted: ScriptedQuery = { rows: [] }): {
  db: Db;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const db: Db = {
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: ReadonlyArray<unknown> = []
    ): Promise<QueryResult<R>> {
      calls.push({ text, params });
      return { rows: scripted.rows as R[], rowCount: scripted.rows.length };
    },
    async end(): Promise<void> {
      /* no-op */
    },
  };
  return { db, calls };
}

const START_TIME = new Date('2026-04-25T12:30:00Z');
const TARGET = new Date('2026-04-25T12:30:30Z'); // start + 30s
const TOLERANCE_MS = 10_000;

describe('chainlinkTickNearestStartTime (price_to_beat fallback no-lookahead)', () => {
  it('passes targetTimestamp as the receive_ts upper bound to the SQL query', async () => {
    const { db, calls } = fakeDb({ rows: [] });
    await __testOnlyChainlinkTickNearestStartTime(db, START_TIME, TOLERANCE_MS, TARGET);
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    // The SQL must filter on receive_ts <= $2 — the no-lookahead rule
    // for the fallback helper.
    expect(call.text).toMatch(/receive_ts\s*<=\s*\$2/);
    expect(call.text).toMatch(/source\s*=\s*'rtds\.chainlink'/);
    expect(call.params).toEqual([START_TIME, TARGET]);
  });

  it('returns null when no tick is visible at the target (DB simulates the receive_ts filter)', async () => {
    // Simulating the production DB behavior: with `receive_ts <= TARGET`,
    // a tick whose receive_ts is in the future of TARGET returns no rows
    // at all from the SQL filter. The fallback helper must therefore
    // return null instead of the lookahead row.
    const { db } = fakeDb({ rows: [] });
    const tick = await __testOnlyChainlinkTickNearestStartTime(
      db,
      START_TIME,
      TOLERANCE_MS,
      TARGET
    );
    expect(tick).toBeNull();
  });

  it('returns the visible tick when one is within tolerance and already received', async () => {
    const visibleReceiveTs = new Date(TARGET.getTime() - 1_000); // 1 s before target
    const { db } = fakeDb({
      rows: [
        {
          ts: new Date(START_TIME.getTime() + 200), // 200 ms after start_time
          receive_ts: visibleReceiveTs,
          source: 'rtds.chainlink',
          symbol: 'btc/usd',
          price: '67500.0',
          latency_ms: 200,
          raw_event_id: '42',
        },
      ],
    });
    const tick = await __testOnlyChainlinkTickNearestStartTime(
      db,
      START_TIME,
      TOLERANCE_MS,
      TARGET
    );
    expect(tick).not.toBeNull();
    expect(tick?.price).toBe(67_500);
    expect(tick?.receiveTs).toEqual(visibleReceiveTs);
    expect(tick?.source).toBe('rtds.chainlink');
  });

  it('rejects ticks outside the ts proximity tolerance even if visible', async () => {
    // A tick with receive_ts <= target but ts that is far from
    // market.start_time must still be rejected — the helper double-checks
    // tolerance in TS so a misuse of the helper cannot silently
    // smuggle a far-away price into priceToBeat.
    const { db } = fakeDb({
      rows: [
        {
          ts: new Date(START_TIME.getTime() + 60_000), // 60 s after start_time
          receive_ts: new Date(TARGET.getTime() - 1_000),
          source: 'rtds.chainlink',
          symbol: 'btc/usd',
          price: '67500.0',
          latency_ms: 200,
          raw_event_id: '42',
        },
      ],
    });
    const tick = await __testOnlyChainlinkTickNearestStartTime(
      db,
      START_TIME,
      TOLERANCE_MS,
      TARGET
    );
    expect(tick).toBeNull();
  });
});

describe('latestTickByReceiveTs / latestBookByReceiveTs', () => {
  it('latestTickByReceiveTs filters on receive_ts <= target', async () => {
    const { db, calls } = fakeDb({ rows: [] });
    await __testOnlyLatestTickByReceiveTs(db, 'rtds.chainlink', TARGET);
    expect(calls[0]?.text).toMatch(/receive_ts\s*<=\s*\$2/);
    expect(calls[0]?.params).toEqual(['rtds.chainlink', TARGET]);
  });

  it('latestBookByReceiveTs filters on receive_ts <= target', async () => {
    const { db, calls } = fakeDb({ rows: [] });
    await __testOnlyLatestBookByReceiveTs(db, 'mkt-1', 'tok-up', TARGET);
    expect(calls[0]?.text).toMatch(/receive_ts\s*<=\s*\$3/);
    expect(calls[0]?.params).toEqual(['mkt-1', 'tok-up', TARGET]);
  });
});
