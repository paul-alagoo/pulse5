// Pulse5 v0.2.1 — Shadow Batch Replay tests.
//
// Focus areas (TDD per the spec's required test list):
//   - market selection / replay readiness checks (`classifyMarket`,
//     `selectMarketsInRange` SQL).
//   - no-lookahead query helpers (`latestBookByReceiveTs`, etc).
//   - batch replay determinism: re-running the same fake DB returns the
//     same report, and idempotent persistence reports the right
//     new-vs-existing split on the second run.
//   - bucket report math (`bucketEstimatedProbability`, `foldSignalIntoReport`).
//   - CLI parser (`parseBatchCliArgs`).

import { describe, it, expect } from 'vitest';
import type { QueryResultRow } from 'pg';
import type { Db, QueryResult } from '@pulse5/storage';
import type { Market, Signal } from '@pulse5/models';
import {
  bucketEstimatedProbability,
  classifyMarket,
  emptyReport,
  emptyProbabilityBuckets,
  foldSignalIntoReport,
  latestBookByReceiveTs,
  latestTickByReceiveTs,
  chainlinkTickNearestStartTime,
  notesForReport,
  parseBatchCliArgs,
  runBatchReplay,
  samplingTimestamps,
  selectMarketsInRange,
  validateBatchOptions,
  type BatchOptions,
  type SignalDensityReport,
} from './replay-batch.js';

// ---------------------------------------------------------------------------
// Test plumbing

interface ScriptedQuery {
  match: RegExp;
  rows: QueryResultRow[];
  rowCount?: number;
}

interface FakeDb extends Db {
  calls: Array<{ text: string; params: ReadonlyArray<unknown> }>;
  /** Replace the script (used to flip "fresh" → "duplicate" on rerun). */
  setScript(next: ScriptedQuery[]): void;
}

