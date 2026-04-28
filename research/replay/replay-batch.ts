// Pulse5 v0.2.1 — Shadow Batch Replay.
//
// Walks N resolved BTC 5-minute Up/Down markets through the SAME pure
// `@pulse5/strategy` code path that `replay-market.ts` uses for a single
// market. Produces a `SignalDensityReport` so the v0.3 paper-simulator
// decision can be made on real measured shadow signal density rather than
// a guess.
//
// SAFETY (v0.2.1 still applies):
//   - This module READS from `markets`, `book_snapshots`, `btc_ticks` and
//     OPTIONALLY WRITES to the v0.2 analytical tables (`market_states`,
//     `signals`). It does NOT place orders, sign transactions, hold a
//     wallet, or perform paper / live trading. There are no `orders`,
//     `simulated_orders`, `fills`, `positions`, `executions`, wallets,
//     signers, or private-key surfaces in this file or anywhere in v0.2.1.
//   - The state builder + signal engine never read `markets.final_outcome` /
//     `markets.status`. Only the outcome labeler does, and only after the
//     underlying market has resolved (the same contract as v0.2).
//   - Replay obeys the no-lookahead rule (§8a in `research/replay/README.md`):
//     every input is filtered by `receive_ts <= targetTimestamp`.
//
// USAGE:
//   pnpm -r build
//   npx tsx research/replay/replay-batch.ts \
//       --from=2026-04-20T00:00:00Z \
//       --to=2026-04-27T00:00:00Z \
//       --limit=200 \
//       --step-ms=5000 \
//       --dry-run \
//       --report=research/reports/v0.2.1-density.json
//
// Default behaviour is DRY-RUN. Pass `--persist` to write `market_states`
// + `signals` rows. Persisted runs are idempotent: the
// v0.2.1 unique indexes on `(market_id, ts)` and `(market_state_id)`
// collapse repeated runs to a single row each.

import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createDb,
  createMarketsRepository,
  createMarketStatesRepository,
  createSignalsRepository,
  type Db,
} from '@pulse5/storage';
import type { BookSnapshot, BtcTick, Market, Signal, SignalRejectionReason } from '@pulse5/models';
import {
  DEFAULT_SIGNAL_ENGINE_VERSION,
  DEFAULT_STRATEGY_CONFIG,
  buildMarketState,
  generateSignal,
  generateSignalV022,
  isSignalEngineVersion,
  labelSignalOutcome,
  normalizeFinalOutcome,
  type SignalEngineVersion,
  type StrategyConfig,
} from '@pulse5/strategy';

/**
 * Visible-tick window used to feed the v0.2.2 estimator. Same value as
 * `VOLATILITY_WINDOW_MS` in @pulse5/strategy; duplicated here to avoid
 * leaking strategy internals through the public API surface.
 */
const V022_VISIBLE_TICK_WINDOW_MS = 180_000;

// ---------------------------------------------------------------------------
// Public types

export type SkipReason =
  | 'NOT_RESOLVED'
  | 'UNKNOWN_FINAL_OUTCOME'
  | 'MISSING_TOKEN_IDS'
  | 'WINDOW_TOO_SHORT';

export interface BatchOptions {
  /** Inclusive lower bound on `markets.end_time`. */
  from: Date;
  /** Inclusive upper bound on `markets.end_time`. */
  to: Date;
  /** Max number of markets to process. `null` = unlimited. */
  limit: number | null;
  /** Replay sampling cadence in ms. */
  stepMs: number;
  /** When true, no `market_states`/`signals` writes occur. */
  dryRun: boolean;
  /** When true, persist `market_states` + `signals` via `insertIfAbsent`. */
  persist: boolean;
  /** Optional path for the generated JSON signal-density report. */
  reportPath?: string;
  /**
   * Which signal-engine version to score with. Default is `v0.2.1`.
   * v0.2.2 is read-only / dry-run only in v0.2.3 — multi-version
   * persistence is intentionally NOT wired up here.
   */
  signalEngineVersion: SignalEngineVersion;
}

/**
 * Per-bucket counters. The v0.2.1 sample-size gate tests whether each
 * `p_win` bucket has enough *labeled accepted* signals to be informative,
 * not just enough mixed accept/reject totals. We track all four numbers so
 * the report shows what was discarded vs. what counts toward calibration.
 */
