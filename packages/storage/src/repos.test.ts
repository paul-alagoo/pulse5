import { describe, it, expect } from 'vitest';
import type { Db, QueryResult } from './client.js';
import { createMarketsRepository } from './markets.repo.js';
import { createRawEventsRepository } from './raw-events.repo.js';
import { createBookSnapshotsRepository } from './book-snapshots.repo.js';
import { createBtcTicksRepository } from './btc-ticks.repo.js';
import type { Market, RawEventRecord, BookSnapshot, BtcTick } from '@pulse5/models';
import type { QueryResultRow } from 'pg';

interface ScriptedQuery {
  match: RegExp;
  rows: QueryResultRow[];
}

interface FakeDb extends Db {
  calls: Array<{ text: string; params: ReadonlyArray<unknown> }>;
}

function fakeDb(scripted: ScriptedQuery[] = []): FakeDb {
  const calls: FakeDb['calls'] = [];
  return {
    calls,
    async query<R extends QueryResultRow = QueryResultRow>(
      text: string,
      params: ReadonlyArray<unknown> = []
    ): Promise<QueryResult<R>> {
      calls.push({ text, params });
      const matched = scripted.find((s) => s.match.test(text));
      const rows = (matched?.rows ?? []) as R[];
      return { rows, rowCount: rows.length };
    },
    async end(): Promise<void> {
      // no-op
    },
  };
}

const FIXED_START = new Date('2026-04-25T12:30:00Z');
const FIXED_END = new Date('2026-04-25T12:35:00Z');

function fixtureMarket(overrides: Partial<Market> = {}): Market {
  return {
    marketId: 'mkt-1',
    eventId: 'evt-1',
    slug: 'btc-updown-5m-1714000000',
    question: 'Will BTC be above $67,250 at 12:35 PM ET?',
    conditionId: 'cond-1',
    upTokenId: 'tok-up',
    downTokenId: 'tok-down',
    startTime: FIXED_START,
    endTime: FIXED_END,
    priceToBeat: 67250,
    resolutionSource: 'chainlink-btc-usd',
    status: 'open',
    finalOutcome: null,
    ...overrides,
  };
}

describe('markets repository', () => {
  it('upserts a market and binds every column in order', async () => {
    const db = fakeDb();
    const repo = createMarketsRepository(db);
    const market = fixtureMarket();
    await repo.upsert(market);

    expect(db.calls).toHaveLength(1);
    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO markets');
    expect(call.text).toContain('ON CONFLICT (market_id) DO UPDATE');
    expect(call.params).toEqual([
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
    ]);
  });

  it('round-trips: findById decodes rows from snake_case to Market', async () => {
    const db = fakeDb([
      {
        match: /SELECT[\s\S]*FROM markets/,
        rows: [
          {
            market_id: 'mkt-1',
            event_id: 'evt-1',
            slug: 'btc-updown-5m-1714000000',
            question: 'q',
            condition_id: 'cond-1',
            up_token_id: 'tok-up',
            down_token_id: 'tok-down',
            start_time: FIXED_START,
            end_time: FIXED_END,
            // pg returns NUMERIC as string by default — repo must coerce.
            price_to_beat: '67250',
            resolution_source: 'chainlink-btc-usd',
            status: 'open',
            final_outcome: null,
          },
        ],
      },
    ]);
    const repo = createMarketsRepository(db);
    const found = await repo.findById('mkt-1');
    expect(found).toEqual({
      marketId: 'mkt-1',
      eventId: 'evt-1',
      slug: 'btc-updown-5m-1714000000',
      question: 'q',
      conditionId: 'cond-1',
      upTokenId: 'tok-up',
      downTokenId: 'tok-down',
      startTime: FIXED_START,
      endTime: FIXED_END,
      priceToBeat: 67250,
      resolutionSource: 'chainlink-btc-usd',
      status: 'open',
      finalOutcome: null,
    });
  });

  it('handles null price_to_beat from the DB', async () => {
    const db = fakeDb([
      {
        match: /SELECT/,
        rows: [
          {
            market_id: 'mkt-2',
            event_id: 'evt-2',
            slug: 'btc-updown-5m-1714000300',
            question: '',
            condition_id: null,
            up_token_id: 'a',
            down_token_id: 'b',
            start_time: FIXED_START,
            end_time: FIXED_END,
            price_to_beat: null,
            resolution_source: 'chainlink-btc-usd',
            status: 'open',
            final_outcome: null,
          },
        ],
      },
    ]);
    const repo = createMarketsRepository(db);
    const m = await repo.findById('mkt-2');
    expect(m?.priceToBeat).toBeNull();
    expect(m?.conditionId).toBeNull();
  });

  it('returns null when market does not exist', async () => {
    const db = fakeDb();
    const repo = createMarketsRepository(db);
    const m = await repo.findById('missing');
    expect(m).toBeNull();
  });

  it('markResolved issues an UPDATE with status="resolved"', async () => {
    const db = fakeDb();
    const repo = createMarketsRepository(db);
    await repo.markResolved('mkt-1', 'Up');
    expect(db.calls[0]!.text).toContain('UPDATE markets');
    expect(db.calls[0]!.text).toContain("status = 'resolved'");
    expect(db.calls[0]!.params).toEqual(['mkt-1', 'Up']);
  });
});