function fakeDb(initial: ScriptedQuery[] = []): FakeDb {
  let scripted = initial;
  const calls: FakeDb['calls'] = [];
  return {
    calls,
    setScript(next): void {
      scripted = next;
    },
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

const FIXED_START = new Date('2026-04-25T12:30:00Z');
const FIXED_END = new Date('2026-04-25T12:35:00Z');

function fixtureMarket(overrides: Partial<Market> = {}): Market {
  return {
    marketId: 'mkt-1',
    eventId: 'evt-1',
    slug: 'btc-updown-5m-1714000000',
    question: 'q',
    conditionId: 'cond-1',
    upTokenId: 'tok-up',
    downTokenId: 'tok-down',
    startTime: FIXED_START,
    endTime: FIXED_END,
    priceToBeat: 67_250,
    resolutionSource: 'chainlink-btc-usd',
    status: 'resolved',
    finalOutcome: 'Up',
    ...overrides,
  };
}

function fixtureSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: null,
    ts: FIXED_START,
    marketId: 'mkt-1',
    marketStateId: null,
    decision: 'BUY_UP',
    side: 'UP',
    price: 0.6,
    estimatedProbability: 0.65,
    estimatedEv: 0.05,
    accepted: true,
    rejectionReasons: [],
    features: {},
    outcome: 'WIN',
    finalOutcome: 'UP',
    resolvedAt: FIXED_END,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers

describe('samplingTimestamps', () => {
  it('produces evenly spaced timestamps inside the window', () => {
    const stamps = samplingTimestamps(fixtureMarket(), 60_000);
    // 5 min window, step 60s, exclusive of start and end → 4 samples
    expect(stamps).toHaveLength(4);
    expect(stamps[0]?.toISOString()).toBe('2026-04-25T12:31:00.000Z');
    expect(stamps[3]?.toISOString()).toBe('2026-04-25T12:34:00.000Z');
  });

  it('returns [] when end <= start', () => {
    const m = fixtureMarket({ endTime: FIXED_START });
    expect(samplingTimestamps(m, 1000)).toEqual([]);
  });

  it('throws on non-positive stepMs', () => {
    expect(() => samplingTimestamps(fixtureMarket(), 0)).toThrow(/stepMs/);
    expect(() => samplingTimestamps(fixtureMarket(), -1)).toThrow(/stepMs/);
  });

  it('is deterministic across calls (replay determinism)', () => {
    const a = samplingTimestamps(fixtureMarket(), 5000);
    const b = samplingTimestamps(fixtureMarket(), 5000);
    expect(a.map((d) => d.toISOString())).toEqual(b.map((d) => d.toISOString()));
  });
});

describe('bucketEstimatedProbability', () => {
  it('classifies the v0.2.1 buckets correctly', () => {
    expect(bucketEstimatedProbability(0.49)).toBe('below_0_50');
    expect(bucketEstimatedProbability(0.5)).toBe('bucket_0_50_to_0_60');
    expect(bucketEstimatedProbability(0.59)).toBe('bucket_0_50_to_0_60');
    expect(bucketEstimatedProbability(0.6)).toBe('bucket_0_60_to_0_70');
    expect(bucketEstimatedProbability(0.69)).toBe('bucket_0_60_to_0_70');
    expect(bucketEstimatedProbability(0.7)).toBe('bucket_0_70_to_0_80');
    expect(bucketEstimatedProbability(0.79)).toBe('bucket_0_70_to_0_80');
    expect(bucketEstimatedProbability(0.8)).toBe('bucket_0_80_and_up');
    expect(bucketEstimatedProbability(0.95)).toBe('bucket_0_80_and_up');
  });

  it('returns null for null / NaN / Infinity', () => {
    expect(bucketEstimatedProbability(null)).toBe('null');
    expect(bucketEstimatedProbability(Number.NaN)).toBe('null');
    expect(bucketEstimatedProbability(Number.POSITIVE_INFINITY)).toBe('null');
  });
});

describe('classifyMarket', () => {
  it('returns null when the market is processable', () => {
    expect(classifyMarket(fixtureMarket())).toBeNull();
  });

  it('skips unresolved markets', () => {
    expect(classifyMarket(fixtureMarket({ status: 'open' }))).toBe('NOT_RESOLVED');
  });

  it('skips markets whose final_outcome is unrecognized', () => {
    expect(classifyMarket(fixtureMarket({ finalOutcome: 'maybe' }))).toBe(
      'UNKNOWN_FINAL_OUTCOME'
    );
    expect(classifyMarket(fixtureMarket({ finalOutcome: null }))).toBe(
      'UNKNOWN_FINAL_OUTCOME'
    );
  });

  it('skips markets with missing token ids', () => {
    expect(classifyMarket(fixtureMarket({ upTokenId: '' }))).toBe('MISSING_TOKEN_IDS');
    expect(classifyMarket(fixtureMarket({ downTokenId: '' }))).toBe('MISSING_TOKEN_IDS');
  });

  it('skips markets with non-positive windows', () => {
    expect(classifyMarket(fixtureMarket({ endTime: FIXED_START }))).toBe('WINDOW_TOO_SHORT');
  });

  it('accepts Yes/No outcomes (Polymarket CLOB conventions)', () => {
    expect(classifyMarket(fixtureMarket({ finalOutcome: 'Yes' }))).toBeNull();
    expect(classifyMarket(fixtureMarket({ finalOutcome: 'No' }))).toBeNull();
  });
});

describe('foldSignalIntoReport', () => {
  it('increments counts and recomputes acceptedRate without mutating input', () => {
    const initial = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    const r1 = foldSignalIntoReport(initial, fixtureSignal());
    expect(r1.signals.total).toBe(1);
    expect(r1.signals.accepted).toBe(1);
    expect(r1.signals.acceptedRate).toBe(1);
    expect(r1.signals.decisions.BUY_UP).toBe(1);
    expect(r1.signals.estimatedProbabilityBuckets.bucket_0_60_to_0_70).toEqual({
      total: 1,
      accepted: 1,
      labeledAccepted: 1,
      win: 1,
      loss: 0,
    });
    expect(r1.signals.outcomes.WIN).toBe(1);
    // Immutability: input report is untouched.
    expect(initial.signals.total).toBe(0);
    expect(initial.signals.estimatedProbabilityBuckets.bucket_0_60_to_0_70.total).toBe(0);

    const r2 = foldSignalIntoReport(
      r1,
      fixtureSignal({
        decision: 'REJECT',
        side: null,
        price: null,
        accepted: false,
        rejectionReasons: ['NO_EDGE'],
        estimatedProbability: 0.51,
        outcome: 'NOT_APPLICABLE',
        finalOutcome: 'UP',
      })
    );
    expect(r2.signals.total).toBe(2);
    expect(r2.signals.accepted).toBe(1);
    expect(r2.signals.rejected).toBe(1);
    expect(r2.signals.acceptedRate).toBeCloseTo(0.5);
    expect(r2.signals.decisions.REJECT).toBe(1);
    expect(r2.signals.rejectionReasons.NO_EDGE).toBe(1);
    // Rejected signal lands in bucket totals but not in accepted/labeled counts.
    expect(r2.signals.estimatedProbabilityBuckets.bucket_0_50_to_0_60).toEqual({
      total: 1,
      accepted: 0,
      labeledAccepted: 0,
      win: 0,
      loss: 0,
    });
    expect(r2.signals.outcomes.NOT_APPLICABLE).toBe(1);
  });

  it('per-bucket WIN/LOSS counts only credit labeled accepted signals', () => {
    const initial = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );

    // Accepted + WIN at p=0.65.
    const r1 = foldSignalIntoReport(initial, fixtureSignal({ estimatedProbability: 0.65 }));
    // Accepted + LOSS at p=0.65.
    const r2 = foldSignalIntoReport(
      r1,
      fixtureSignal({
        decision: 'BUY_DOWN',
        side: 'DOWN',
        estimatedProbability: 0.65,
        outcome: 'LOSS',
        finalOutcome: 'UP',
      })
    );
    // Accepted but NOT_APPLICABLE (no resolved label) at p=0.65 — counts
    // toward accepted but NOT labeledAccepted.
    const r3 = foldSignalIntoReport(
      r2,
      fixtureSignal({ estimatedProbability: 0.65, outcome: 'NOT_APPLICABLE' })
    );

    const bucket = r3.signals.estimatedProbabilityBuckets.bucket_0_60_to_0_70;
    expect(bucket).toEqual({
      total: 3,
      accepted: 3,
      labeledAccepted: 2,
      win: 1,
      loss: 1,
    });
  });
});

describe('notesForReport', () => {
  it('warns on undersized buckets and always reminds shadow != live', () => {
    const r = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    const notes = notesForReport(r);
    // Critical buckets all empty → 4 sample warnings, each citing labeled
    // accepted signals (NOT mixed accept/reject totals).
    const bucketWarnings = notes.filter((n) => n.includes('labeled accepted signals (< 30)'));
    expect(bucketWarnings).toHaveLength(4);
    expect(notes.some((n) => /shadow EV is NOT executable EV/i.test(n))).toBe(true);
  });

  it('gates buckets on labeledAccepted, not on mixed accept/reject totals', () => {
    // Build a finalized report whose 0.60<=p<0.70 bucket has tons of
    // rejected signals but ZERO labeled accepted: it must still warn.
    const r = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    const inflated: SignalDensityReport = {
      ...r,
      signals: {
        ...r.signals,
        total: 1000,
        accepted: 0,
        rejected: 1000,
        acceptedRate: 0,
        estimatedProbabilityBuckets: {
          ...r.signals.estimatedProbabilityBuckets,
          bucket_0_60_to_0_70: {
            total: 1000,
            accepted: 0,
            labeledAccepted: 0,
            win: 0,
            loss: 0,
          },
        },
      },
    };
    const notes = notesForReport(inflated);
    expect(
      notes.some((n) =>
        /Bucket 0\.60<=p<0\.70 has 0 labeled accepted signals/.test(n)
      )
    ).toBe(true);
  });

  it('does NOT warn when a bucket has >=30 labeled accepted signals', () => {
    const r = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    const filled: SignalDensityReport = {
      ...r,
      signals: {
        ...r.signals,
        total: 50,
        accepted: 50,
        rejected: 0,
        acceptedRate: 1,
        outcomes: { WIN: 25, LOSS: 25, NOT_APPLICABLE: 0 },
        estimatedProbabilityBuckets: {
          ...r.signals.estimatedProbabilityBuckets,
          bucket_0_60_to_0_70: {
            total: 50,
            accepted: 50,
            labeledAccepted: 50,
            win: 25,
            loss: 25,
          },
        },
      },
    };
    const notes = notesForReport(filled);
    expect(notes.some((n) => /Bucket 0\.60<=p<0\.70/.test(n))).toBe(false);
  });

  it('warns when accept-rate is < 0.1%', () => {
    const r = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    const r2 = {
      ...r,
      signals: {
        ...r.signals,
        total: 10_000,
        accepted: 0,
        rejected: 10_000,
        acceptedRate: 0,
      },
    };
    expect(notesForReport(r2).some((n) => /Accepted-signal rate/.test(n))).toBe(true);
  });
});

describe('emptyProbabilityBuckets', () => {
  it('returns all-zero per-bucket counters', () => {
    const zero = { total: 0, accepted: 0, labeledAccepted: 0, win: 0, loss: 0 };
    expect(emptyProbabilityBuckets()).toEqual({
      below_0_50: zero,
      bucket_0_50_to_0_60: zero,
      bucket_0_60_to_0_70: zero,
      bucket_0_70_to_0_80: zero,
      bucket_0_80_and_up: zero,
      null: zero,
    });
  });
});

// ---------------------------------------------------------------------------
// CLI parser

describe('parseBatchCliArgs', () => {
  it('parses --from, --to, --limit, --step-ms, defaults to dry-run', () => {
    const args = parseBatchCliArgs([
      '--from=2026-04-20T00:00:00Z',
      '--to=2026-04-27T00:00:00Z',
      '--limit=200',
      '--step-ms=10000',
    ]);
    expect(args.from.toISOString()).toBe('2026-04-20T00:00:00.000Z');
    expect(args.to.toISOString()).toBe('2026-04-27T00:00:00.000Z');
    expect(args.limit).toBe(200);
    expect(args.stepMs).toBe(10_000);
    expect(args.dryRun).toBe(true);
    expect(args.persist).toBe(false);
    expect(args.reportPath).toBeUndefined();
  });

  it('--persist switches off dry-run', () => {
    const args = parseBatchCliArgs([
      '--from=2026-04-20T00:00:00Z',
      '--to=2026-04-27T00:00:00Z',
      '--persist',
    ]);
    expect(args.dryRun).toBe(false);
    expect(args.persist).toBe(true);
  });

  it('--persist + --dry-run is rejected', () => {
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-20T00:00:00Z',
        '--to=2026-04-27T00:00:00Z',
        '--persist',
        '--dry-run',
      ])
    ).toThrow(/mutually exclusive/);
  });

  it('rejects invalid --step-ms (too small / non-int)', () => {
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-20T00:00:00Z',
        '--to=2026-04-27T00:00:00Z',
        '--step-ms=10',
      ])
    ).toThrow(/step-ms/);
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-20T00:00:00Z',
        '--to=2026-04-27T00:00:00Z',
        '--step-ms=1.5',
      ])
    ).toThrow(/step-ms/);
  });

  it('rejects invalid --step-ms (too large)', () => {
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-20T00:00:00Z',
        '--to=2026-04-27T00:00:00Z',
        '--step-ms=999999',
      ])
    ).toThrow(/step-ms/);
  });

  it('rejects --from > --to', () => {
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-27T00:00:00Z',
        '--to=2026-04-20T00:00:00Z',
      ])
    ).toThrow(/--from must be <= --to/);
  });

  it('rejects invalid --limit', () => {
    expect(() =>
      parseBatchCliArgs([
        '--from=2026-04-20T00:00:00Z',
        '--to=2026-04-27T00:00:00Z',
        '--limit=0',
      ])
    ).toThrow(/limit/);
  });

  it('rejects missing --from / --to', () => {
    expect(() => parseBatchCliArgs([])).toThrow(/required/);
  });

  it('rejects invalid date strings', () => {
    expect(() =>
      parseBatchCliArgs(['--from=not-a-date', '--to=2026-04-27T00:00:00Z'])
    ).toThrow(/invalid --from/);
    expect(() =>
      parseBatchCliArgs(['--from=2026-04-20T00:00:00Z', '--to=garbage'])
    ).toThrow(/invalid --to/);
  });

  it('captures --report path', () => {
    const args = parseBatchCliArgs([
      '--from=2026-04-20T00:00:00Z',
      '--to=2026-04-27T00:00:00Z',
      '--report=research/reports/density.json',
    ]);
    expect(args.reportPath).toBe('research/reports/density.json');
  });

  it('--no-dry-run is ignored; persistence still requires --persist', () => {
    const args = parseBatchCliArgs([
      '--from=2026-04-20T00:00:00Z',
      '--to=2026-04-27T00:00:00Z',
      '--no-dry-run',
    ]);
    expect(args.dryRun).toBe(true);
    expect(args.persist).toBe(false);
  });

  it('ignores positional / non-flag arguments without crashing', () => {
    const args = parseBatchCliArgs([
      'positional',
      '--from=2026-04-20T00:00:00Z',
      '--to=2026-04-27T00:00:00Z',
    ]);
    expect(args.from).toBeInstanceOf(Date);
  });
});