export interface ProbabilityBucketCounts {
  /** All signals (accepted + rejected) that landed in this bucket. */
  total: number;
  /** Accepted signals (BUY_UP / BUY_DOWN) in this bucket. */
  accepted: number;
  /** Accepted signals that were labeled WIN or LOSS. */
  labeledAccepted: number;
  /** Accepted + labeled WIN in this bucket. */
  win: number;
  /** Accepted + labeled LOSS in this bucket. */
  loss: number;
}

export interface ProbabilityBuckets {
  /** Estimated probability in [0, 0.50). */
  below_0_50: ProbabilityBucketCounts;
  /** 0.50 <= p < 0.60. */
  bucket_0_50_to_0_60: ProbabilityBucketCounts;
  /** 0.60 <= p < 0.70. */
  bucket_0_60_to_0_70: ProbabilityBucketCounts;
  /** 0.70 <= p < 0.80. */
  bucket_0_70_to_0_80: ProbabilityBucketCounts;
  /** p >= 0.80. */
  bucket_0_80_and_up: ProbabilityBucketCounts;
  /** Signal had no estimated probability (rare — usually missing data). */
  null: ProbabilityBucketCounts;
}

export interface SignalDensityReport {
  generatedAt: string;
  config: {
    from: string;
    to: string;
    limit: number | null;
    stepMs: number;
    dryRun: boolean;
    persist: boolean;
    /**
     * Which signal-engine version produced this report. Recorded so a
     * consumer reading the JSON can never misattribute a v0.2.2 result
     * to v0.2.1 or vice versa. Frozen by design-note §11 / scope §1.
     */
    signalEngineVersion: SignalEngineVersion;
  };
  markets: {
    observed: number;
    replayReady: number;
    skipped: number;
    skipReasons: Record<SkipReason, number>;
  };
  states: {
    built: number;
    persistedNew: number;
    persistedExisting: number;
  };
  signals: {
    total: number;
    accepted: number;
    rejected: number;
    acceptedRate: number;
    decisions: { BUY_UP: number; BUY_DOWN: number; REJECT: number };
    rejectionReasons: Record<SignalRejectionReason, number>;
    estimatedProbabilityBuckets: ProbabilityBuckets;
    outcomes: { WIN: number; LOSS: number; NOT_APPLICABLE: number };
  };
  notes: string[];
}

// ---------------------------------------------------------------------------
// Pure helpers (testable without a DB)

const MIN_SAFE_STEP_MS = 100;
const MAX_SAFE_STEP_MS = 5 * 60_000; // 5 min — entire BTC 5m window
const DEFAULT_STEP_MS = 5_000;

const ALL_REJECTION_REASONS: SignalRejectionReason[] = [
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
];

const ALL_SKIP_REASONS: SkipReason[] = [
  'NOT_RESOLVED',
  'UNKNOWN_FINAL_OUTCOME',
  'MISSING_TOKEN_IDS',
  'WINDOW_TOO_SHORT',
];

/**
 * Generate the deterministic list of replay timestamps for a single market.
 * Starts at `market.startTime + stepMs`, advances by `stepMs`, stops one
 * `stepMs` short of `market.endTime` so we never sample the resolution
 * boundary itself. Pure.
 */
export function samplingTimestamps(market: Market, stepMs: number): Date[] {
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new Error(`samplingTimestamps: stepMs must be > 0, got ${stepMs}`);
  }
  const startMs = market.startTime.getTime();
  const endMs = market.endTime.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
    return [];
  }
  const timestamps: Date[] = [];
  for (let t = startMs + stepMs; t < endMs; t += stepMs) {
    timestamps.push(new Date(t));
  }
  return timestamps;
}

/**
 * Bucket an estimated probability into the v0.2.1 report buckets. `null` is
 * preserved (the signal had no usable probability — typically because the
 * state had missing / stale inputs). Pure.
 */
export function bucketEstimatedProbability(p: number | null): keyof ProbabilityBuckets {
  if (p === null || !Number.isFinite(p)) return 'null';
  if (p < 0.5) return 'below_0_50';
  if (p < 0.6) return 'bucket_0_50_to_0_60';
  if (p < 0.7) return 'bucket_0_60_to_0_70';
  if (p < 0.8) return 'bucket_0_70_to_0_80';
  return 'bucket_0_80_and_up';
}

/** Build an empty per-bucket counter record. Pure. */
export function emptyProbabilityBucketCounts(): ProbabilityBucketCounts {
  return { total: 0, accepted: 0, labeledAccepted: 0, win: 0, loss: 0 };
}