describe('raw_events repository', () => {
  it('inserts a record, JSON-serializes payload, and returns BIGINT id as bigint', async () => {
    const db = fakeDb([{ match: /INSERT INTO raw_events/, rows: [{ id: '4242' }] }]);
    const repo = createRawEventsRepository(db);
    const record: RawEventRecord = {
      source: 'clob',
      eventType: 'book',
      sourceTs: new Date('2026-04-25T12:00:00Z'),
      receiveTs: new Date('2026-04-25T12:00:00.123Z'),
      marketId: 'mkt-1',
      tokenId: 'tok-up',
      payload: { bids: [['0.5', '100']], asks: [] },
    };
    const id = await repo.insert(record);
    expect(id).toBe(4242n);

    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO raw_events');
    expect(call.text).toContain('RETURNING id');
    // Payload must be a JSON string so pg can cast to jsonb.
    const payloadParam = call.params[6] as string;
    expect(typeof payloadParam).toBe('string');
    expect(JSON.parse(payloadParam)).toEqual(record.payload);
  });

  it('serializes null payload as JSON null', async () => {
    const db = fakeDb([{ match: /INSERT/, rows: [{ id: '1' }] }]);
    const repo = createRawEventsRepository(db);
    await repo.insert({
      source: 'clob',
      eventType: 'unknown',
      sourceTs: null,
      receiveTs: new Date(),
      marketId: null,
      tokenId: null,
      payload: undefined,
    });
    expect(db.calls[0]!.params[6]).toBe('null');
  });

  it('throws when RETURNING id row is missing', async () => {
    const db = fakeDb([{ match: /INSERT/, rows: [] }]);
    const repo = createRawEventsRepository(db);
    await expect(
      repo.insert({
        source: 'clob',
        eventType: 'book',
        sourceTs: null,
        receiveTs: new Date(),
        marketId: null,
        tokenId: null,
        payload: {},
      })
    ).rejects.toThrow(/no id/);
  });

  it('countBySource parses the COUNT(*) text result', async () => {
    const db = fakeDb([{ match: /SELECT COUNT/, rows: [{ c: '17' }] }]);
    const repo = createRawEventsRepository(db);
    expect(await repo.countBySource('clob')).toBe(17);
  });

  it('countBySource returns 0 when no rows match', async () => {
    const db = fakeDb([{ match: /SELECT COUNT/, rows: [] }]);
    const repo = createRawEventsRepository(db);
    expect(await repo.countBySource('absent')).toBe(0);
  });
});

describe('book_snapshots repository', () => {
  it('inserts a snapshot with BIGINT raw_event_id stringified', async () => {
    const db = fakeDb();
    const repo = createBookSnapshotsRepository(db);
    const snap: BookSnapshot = {
      ts: new Date('2026-04-25T12:00:00Z'),
      receiveTs: new Date('2026-04-25T12:00:00.123Z'),
      marketId: 'mkt-1',
      tokenId: 'tok-up',
      bestBid: 0.42,
      bestAsk: 0.45,
      bidSize: 100,
      askSize: 200,
      spread: 0.03,
      rawEventId: 4242n,
    };
    await repo.insert(snap);
    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO book_snapshots');
    expect(call.text).toContain('ON CONFLICT (ts, market_id, token_id) DO NOTHING');
    expect(call.params[9]).toBe('4242');
  });

  it('passes null raw_event_id through unchanged', async () => {
    const db = fakeDb();
    const repo = createBookSnapshotsRepository(db);
    await repo.insert({
      ts: new Date(),
      receiveTs: new Date(),
      marketId: 'mkt-1',
      tokenId: 'tok-up',
      bestBid: null,
      bestAsk: null,
      bidSize: null,
      askSize: null,
      spread: null,
      rawEventId: null,
    });
    expect(db.calls[0]!.params[9]).toBeNull();
  });

  it('countByMarket parses count', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [{ c: '8' }] }]);
    const repo = createBookSnapshotsRepository(db);
    expect(await repo.countByMarket('mkt-1')).toBe(8);
  });
});

describe('btc_ticks repository', () => {
  it('inserts tick fields in order', async () => {
    const db = fakeDb();
    const repo = createBtcTicksRepository(db);
    const tick: BtcTick = {
      ts: new Date('2026-04-25T12:00:00Z'),
      receiveTs: new Date('2026-04-25T12:00:00.500Z'),
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67_500.25,
      latencyMs: 500,
      rawEventId: 99n,
    };
    await repo.insert(tick);
    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO btc_ticks');
    expect(call.text).toContain('ON CONFLICT (ts, source, symbol) DO NOTHING');
    expect(call.params).toEqual([
      tick.ts,
      tick.receiveTs,
      tick.source,
      tick.symbol,
      tick.price,
      tick.latencyMs,
      '99',
    ]);
  });

  it('passes null raw_event_id and latencyMs through', async () => {
    const db = fakeDb();
    const repo = createBtcTicksRepository(db);
    await repo.insert({
      ts: new Date(),
      receiveTs: new Date(),
      source: 'rtds.chainlink',
      symbol: 'btc/usd',
      price: 67000,
      latencyMs: null,
      rawEventId: null,
    });
    const call = db.calls[0]!;
    expect(call.params[5]).toBeNull();
    expect(call.params[6]).toBeNull();
  });

  it('countBySource parses count', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [{ c: '3' }] }]);
    const repo = createBtcTicksRepository(db);
    expect(await repo.countBySource('rtds.binance')).toBe(3);
  });
});