describe('validateBatchOptions', () => {
  function opt(overrides: Partial<BatchOptions> = {}): BatchOptions {
    return {
      from: FIXED_START,
      to: FIXED_END,
      limit: null,
      stepMs: 5000,
      dryRun: true,
      persist: false,
      ...overrides,
    };
  }

  it('accepts valid options', () => {
    expect(() => validateBatchOptions(opt())).not.toThrow();
  });

  it('rejects from > to', () => {
    expect(() => validateBatchOptions(opt({ from: FIXED_END, to: FIXED_START }))).toThrow();
  });

  it('rejects invalid limit', () => {
    expect(() => validateBatchOptions(opt({ limit: 0 }))).toThrow();
    expect(() => validateBatchOptions(opt({ limit: -1 }))).toThrow();
  });

  it('rejects out-of-range stepMs', () => {
    expect(() => validateBatchOptions(opt({ stepMs: 50 }))).toThrow();
    expect(() => validateBatchOptions(opt({ stepMs: 999_999 }))).toThrow();
  });

  it('rejects persist + dryRun = true', () => {
    expect(() => validateBatchOptions(opt({ persist: true, dryRun: true }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// No-lookahead query helpers (mirror replay-market.ts but inside replay-batch)

describe('latestBookByReceiveTs (no-lookahead)', () => {
  it('binds market_id, token_id, target and filters on receive_ts <= $3', async () => {
    const db = fakeDb();
    await latestBookByReceiveTs(db, 'mkt-1', 'tok-up', FIXED_END);
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0]!.text).toMatch(/receive_ts\s*<=\s*\$3/);
    expect(db.calls[0]!.params).toEqual(['mkt-1', 'tok-up', FIXED_END]);
  });

  it('returns null when no row visible at target', async () => {
    const db = fakeDb([{ match: /SELECT[\s\S]*book_snapshots/, rows: [] }]);
    expect(await latestBookByReceiveTs(db, 'mkt-1', 'tok-up', FIXED_END)).toBeNull();
  });

  it('decodes the row into BookSnapshot', async () => {
    const db = fakeDb([
      {
        match: /SELECT[\s\S]*book_snapshots/,
        rows: [
          {
            ts: FIXED_START,
            receive_ts: FIXED_START,
            market_id: 'mkt-1',
            token_id: 'tok-up',
            best_bid: '0.55',
            best_ask: '0.60',
            bid_size: '100',
            ask_size: '200',
            spread: '0.05',
            raw_event_id: '42',
          },
        ],
      },
    ]);
    const got = await latestBookByReceiveTs(db, 'mkt-1', 'tok-up', FIXED_END);
    expect(got?.bestBid).toBe(0.55);
    expect(got?.rawEventId).toBe(42n);
  });
});

describe('latestTickByReceiveTs (no-lookahead)', () => {
  it('binds source + target and filters on receive_ts <= $2', async () => {
    const db = fakeDb();
    await latestTickByReceiveTs(db, 'rtds.chainlink', FIXED_END);
    expect(db.calls[0]!.text).toMatch(/receive_ts\s*<=\s*\$2/);
    expect(db.calls[0]!.params).toEqual(['rtds.chainlink', FIXED_END]);
  });

  it('returns null when no row visible at target', async () => {
    const db = fakeDb([{ match: /btc_ticks/, rows: [] }]);
    expect(await latestTickByReceiveTs(db, 'rtds.binance', FIXED_END)).toBeNull();
  });
});

describe('chainlinkTickNearestStartTime (no-lookahead price_to_beat fallback)', () => {
  it('filters on receive_ts <= $2 and re-checks tolerance', async () => {
    const db = fakeDb([
      {
        match: /btc_ticks/,
        rows: [
          {
            ts: FIXED_START,
            receive_ts: FIXED_START,
            source: 'rtds.chainlink',
            symbol: 'btc/usd',
            price: '67250',
            latency_ms: 10,
            raw_event_id: null,
          },
        ],
      },
    ]);
    const got = await chainlinkTickNearestStartTime(db, FIXED_START, 10_000, FIXED_END);
    expect(db.calls[0]!.text).toMatch(/receive_ts\s*<=\s*\$2/);
    expect(got?.price).toBe(67_250);
  });

  it('returns null when DB returns nothing (no ticks visible)', async () => {
    const db = fakeDb();
    expect(await chainlinkTickNearestStartTime(db, FIXED_START, 10_000, FIXED_END)).toBeNull();
  });

  it('rejects rows whose ts proximity exceeds tolerance', async () => {
    const farTs = new Date(FIXED_START.getTime() + 30_000); // 30s away
    const db = fakeDb([
      {
        match: /btc_ticks/,
        rows: [
          {
            ts: farTs,
            receive_ts: farTs,
            source: 'rtds.chainlink',
            symbol: 'btc/usd',
            price: '67250',
            latency_ms: null,
            raw_event_id: null,
          },
        ],
      },
    ]);
    const got = await chainlinkTickNearestStartTime(db, FIXED_START, 10_000, FIXED_END);
    expect(got).toBeNull();
  });
});

describe('selectMarketsInRange', () => {
  it('binds from/to and orders ascending; no LIMIT when limit=null', async () => {
    const db = fakeDb();
    await selectMarketsInRange(db, { from: FIXED_START, to: FIXED_END, limit: null });
    expect(db.calls[0]!.text).toMatch(/end_time >= \$1/);
    expect(db.calls[0]!.text).toMatch(/end_time <= \$2/);
    expect(db.calls[0]!.text).toMatch(/ORDER BY end_time ASC/);
    expect(db.calls[0]!.text).not.toMatch(/LIMIT/);
    expect(db.calls[0]!.params).toEqual([FIXED_START, FIXED_END]);
  });

  it('appends LIMIT $3 when limit set', async () => {
    const db = fakeDb();
    await selectMarketsInRange(db, { from: FIXED_START, to: FIXED_END, limit: 5 });
    expect(db.calls[0]!.text).toMatch(/LIMIT \$3/);
    expect(db.calls[0]!.params).toEqual([FIXED_START, FIXED_END, 5]);
  });
});

// ---------------------------------------------------------------------------
// runBatchReplay end-to-end (with fake DB)

/**
 * Build a minimal scripted DB capable of answering every query the batch
 * issues for ONE market with all data present and aligned. Markets list
 * always returns a single resolved market; book and tick queries return
 * fixed rows at receive_ts = FIXED_START so the no-lookahead filter passes
 * for any target inside the window.
 */
function happyPathDb(): FakeDb {
  const marketRow: QueryResultRow = {
    market_id: 'mkt-1',
    event_id: 'evt-1',
    slug: 'btc-updown-5m-1',
    question: 'q',
    condition_id: 'cond-1',
    up_token_id: 'tok-up',
    down_token_id: 'tok-down',
    start_time: FIXED_START,
    end_time: FIXED_END,
    price_to_beat: '67250',
    resolution_source: 'chainlink-btc-usd',
    status: 'resolved',
    final_outcome: 'Up',
  };
  const bookRow = (token: string): QueryResultRow => ({
    ts: FIXED_START,
    receive_ts: FIXED_START,
    market_id: 'mkt-1',
    token_id: token,
    best_bid: '0.50',
    best_ask: '0.55',
    bid_size: '100',
    ask_size: '100',
    spread: '0.05',
    raw_event_id: '1',
  });
  const tickRow = (source: 'rtds.chainlink' | 'rtds.binance', price: string): QueryResultRow => ({
    ts: FIXED_START,
    receive_ts: FIXED_START,
    source,
    symbol: source === 'rtds.chainlink' ? 'btc/usd' : 'btcusdt',
    price,
    latency_ms: 5,
    raw_event_id: '2',
  });

  // The runtime queries are all SELECT/INSERT — book queries bind tok-up /
  // tok-down so we discriminate by params, but our fakeDb script matches by
  // SQL text only. That's fine: same row shape works for both tokens (the
  // book builder doesn't read token_id anyway).
  return fakeDb([
    { match: /FROM markets/, rows: [marketRow] },
    { match: /FROM book_snapshots/, rows: [bookRow('tok-up')] },
    {
      match: /FROM btc_ticks[\s\S]*WHERE source = \$1/,
      rows: [tickRow('rtds.chainlink', '67500')],
    },
  ]);
}

describe('runBatchReplay (end-to-end)', () => {
  it('produces a deterministic report on dry-run (re-running yields the same totals)', async () => {
    const db1 = happyPathDb();
    const opts: BatchOptions = {
      from: FIXED_START,
      to: FIXED_END,
      limit: 10,
      stepMs: 60_000, // 4 samples in a 5-min market
      dryRun: true,
      persist: false,
    };
    const r1 = await runBatchReplay({ db: db1, now: () => FIXED_START }, opts);
    const db2 = happyPathDb();
    const r2 = await runBatchReplay({ db: db2, now: () => FIXED_START }, opts);

    expect(r1.markets.observed).toBe(1);
    expect(r1.markets.replayReady).toBe(1);
    expect(r1.signals.total).toBe(4);
    // Determinism: every count must match between the two runs.
    expect(r1.markets).toEqual(r2.markets);
    expect(r1.states).toEqual(r2.states);
    expect(r1.signals).toEqual(r2.signals);
    // Dry run must not have called either INSERT INTO market_states / signals.
    expect(db1.calls.some((c) => /INSERT INTO market_states/.test(c.text))).toBe(false);
    expect(db1.calls.some((c) => /INSERT INTO signals/.test(c.text))).toBe(false);
  });

  it('counts skipped markets with the right skipReason', async () => {
    const db = fakeDb([
      {
        match: /FROM markets/,
        rows: [
          {
            market_id: 'mkt-1',
            event_id: 'evt-1',
            slug: 's',
            question: 'q',
            condition_id: null,
            up_token_id: 'tok-up',
            down_token_id: 'tok-down',
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
    const r = await runBatchReplay(
      { db, now: () => FIXED_START },
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 60_000,
        dryRun: true,
        persist: false,
      }
    );
    expect(r.markets.observed).toBe(1);
    expect(r.markets.skipped).toBe(1);
    expect(r.markets.skipReasons.NOT_RESOLVED).toBe(1);
    expect(r.markets.replayReady).toBe(0);
    expect(r.signals.total).toBe(0);
  });

  it('persisted run reports inserted=true on first run; second run dedupes', async () => {
    // First run: every INSERT returns a fresh id.
    const db = happyPathDb();
    db.setScript([
      { match: /FROM markets/, rows: [
        {
          market_id: 'mkt-1',
          event_id: 'evt-1',
          slug: 'btc-updown-5m-1',
          question: 'q',
          condition_id: 'cond-1',
          up_token_id: 'tok-up',
          down_token_id: 'tok-down',
          start_time: FIXED_START,
          end_time: FIXED_END,
          price_to_beat: '67250',
          resolution_source: 'chainlink-btc-usd',
          status: 'resolved',
          final_outcome: 'Up',
        },
      ] },
      { match: /FROM book_snapshots/, rows: [
        {
          ts: FIXED_START,
          receive_ts: FIXED_START,
          market_id: 'mkt-1',
          token_id: 'tok-up',
          best_bid: '0.50',
          best_ask: '0.55',
          bid_size: '100',
          ask_size: '100',
          spread: '0.05',
          raw_event_id: '1',
        },
      ] },
      { match: /FROM btc_ticks[\s\S]*WHERE source = \$1/, rows: [
        {
          ts: FIXED_START,
          receive_ts: FIXED_START,
          source: 'rtds.chainlink',
          symbol: 'btc/usd',
          price: '67500',
          latency_ms: 5,
          raw_event_id: '2',
        },
      ] },
      // Both INSERTs return a fresh id.
      { match: /INSERT INTO market_states/, rows: [{ id: '1001' }] },
      { match: /INSERT INTO signals/, rows: [{ id: '2001' }] },
    ]);
    const opts: BatchOptions = {
      from: FIXED_START,
      to: FIXED_END,
      limit: null,
      stepMs: 60_000, // 4 samples
      dryRun: false,
      persist: true,
    };
    const r1 = await runBatchReplay({ db, now: () => FIXED_START }, opts);
    expect(r1.states.persistedNew).toBe(4);
    expect(r1.states.persistedExisting).toBe(0);

    // Simulated re-run: every INSERT now hits the unique index (rows: [])
    // and the SELECT id fallback returns the existing id.
    const db2 = fakeDb([
      { match: /FROM markets/, rows: [
        {
          market_id: 'mkt-1',
          event_id: 'evt-1',
          slug: 'btc-updown-5m-1',
          question: 'q',
          condition_id: 'cond-1',
          up_token_id: 'tok-up',
          down_token_id: 'tok-down',
          start_time: FIXED_START,
          end_time: FIXED_END,
          price_to_beat: '67250',
          resolution_source: 'chainlink-btc-usd',
          status: 'resolved',
          final_outcome: 'Up',
        },
      ] },
      { match: /FROM book_snapshots/, rows: [
        {
          ts: FIXED_START,
          receive_ts: FIXED_START,
          market_id: 'mkt-1',
          token_id: 'tok-up',
          best_bid: '0.50',
          best_ask: '0.55',
          bid_size: '100',
          ask_size: '100',
          spread: '0.05',
          raw_event_id: '1',
        },
      ] },
      { match: /FROM btc_ticks[\s\S]*WHERE source = \$1/, rows: [
        {
          ts: FIXED_START,
          receive_ts: FIXED_START,
          source: 'rtds.chainlink',
          symbol: 'btc/usd',
          price: '67500',
          latency_ms: 5,
          raw_event_id: '2',
        },
      ] },
      // ON CONFLICT DO NOTHING returns 0 rows; fallback SELECTs return existing ids.
      { match: /INSERT INTO market_states[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM market_states/, rows: [{ id: '1001' }] },
      { match: /INSERT INTO signals[\s\S]*ON CONFLICT/, rows: [] },
      { match: /SELECT id FROM signals/, rows: [{ id: '2001' }] },
    ]);
    const r2 = await runBatchReplay({ db: db2, now: () => FIXED_START }, opts);
    expect(r2.states.persistedNew).toBe(0);
    expect(r2.states.persistedExisting).toBe(4);
  });

  it('signal totals match states totals (one signal per state)', async () => {
    const db = happyPathDb();
    const r = await runBatchReplay(
      { db, now: () => FIXED_START },
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 60_000,
        dryRun: true,
        persist: false,
      }
    );
    expect(r.states.built).toBe(r.signals.total);
  });

  it('appends a notes section', async () => {
    const db = happyPathDb();
    const r = await runBatchReplay(
      { db, now: () => FIXED_START },
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 60_000,
        dryRun: true,
        persist: false,
      }
    );
    expect(r.notes.length).toBeGreaterThan(0);
    expect(r.notes.some((n) => /shadow EV is NOT executable EV/i.test(n))).toBe(true);
  });
});

describe('SignalDensityReport shape', () => {
  it('starts with all-zero numeric fields', () => {
    const r: SignalDensityReport = emptyReport(
      {
        from: FIXED_START,
        to: FIXED_END,
        limit: null,
        stepMs: 5000,
        dryRun: true,
        persist: false,
      },
      FIXED_START
    );
    expect(r.signals.total).toBe(0);
    expect(r.signals.acceptedRate).toBe(0);
    expect(r.markets.observed).toBe(0);
    expect(r.config.persist).toBe(false);
  });
});
