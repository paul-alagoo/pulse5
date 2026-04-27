import { describe, it, expect } from 'vitest';
import type { Db, QueryResult } from './client.js';
import { createMarketStatesRepository } from './market-states.repo.js';
import { createSignalsRepository } from './signals.repo.js';
import type { MarketState, Signal } from '@pulse5/models';
import type { QueryResultRow } from 'pg';

interface ScriptedQuery {
  match: RegExp;
  rows: QueryResultRow[];
  /** Override rowCount when the SQL is an UPDATE / DELETE with no RETURNING. */
  rowCount?: number;
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
      const rowCount = matched?.rowCount ?? rows.length;
      return { rows, rowCount };
    },
    async end(): Promise<void> {
      // no-op
    },
  };
}

const FIXED_TS = new Date('2026-04-25T12:32:30Z');

function fixtureState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ts: FIXED_TS,
    marketId: 'mkt-1',
    btcPrice: 67_500,
    btcSource: 'rtds.chainlink',
    priceToBeat: 67_250,
    distance: 250,
    distanceBps: 37.17,
    timeRemainingMs: 150_000,
    upBestBid: 0.55,
    upBestAsk: 0.6,
    downBestBid: 0.4,
    downBestAsk: 0.45,
    upSpread: 0.05,
    downSpread: 0.05,
    btcTickAgeMs: 500,
    upBookAgeMs: 800,
    downBookAgeMs: 900,
    chainlinkBinanceGapBps: 1.2,
    dataComplete: true,
    stale: false,
    ...overrides,
  };
}

function fixtureSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: null,
    ts: FIXED_TS,
    marketId: 'mkt-1',
    marketStateId: 7n,
    decision: 'BUY_UP',
    side: 'UP',
    price: 0.6,
    estimatedProbability: 0.7,
    estimatedEv: 0.1,
    accepted: true,
    rejectionReasons: [],
    features: { distanceBps: 37.17 },
    outcome: null,
    finalOutcome: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('market_states repository', () => {
  it('inserts a state and returns the BIGSERIAL id', async () => {
    const db = fakeDb([{ match: /INSERT INTO market_states/, rows: [{ id: '101' }] }]);
    const repo = createMarketStatesRepository(db);
    const id = await repo.insert(fixtureState());
    expect(id).toBe(101n);

    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO market_states');
    expect(call.text).toContain('RETURNING id');
    // ts, market_id are the first two binds.
    expect(call.params[0]).toEqual(FIXED_TS);
    expect(call.params[1]).toBe('mkt-1');
  });

  it('throws when RETURNING id row is missing', async () => {
    const db = fakeDb([{ match: /INSERT/, rows: [] }]);
    const repo = createMarketStatesRepository(db);
    await expect(repo.insert(fixtureState())).rejects.toThrow(/no id/);
  });

  it('round-trips a row from snake_case to MarketState (decoding numerics)', async () => {
    const db = fakeDb([
      {
        match: /SELECT[\s\S]*FROM market_states/,
        rows: [
          {
            id: '101',
            ts: FIXED_TS,
            market_id: 'mkt-1',
            btc_price: '67500',
            btc_source: 'rtds.chainlink',
            price_to_beat: '67250',
            distance: '250',
            distance_bps: '37.17',
            time_remaining_ms: 150_000,
            up_best_bid: '0.55',
            up_best_ask: '0.6',
            down_best_bid: '0.4',
            down_best_ask: '0.45',
            up_spread: '0.05',
            down_spread: '0.05',
            btc_tick_age_ms: 500,
            up_book_age_ms: 800,
            down_book_age_ms: 900,
            chainlink_binance_gap_bps: '1.2',
            data_complete: true,
            stale: false,
          },
        ],
      },
    ]);
    const repo = createMarketStatesRepository(db);
    const found = await repo.findById(101n);
    expect(found?.btcPrice).toBe(67_500);
    expect(found?.priceToBeat).toBe(67_250);
    expect(found?.dataComplete).toBe(true);
    expect(found?.stale).toBe(false);
  });

  it('returns null when no row found', async () => {
    const db = fakeDb();
    const repo = createMarketStatesRepository(db);
    expect(await repo.findById(999n)).toBeNull();
  });

  it('countByMarket parses count', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [{ c: '5' }] }]);
    const repo = createMarketStatesRepository(db);
    expect(await repo.countByMarket('mkt-1')).toBe(5);
  });

  it('countByMarket returns 0 when no rows', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [] }]);
    const repo = createMarketStatesRepository(db);
    expect(await repo.countByMarket('mkt-x')).toBe(0);
  });

  // v0.2.1 idempotent persisted replay tests --------------------------------
  // The `(market_id, ts)` unique index lets repeated batch runs collapse to a
  // single row instead of stacking duplicates. The repo is the seam where
  // that idempotency is observed: a fresh insert returns inserted=true with
  // the new id, a conflict returns inserted=false with the existing id.

  it('insertIfAbsent returns inserted=true on a fresh row', async () => {
    const db = fakeDb([
      { match: /INSERT INTO market_states[\s\S]*ON CONFLICT/, rows: [{ id: '202' }] },
    ]);
    const repo = createMarketStatesRepository(db);
    const result = await repo.insertIfAbsent(fixtureState());
    expect(result).toEqual({ id: 202n, inserted: true });
    // INSERT path only — no fallback SELECT issued.
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.text).toContain('ON CONFLICT (market_id, ts) DO NOTHING');
  });

  it('insertIfAbsent falls back to SELECT and returns inserted=false on conflict', async () => {
    const db = fakeDb([
      { match: /INSERT INTO market_states[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM market_states/, rows: [{ id: '101' }] },
    ]);
    const repo = createMarketStatesRepository(db);
    const result = await repo.insertIfAbsent(fixtureState());
    expect(result).toEqual({ id: 101n, inserted: false });
    expect(db.calls).toHaveLength(2);
    expect(db.calls[1]!.params).toEqual(['mkt-1', FIXED_TS]);
  });

  it('insertIfAbsent throws when ON CONFLICT hit but no existing row found (defensive)', async () => {
    const db = fakeDb([
      { match: /INSERT INTO market_states[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM market_states/, rows: [] },
    ]);
    const repo = createMarketStatesRepository(db);
    await expect(repo.insertIfAbsent(fixtureState())).rejects.toThrow(
      /conflict reported but no existing row found/
    );
  });
});