/** Build an empty buckets record. Pure. */
export function emptyProbabilityBuckets(): ProbabilityBuckets {
  return {
    below_0_50: emptyProbabilityBucketCounts(),
    bucket_0_50_to_0_60: emptyProbabilityBucketCounts(),
    bucket_0_60_to_0_70: emptyProbabilityBucketCounts(),
    bucket_0_70_to_0_80: emptyProbabilityBucketCounts(),
    bucket_0_80_and_up: emptyProbabilityBucketCounts(),
    null: emptyProbabilityBucketCounts(),
  };
}

function emptyRejectionReasons(): Record<SignalRejectionReason, number> {
  const out = {} as Record<SignalRejectionReason, number>;
  for (const r of ALL_REJECTION_REASONS) out[r] = 0;
  return out;
}

function emptySkipReasons(): Record<SkipReason, number> {
  const out = {} as Record<SkipReason, number>;
  for (const r of ALL_SKIP_REASONS) out[r] = 0;
  return out;
}

/**
 * Builds a fresh, empty report shell. Used by both the runner (it folds
 * results into this) and tests (so the report shape stays stable). Pure.
 */
export function emptyReport(config: BatchOptions, generatedAt: Date): SignalDensityReport {
  return {
    generatedAt: generatedAt.toISOString(),
    config: {
      from: config.from.toISOString(),
      to: config.to.toISOString(),
      limit: config.limit,
      stepMs: config.stepMs,
      dryRun: config.dryRun,
      persist: config.persist,
      signalEngineVersion: config.signalEngineVersion,
    },
    markets: {
      observed: 0,
      replayReady: 0,
      skipped: 0,
      skipReasons: emptySkipReasons(),
    },
    states: { built: 0, persistedNew: 0, persistedExisting: 0 },
    signals: {
      total: 0,
      accepted: 0,
      rejected: 0,
      acceptedRate: 0,
      decisions: { BUY_UP: 0, BUY_DOWN: 0, REJECT: 0 },
      rejectionReasons: emptyRejectionReasons(),
      estimatedProbabilityBuckets: emptyProbabilityBuckets(),
      outcomes: { WIN: 0, LOSS: 0, NOT_APPLICABLE: 0 },
    },
    notes: [],
  };
}

const MIN_BUCKET_SAMPLE_FOR_INFORMATIVE = 30;

/**
 * Append narrative notes the v0.2.1 spec requires — specifically, when key
 * `p_win` buckets have fewer than 30 labeled accepted signals. Pure: takes
 * the report (treated as finalized) and returns the notes.
 *
 * The sample-size gate is per-bucket and based on **labeled accepted**
 * signals (WIN + LOSS in that bucket). Mixed accept/reject totals are not
 * the calibration unit and do not count toward the gate.
 */
export function notesForReport(report: SignalDensityReport): string[] {
  const buckets = report.signals.estimatedProbabilityBuckets;
  const totalLabeledAccepted =
    report.signals.outcomes.WIN + report.signals.outcomes.LOSS;
  const notes: string[] = [];

  // Accepted-rate floor.
  if (report.signals.total === 0) {
    notes.push('No signals were generated — verify the input range has captured data.');
  } else if (report.signals.acceptedRate < 0.001) {
    notes.push(
      'Accepted-signal rate < 0.1% — collect more data or revisit signal-engine thresholds.'
    );
  }

  // Per-bucket warnings — based on labeled accepted (WIN + LOSS) per
  // bucket, which is the v0.4 calibration unit. A bucket with <30 labeled
  // accepted signals cannot calibrate p_win in that range, regardless of
  // how many rejects landed there.
  const keyBuckets: Array<[keyof ProbabilityBuckets, string]> = [
    ['bucket_0_50_to_0_60', '0.50<=p<0.60'],
    ['bucket_0_60_to_0_70', '0.60<=p<0.70'],
    ['bucket_0_70_to_0_80', '0.70<=p<0.80'],
    ['bucket_0_80_and_up', 'p>=0.80'],
  ];
  for (const [key, label] of keyBuckets) {
    const counts = buckets[key];
    if (counts.labeledAccepted < MIN_BUCKET_SAMPLE_FOR_INFORMATIVE) {
      notes.push(
        `Bucket ${label} has ${counts.labeledAccepted} labeled accepted signals (< ${MIN_BUCKET_SAMPLE_FOR_INFORMATIVE}); not yet informative.`
      );
    }
  }
  if (
    totalLabeledAccepted > 0 &&
    totalLabeledAccepted < MIN_BUCKET_SAMPLE_FOR_INFORMATIVE
  ) {
    notes.push(
      `Total labeled accepted signals (WIN+LOSS) = ${totalLabeledAccepted} (< ${MIN_BUCKET_SAMPLE_FOR_INFORMATIVE}); replay window too small to trust per-bucket numbers.`
    );
  }

  notes.push(
    'v0.2.1 measures shadow signal density only. Shadow EV is NOT executable EV — do not promote to live trading from this report.'
  );

  return notes;
}

/**
 * Fold a single signal's contribution into the running report. Returns a
 * NEW report (no mutation) so determinism across re-runs is preserved.
 */
export function foldSignalIntoReport(
  report: SignalDensityReport,
  signal: Signal
): SignalDensityReport {
  const decisions = { ...report.signals.decisions };
  decisions[signal.decision] += 1;

  const rejectionReasons = { ...report.signals.rejectionReasons };
  for (const r of signal.rejectionReasons) {
    rejectionReasons[r] = (rejectionReasons[r] ?? 0) + 1;
  }

  const buckets = { ...report.signals.estimatedProbabilityBuckets };
  const bucketKey = bucketEstimatedProbability(signal.estimatedProbability);
  const prevBucket = buckets[bucketKey];
  const isWin = signal.outcome === 'WIN';
  const isLoss = signal.outcome === 'LOSS';
  const isLabeledAccepted = signal.accepted && (isWin || isLoss);
  buckets[bucketKey] = {
    total: prevBucket.total + 1,
    accepted: prevBucket.accepted + (signal.accepted ? 1 : 0),
    labeledAccepted: prevBucket.labeledAccepted + (isLabeledAccepted ? 1 : 0),
    win: prevBucket.win + (isLabeledAccepted && isWin ? 1 : 0),
    loss: prevBucket.loss + (isLabeledAccepted && isLoss ? 1 : 0),
  };

  const outcomes = { ...report.signals.outcomes };
  if (signal.outcome !== null) {
    outcomes[signal.outcome] += 1;
  }

  const total = report.signals.total + 1;
  const accepted = report.signals.accepted + (signal.accepted ? 1 : 0);
  const rejected = report.signals.rejected + (signal.accepted ? 0 : 1);

  return {
    ...report,
    signals: {
      total,
      accepted,
      rejected,
      acceptedRate: total === 0 ? 0 : accepted / total,
      decisions,
      rejectionReasons,
      estimatedProbabilityBuckets: buckets,
      outcomes,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI parsing (pure)

export interface ParsedCliArgs {
  from: Date;
  to: Date;
  limit: number | null;
  stepMs: number;
  dryRun: boolean;
  persist: boolean;
  reportPath: string | undefined;
  /** Engine version chosen by the user (or the v0.2.1 default). */
  signalEngineVersion: SignalEngineVersion;
}

/**
 * Parse CLI arguments. Pure: throws on invalid input, otherwise returns the
 * parsed shape. Default behaviour is DRY-RUN unless `--persist` is given.
 */
export function parseBatchCliArgs(argv: readonly string[]): ParsedCliArgs {
  const flags = new Map<string, string | true>();
  for (const arg of argv) {
    if (!arg.startsWith('--')) continue;
    const eq = arg.indexOf('=');
    if (eq === -1) {
      flags.set(arg.slice(2), true);
    } else {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    }
  }

  const fromRaw = flags.get('from');
  const toRaw = flags.get('to');
  if (typeof fromRaw !== 'string' || typeof toRaw !== 'string') {
    throw new Error('--from=<iso> and --to=<iso> are required');
  }
  const from = new Date(fromRaw);
  const to = new Date(toRaw);
  if (Number.isNaN(from.getTime())) throw new Error(`invalid --from: ${fromRaw}`);
  if (Number.isNaN(to.getTime())) throw new Error(`invalid --to: ${toRaw}`);
  if (from.getTime() > to.getTime()) {
    throw new Error(`--from must be <= --to (got ${fromRaw} > ${toRaw})`);
  }

  let limit: number | null = null;
  const limitRaw = flags.get('limit');
  if (typeof limitRaw === 'string') {
    const n = Number(limitRaw);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error(`--limit must be a positive integer, got ${limitRaw}`);
    }
    limit = n;
  }

  let stepMs = DEFAULT_STEP_MS;
  const stepRaw = flags.get('step-ms');
  if (typeof stepRaw === 'string') {
    const n = Number(stepRaw);
    if (!Number.isInteger(n) || n < MIN_SAFE_STEP_MS || n > MAX_SAFE_STEP_MS) {
      throw new Error(
        `--step-ms must be an integer in [${MIN_SAFE_STEP_MS}, ${MAX_SAFE_STEP_MS}], got ${stepRaw}`
      );
    }
    stepMs = n;
  }

  const persist = flags.get('persist') === true;
  const explicitDryRun = flags.get('dry-run') === true;

  // Default: dry-run. --persist overrides. Conflicts (--persist and
  // --dry-run) are explicit user errors.
  let dryRun: boolean;
  if (persist && explicitDryRun) {
    throw new Error('--persist and --dry-run are mutually exclusive');
  }
  if (persist) {
    dryRun = false;
  } else {
    dryRun = true;
  }

  const reportRaw = flags.get('report');
  const reportPath = typeof reportRaw === 'string' ? reportRaw : undefined;

  const engineVersionRaw = flags.get('engine-version');
  const engineVersionProvided = typeof engineVersionRaw === 'string';
  // Per scope §4: --persist without an explicit --engine-version must
  // fail fast. v0.2.3 owns the v0.2.2 dry-run replay, not multi-version
  // persistence; making the user opt in protects v0.2.1's existing
  // persisted reports.
  if (persist && !engineVersionProvided) {
    throw new Error('--persist requires an explicit --engine-version');
  }
  let signalEngineVersion: SignalEngineVersion = DEFAULT_SIGNAL_ENGINE_VERSION;
  if (engineVersionProvided) {
    if (!isSignalEngineVersion(engineVersionRaw)) {
      throw new Error(
        `--engine-version must be one of v0.2.1, v0.2.2; got ${engineVersionRaw}`
      );
    }
    signalEngineVersion = engineVersionRaw;
  }

  return {
    from,
    to,
    limit,
    stepMs,
    dryRun,
    persist,
    reportPath,
    signalEngineVersion,
  };
}

/**
 * Validate a `BatchOptions` record. Throws on invalid input. Pure.
 */
export function validateBatchOptions(options: BatchOptions): void {
  if (options.from.getTime() > options.to.getTime()) {
    throw new Error('from must be <= to');
  }
  if (options.limit !== null && (!Number.isInteger(options.limit) || options.limit <= 0)) {
    throw new Error('limit must be a positive integer or null');
  }
  if (
    !Number.isInteger(options.stepMs) ||
    options.stepMs < MIN_SAFE_STEP_MS ||
    options.stepMs > MAX_SAFE_STEP_MS
  ) {
    throw new Error(
      `stepMs must be an integer in [${MIN_SAFE_STEP_MS}, ${MAX_SAFE_STEP_MS}]`
    );
  }
  if (options.persist && options.dryRun) {
    throw new Error('persist and dryRun cannot both be true');
  }
  if (!isSignalEngineVersion(options.signalEngineVersion)) {
    throw new Error(
      `signalEngineVersion must be a known version, got ${options.signalEngineVersion}`
    );
  }
  // v0.2.3 keeps v0.2.2 dry-run only — multi-version persistence is
  // intentionally NOT in scope (scope §4). Persist is allowed only for
  // v0.2.1 in v0.2.3.
  if (options.persist && options.signalEngineVersion !== 'v0.2.1') {
    throw new Error(
      'persist is only supported for signalEngineVersion=v0.2.1 in v0.2.3 (multi-version persistence is out of scope)'
    );
  }
}

/**
 * Classify a market for batch readiness. Pure: returns the skip reason or
 * null if the market is processable.
 */
export function classifyMarket(market: Market): SkipReason | null {
  if (market.status !== 'resolved') return 'NOT_RESOLVED';
  if (normalizeFinalOutcome(market.finalOutcome) === null) {
    return 'UNKNOWN_FINAL_OUTCOME';
  }
  if (!market.upTokenId || !market.downTokenId) return 'MISSING_TOKEN_IDS';
  const windowMs = market.endTime.getTime() - market.startTime.getTime();
  if (!Number.isFinite(windowMs) || windowMs <= 0) return 'WINDOW_TOO_SHORT';
  return null;
}

// ---------------------------------------------------------------------------
// DB-bound helpers

interface BookRow {
  ts: Date;
  receive_ts: Date;
  market_id: string;
  token_id: string;
  best_bid: string | null;
  best_ask: string | null;
  bid_size: string | null;
  ask_size: string | null;
  spread: string | null;
  raw_event_id: string | null;
}

interface TickRow {
  ts: Date;
  receive_ts: Date;
  source: string;
  symbol: string;
  price: string;
  latency_ms: number | null;
  raw_event_id: string | null;
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

function rowToBook(row: BookRow): BookSnapshot {
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    ts: row.ts,
    receiveTs: row.receive_ts,
    marketId: row.market_id,
    tokenId: row.token_id,
    bestBid: num(row.best_bid),
    bestAsk: num(row.best_ask),
    bidSize: num(row.bid_size),
    askSize: num(row.ask_size),
    spread: num(row.spread),
    rawEventId: row.raw_event_id === null ? null : BigInt(row.raw_event_id),
  };
}

function rowToTick(row: TickRow): BtcTick {
  return {
    ts: row.ts,
    receiveTs: row.receive_ts,
    source: row.source,
    symbol: row.symbol,
    price: Number(row.price),
    latencyMs: row.latency_ms,
    rawEventId: row.raw_event_id === null ? null : BigInt(row.raw_event_id),
  };
}

/**
 * Select resolved BTC 5m markets whose `end_time` falls inside [from, to].
 * Ordered ascending by `end_time`. Limited when `limit` is set.
 */
export async function selectMarketsInRange(
  db: Db,
  range: { from: Date; to: Date; limit: number | null }
): Promise<Market[]> {
  const params: unknown[] = [range.from, range.to];
  let sql = `SELECT market_id, event_id, slug, question, condition_id,
                    up_token_id, down_token_id, start_time, end_time,
                    price_to_beat, resolution_source, status, final_outcome
               FROM markets
              WHERE end_time >= $1::timestamptz
                AND end_time <= $2::timestamptz
              ORDER BY end_time ASC`;
  if (range.limit !== null) {
    params.push(range.limit);
    sql += ` LIMIT $3`;
  }
  const result = await db.query<MarketRow>(sql, params);
  return result.rows.map(rowToMarket);
}

/**
 * Latest top-of-book per token visible at `target` (no-lookahead: filter on
 * `receive_ts <= target`).
 */
export async function latestBookByReceiveTs(
  db: Db,
  marketId: string,
  tokenId: string,
  target: Date
): Promise<BookSnapshot | null> {
  const result = await db.query<BookRow>(
    `SELECT ts, receive_ts, market_id, token_id,
            best_bid, best_ask, bid_size, ask_size, spread,
            raw_event_id
       FROM book_snapshots
      WHERE market_id = $1 AND token_id = $2 AND receive_ts <= $3::timestamptz
      ORDER BY receive_ts DESC
      LIMIT 1`,
    [marketId, tokenId, target]
  );
  const row = result.rows[0];
  return row ? rowToBook(row) : null;
}

/**
 * Latest BTC tick visible at `target`. No-lookahead: `receive_ts <= target`.
 */
export async function latestTickByReceiveTs(
  db: Db,
  source: 'rtds.chainlink' | 'rtds.binance',
  target: Date
): Promise<BtcTick | null> {
  const result = await db.query<TickRow>(
    `SELECT ts, receive_ts, source, symbol, price, latency_ms, raw_event_id
       FROM btc_ticks
      WHERE source = $1 AND receive_ts <= $2::timestamptz
      ORDER BY receive_ts DESC
      LIMIT 1`,
    [source, target]
  );
  const row = result.rows[0];
  return row ? rowToTick(row) : null;
}

/**
 * Visible BTC ticks for `source` whose `receive_ts` falls in
 * `[windowStart, target]`, ordered ascending. Used to feed the v0.2.2
 * estimator's momentum / volatility windows. No-lookahead via the
 * upper bound on `receive_ts`.
 */
export async function btcTicksInWindow(
  db: Db,
  source: string,
  windowStart: Date,
  target: Date
): Promise<BtcTick[]> {
  const result = await db.query<TickRow>(
    `SELECT ts, receive_ts, source, symbol, price, latency_ms, raw_event_id
       FROM btc_ticks
      WHERE source = $1
        AND receive_ts >= $2::timestamptz
        AND receive_ts <= $3::timestamptz
      ORDER BY receive_ts ASC`,
    [source, windowStart, target]
  );
  return result.rows.map(rowToTick);
}

/**
 * Chainlink tick nearest to `startTime` whose `receive_ts <= target` —
 * the no-lookahead price_to_beat fallback. The tolerance window is
 * re-checked here in TS in case the DB returned a row whose ts is far from
 * startTime (the SQL ORDER BY is "nearest in either direction", which is
 * still bounded by tolerance via this final filter).
 */
export async function chainlinkTickNearestStartTime(
  db: Db,
  startTime: Date,
  toleranceMs: number,
  target: Date
): Promise<BtcTick | null> {
  const result = await db.query<TickRow>(
    `SELECT ts, receive_ts, source, symbol, price, latency_ms, raw_event_id
       FROM btc_ticks
      WHERE source = 'rtds.chainlink'
        AND receive_ts <= $2::timestamptz
      ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $1::timestamptz)))
      LIMIT 1`,
    [startTime, target]
  );
  const row = result.rows[0];
  if (!row) return null;
  const proximityMs = Math.abs(row.ts.getTime() - startTime.getTime());
  if (proximityMs > toleranceMs) return null;
  return rowToTick(row);
}

// ---------------------------------------------------------------------------
// Single-market replay (shared with the optional persistence path)

export interface ReplayMarketDeps {
  db: Db;
  config?: StrategyConfig;
}

export interface ReplayMarketResult {
  /** All signals generated for this market, in sample-order. */
  signals: Signal[];
  /** States built (one per timestamp). */
  statesBuilt: number;
  /** When persist=true: how many states were INSERTed vs deduplicated. */
  statesPersistedNew: number;
  statesPersistedExisting: number;
  /** When persist=true: how many signals were INSERTed vs deduplicated. */
  signalsPersistedNew: number;
  signalsPersistedExisting: number;
}

/**
 * Walk one market through the same pure pipeline `replay-market.ts` uses,
 * for every sampling timestamp. Optionally persists each state + signal
 * idempotently. The market is assumed to have already passed
 * `classifyMarket`.
 */
export async function replaySingleMarket(
  deps: ReplayMarketDeps,
  market: Market,
  options: { stepMs: number; persist: boolean; signalEngineVersion: SignalEngineVersion }
): Promise<ReplayMarketResult> {
  const config = deps.config ?? DEFAULT_STRATEGY_CONFIG;
  const stamps = samplingTimestamps(market, options.stepMs);

  const result: ReplayMarketResult = {
    signals: [],
    statesBuilt: 0,
    statesPersistedNew: 0,
    statesPersistedExisting: 0,
    signalsPersistedNew: 0,
    signalsPersistedExisting: 0,
  };

  const marketStates = createMarketStatesRepository(deps.db);
  const signals = createSignalsRepository(deps.db);

  // Outcome label clock: market.endTime — same convention as replay-market.ts
  // so re-runs produce identical resolved_at values.
  const labelClock = market.endTime;

  for (const target of stamps) {
    const upBook = await latestBookByReceiveTs(deps.db, market.marketId, market.upTokenId, target);
    const downBook = await latestBookByReceiveTs(
      deps.db,
      market.marketId,
      market.downTokenId,
      target
    );
    const chainlinkTick = await latestTickByReceiveTs(deps.db, 'rtds.chainlink', target);
    const binanceTick = await latestTickByReceiveTs(deps.db, 'rtds.binance', target);
    const priceToBeatFallbackTick =
      market.priceToBeat === null
        ? await chainlinkTickNearestStartTime(
            deps.db,
            market.startTime,
            config.priceToBeatToleranceMs,
            target
          )
        : null;

    const state = buildMarketState(
      {
        market,
        upBook,
        downBook,
        chainlinkTick,
        binanceTick,
        priceToBeatFallbackTick,
        targetTimestamp: target,
      },
      config
    );
    result.statesBuilt += 1;

    let signal: Signal;
    if (options.signalEngineVersion === 'v0.2.2') {
      // Per design-note §5: features at t come from the same source the
      // state-builder picked. If no source is set (no fresh tick) we
      // pass an empty history and the estimator fails closed.
      const recentBtcTicks: BtcTick[] = state.btcSource
        ? await btcTicksInWindow(
            deps.db,
            state.btcSource,
            new Date(target.getTime() - V022_VISIBLE_TICK_WINDOW_MS),
            target
          )
        : [];
      signal = generateSignalV022({ state, recentBtcTicks }, config);
    } else {
      signal = generateSignal(state, config);
    }

    // Outcome labeling never reads markets.final_outcome inside the engine
    // — only here, after the signal has already been generated. Resolved
    // markets always get labeled (BUY_UP/DOWN → WIN/LOSS, REJECT → NOT_APPLICABLE).
    if (market.status === 'resolved') {
      const label = labelSignalOutcome({
        signal,
        rawFinalOutcome: market.finalOutcome,
        resolvedAt: labelClock,
      });
      signal = {
        ...signal,
        outcome: label.outcome,
        finalOutcome: label.finalOutcome,
        resolvedAt: label.resolvedAt,
      };
    }

    if (options.persist) {
      const stateInsert = await marketStates.insertIfAbsent(state);
      if (stateInsert.inserted) result.statesPersistedNew += 1;
      else result.statesPersistedExisting += 1;
      const persistedSignal = { ...signal, marketStateId: stateInsert.id };
      const signalInsert = await signals.insertIfAbsent(persistedSignal);
      if (signalInsert.inserted) result.signalsPersistedNew += 1;
      else result.signalsPersistedExisting += 1;
      // Stamp the persisted id back onto the in-memory signal so the
      // returned list matches what's in the DB.
      signal = { ...persistedSignal, id: signalInsert.id };
    }

    result.signals.push(signal);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Batch entrypoint

export interface BatchDeps {
  db: Db;
  config?: StrategyConfig;
  /** Override clock for tests. */
  now?: () => Date;
  logger?: { info: (obj: object, msg?: string) => void; warn: (obj: object, msg?: string) => void };
}

/**
 * Run batch replay over the configured range. Returns the final report.
 */
export async function runBatchReplay(
  deps: BatchDeps,
  options: BatchOptions
): Promise<SignalDensityReport> {
  validateBatchOptions(options);
  const now = deps.now?.() ?? new Date();
  let report = emptyReport(options, now);

  const markets = await selectMarketsInRange(deps.db, {
    from: options.from,
    to: options.to,
    limit: options.limit,
  });
  report = {
    ...report,
    markets: { ...report.markets, observed: markets.length },
  };

  for (const market of markets) {
    const skip = classifyMarket(market);
    if (skip !== null) {
      const skipReasons = { ...report.markets.skipReasons };
      skipReasons[skip] += 1;
      report = {
        ...report,
        markets: {
          ...report.markets,
          skipped: report.markets.skipped + 1,
          skipReasons,
        },
      };
      continue;
    }

    const single = await replaySingleMarket(
      { db: deps.db, ...(deps.config ? { config: deps.config } : {}) },
      market,
      {
        stepMs: options.stepMs,
        persist: options.persist,
        signalEngineVersion: options.signalEngineVersion,
      }
    );
    report = {
      ...report,
      markets: { ...report.markets, replayReady: report.markets.replayReady + 1 },
      states: {
        built: report.states.built + single.statesBuilt,
        persistedNew: report.states.persistedNew + single.statesPersistedNew,
        persistedExisting: report.states.persistedExisting + single.statesPersistedExisting,
      },
    };
    for (const sig of single.signals) {
      report = foldSignalIntoReport(report, sig);
    }
  }

  report = { ...report, notes: notesForReport(report) };
  return report;
}

// ---------------------------------------------------------------------------
// CLI shim (only runs when executed directly)

function isDirectInvocation(): boolean {
  if (typeof process === 'undefined' || !Array.isArray(process.argv)) return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
  const a = pathResolve(modulePath);
  const b = pathResolve(argv1);
  if (process.platform === 'win32') return a.toLowerCase() === b.toLowerCase();
  return a === b;
}

async function writeReport(reportPath: string, report: SignalDensityReport): Promise<void> {
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
}

async function cliMain(argv: readonly string[]): Promise<void> {
  const args = parseBatchCliArgs(argv);
  const options: BatchOptions = {
    from: args.from,
    to: args.to,
    limit: args.limit,
    stepMs: args.stepMs,
    dryRun: args.dryRun,
    persist: args.persist,
    signalEngineVersion: args.signalEngineVersion,
    ...(args.reportPath ? { reportPath: args.reportPath } : {}),
  };
  const { db } = createDb();
  // Touch the markets repo so a connection error surfaces early — and so we
  // hold an explicit reference to the read-only repository surface (no
  // `signals.update` / `markets.markResolved` is invoked here).
  void createMarketsRepository(db);
  try {
    const report = await runBatchReplay({ db }, options);
    if (options.reportPath) {
      await writeReport(options.reportPath, report);
      process.stdout.write(`report written to ${options.reportPath}\n`);
    } else {
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    }
  } finally {
    await db.end();
  }
}

if (isDirectInvocation()) {
  cliMain(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(
      `[replay-batch] failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}