describe('signals repository', () => {
  it('inserts an accepted BUY_UP signal with empty rejectionReasons[]', async () => {
    const db = fakeDb([{ match: /INSERT INTO signals/, rows: [{ id: '7' }] }]);
    const repo = createSignalsRepository(db);
    const id = await repo.insert(fixtureSignal());
    expect(id).toBe(7n);

    const call = db.calls[0]!;
    expect(call.text).toContain('INSERT INTO signals');
    expect(call.text).toContain('RETURNING id');
    // rejection_reasons param is JSON-encoded.
    const reasonsParam = call.params[9] as string;
    expect(typeof reasonsParam).toBe('string');
    expect(JSON.parse(reasonsParam)).toEqual([]);
    // features param is JSON-encoded.
    const featuresParam = call.params[10] as string;
    expect(JSON.parse(featuresParam)).toEqual({ distanceBps: 37.17 });
  });

  it('inserts a REJECT signal with rejection reasons and features', async () => {
    const db = fakeDb([{ match: /INSERT/, rows: [{ id: '8' }] }]);
    const repo = createSignalsRepository(db);
    await repo.insert(
      fixtureSignal({
        decision: 'REJECT',
        side: null,
        price: null,
        accepted: false,
        rejectionReasons: ['NO_EDGE', 'BTC_TOO_CLOSE_TO_PRICE_TO_BEAT'],
        features: { distanceBps: 1.2 },
      })
    );
    const call = db.calls[0]!;
    expect(JSON.parse(call.params[9] as string)).toEqual([
      'NO_EDGE',
      'BTC_TOO_CLOSE_TO_PRICE_TO_BEAT',
    ]);
    // accepted bind is false.
    expect(call.params[8]).toBe(false);
  });

  it('throws when marketStateId is null', async () => {
    const db = fakeDb();
    const repo = createSignalsRepository(db);
    await expect(repo.insert(fixtureSignal({ marketStateId: null }))).rejects.toThrow(
      /marketStateId/
    );
  });

  it('throws when RETURNING id row is missing', async () => {
    const db = fakeDb([{ match: /INSERT/, rows: [] }]);
    const repo = createSignalsRepository(db);
    await expect(repo.insert(fixtureSignal())).rejects.toThrow(/no id/);
  });

  it('updateOutcome stamps WIN with finalOutcome=UP and resolvedAt', async () => {
    const db = fakeDb([{ match: /UPDATE signals/, rows: [], rowCount: 1 }]);
    const repo = createSignalsRepository(db);
    const resolvedAt = new Date('2026-04-25T12:35:00Z');
    await repo.updateOutcome(7n, 'WIN', 'UP', resolvedAt);
    const call = db.calls[0]!;
    expect(call.text).toContain('UPDATE signals');
    expect(call.params).toEqual(['7', 'WIN', 'UP', resolvedAt]);
  });

  it('updateOutcome stamps NOT_APPLICABLE with finalOutcome=null for rejected', async () => {
    const db = fakeDb([{ match: /UPDATE signals/, rows: [], rowCount: 1 }]);
    const repo = createSignalsRepository(db);
    const resolvedAt = new Date();
    await repo.updateOutcome(8n, 'NOT_APPLICABLE', null, resolvedAt);
    expect(db.calls[0]!.params).toEqual(['8', 'NOT_APPLICABLE', null, resolvedAt]);
  });

  it('updateOutcome throws when no row matches the supplied id', async () => {
    // No scripted match → rowCount defaults to 0. The repo treats that as
    // a hard error rather than a silent no-op so a stale id passed to the
    // labeler cannot leave a signal permanently unlabeled.
    const db = fakeDb();
    const repo = createSignalsRepository(db);
    await expect(
      repo.updateOutcome(999n, 'WIN', 'UP', new Date())
    ).rejects.toThrow(/no row found for id=999/);
  });

  it('round-trips findById decoding rejection_reasons + features JSON', async () => {
    const db = fakeDb([
      {
        match: /SELECT[\s\S]*FROM signals/,
        rows: [
          {
            id: '7',
            ts: FIXED_TS,
            market_id: 'mkt-1',
            market_state_id: '101',
            decision: 'BUY_UP',
            side: 'UP',
            price: '0.6',
            estimated_probability: '0.7',
            estimated_ev: '0.1',
            accepted: true,
            rejection_reasons: [],
            features: { distanceBps: 37.17 },
            outcome: null,
            final_outcome: null,
            resolved_at: null,
          },
        ],
      },
    ]);
    const repo = createSignalsRepository(db);
    const found = await repo.findById(7n);
    expect(found?.id).toBe(7n);
    expect(found?.marketStateId).toBe(101n);
    expect(found?.decision).toBe('BUY_UP');
    expect(found?.side).toBe('UP');
    expect(found?.price).toBe(0.6);
    expect(found?.rejectionReasons).toEqual([]);
    expect(found?.features).toEqual({ distanceBps: 37.17 });
  });

  it('findById tolerates malformed rejection_reasons / features payloads', async () => {
    const db = fakeDb([
      {
        match: /SELECT/,
        rows: [
          {
            id: '9',
            ts: FIXED_TS,
            market_id: 'mkt-1',
            market_state_id: '101',
            decision: 'REJECT',
            side: null,
            price: null,
            estimated_probability: null,
            estimated_ev: null,
            accepted: false,
            rejection_reasons: 'not-an-array',
            features: 'not-an-object',
            outcome: null,
            final_outcome: null,
            resolved_at: null,
          },
        ],
      },
    ]);
    const repo = createSignalsRepository(db);
    const found = await repo.findById(9n);
    expect(found?.rejectionReasons).toEqual([]);
    expect(found?.features).toEqual({});
  });

  it('returns null when not found', async () => {
    const db = fakeDb();
    const repo = createSignalsRepository(db);
    expect(await repo.findById(999n)).toBeNull();
  });

  it('throws when a row leaks a null market_state_id (defensive against schema drift)', async () => {
    const db = fakeDb([
      {
        match: /SELECT/,
        rows: [
          {
            id: '12',
            ts: FIXED_TS,
            market_id: 'mkt-1',
            // The schema declares this NOT NULL; we test the defensive
            // guard for the case a future migration leaks a null through.
            market_state_id: null,
            decision: 'REJECT',
            side: null,
            price: null,
            estimated_probability: null,
            estimated_ev: null,
            accepted: false,
            rejection_reasons: [],
            features: {},
            outcome: null,
            final_outcome: null,
            resolved_at: null,
          },
        ],
      },
    ]);
    const repo = createSignalsRepository(db);
    await expect(repo.findById(12n)).rejects.toThrow(/null market_state_id/);
  });

  it('throws when a row carries an out-of-union decision (CHECK regression)', async () => {
    const db = fakeDb([
      {
        match: /SELECT/,
        rows: [
          {
            id: '13',
            ts: FIXED_TS,
            market_id: 'mkt-1',
            market_state_id: '101',
            decision: 'buy_up', // wrong-cased value the CHECK should reject
            side: null,
            price: null,
            estimated_probability: null,
            estimated_ev: null,
            accepted: false,
            rejection_reasons: [],
            features: {},
            outcome: null,
            final_outcome: null,
            resolved_at: null,
          },
        ],
      },
    ]);
    const repo = createSignalsRepository(db);
    await expect(repo.findById(13n)).rejects.toThrow(/invalid decision/);
  });

  it('countByMarket parses count', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [{ c: '12' }] }]);
    const repo = createSignalsRepository(db);
    expect(await repo.countByMarket('mkt-1')).toBe(12);
  });

  it('countByMarket returns 0 when no rows', async () => {
    const db = fakeDb([{ match: /COUNT/, rows: [] }]);
    const repo = createSignalsRepository(db);
    expect(await repo.countByMarket('mkt-x')).toBe(0);
  });

  // v0.2.1 idempotent persisted replay tests --------------------------------
  // The `(market_state_id)` unique index enforces "at most one signal per
  // persisted state". Repeated batch runs collapse to a single signal row.

  it('insertIfAbsent returns inserted=true on a fresh row', async () => {
    const db = fakeDb([
      { match: /INSERT INTO signals[\s\S]*ON CONFLICT/, rows: [{ id: '777' }] },
    ]);
    const repo = createSignalsRepository(db);
    const result = await repo.insertIfAbsent(fixtureSignal());
    expect(result).toEqual({ id: 777n, inserted: true });
    expect(db.calls[0]!.text).toContain('ON CONFLICT (market_state_id) DO NOTHING');
  });

  it('insertIfAbsent falls back to SELECT on conflict', async () => {
    const db = fakeDb([
      { match: /INSERT INTO signals[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM signals/, rows: [{ id: '7' }] },
    ]);
    const repo = createSignalsRepository(db);
    const result = await repo.insertIfAbsent(fixtureSignal());
    expect(result).toEqual({ id: 7n, inserted: false });
    expect(db.calls[1]!.params).toEqual(['7']);
  });

  it('insertIfAbsent throws when marketStateId is null', async () => {
    const db = fakeDb();
    const repo = createSignalsRepository(db);
    await expect(
      repo.insertIfAbsent(fixtureSignal({ marketStateId: null }))
    ).rejects.toThrow(/marketStateId/);
  });

  it('insertIfAbsent throws when ON CONFLICT hit but no existing row found (defensive)', async () => {
    const db = fakeDb([
      { match: /INSERT INTO signals[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM signals/, rows: [] },
    ]);
    const repo = createSignalsRepository(db);
    await expect(repo.insertIfAbsent(fixtureSignal())).rejects.toThrow(
      /conflict reported but no existing row found/
    );
  });
});
