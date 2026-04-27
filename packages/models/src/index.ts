// Pulse5 shared TypeScript domain models.
//
// These types are *transport-shape*: they describe rows as the collector
// hands them to storage repositories. Persistence-only fields (BIGSERIAL
// id, ingest_ts default) are filled in by Postgres.

export const MODELS_VERSION = '0.2.0';

export interface Market {
  marketId: string;
  eventId: string;
  slug: string;
  question: string;
  conditionId: string | null;
  upTokenId: string;
  downTokenId: string;
  startTime: Date;
  endTime: Date;
  priceToBeat: number | null;
  resolutionSource: string;
  status: string;
  finalOutcome: string | null;
}

export type RawEventSource =
  | 'clob'
  | 'gamma'
  | 'rtds.binance'
  | 'rtds.chainlink'
  | (string & { readonly _brand?: 'raw-event-source' });

export interface RawEventRecord {
  source: RawEventSource;
  eventType: string;
  sourceTs: Date | null;
  receiveTs: Date;
  marketId: string | null;
  tokenId: string | null;
  payload: unknown;
}

export interface BookSnapshot {
  ts: Date;
  receiveTs: Date;
  marketId: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  spread: number | null;
  rawEventId: bigint | null;
}

export type BtcTickSource = 'rtds.binance' | 'rtds.chainlink' | (string & {});

export interface BtcTick {
  ts: Date;
  receiveTs: Date;
  source: BtcTickSource;
  symbol: string;
  price: number;
  latencyMs: number | null;
  rawEventId: bigint | null;
}

export type MarketStatus = 'open' | 'resolved' | 'unknown';

// ---------------------------------------------------------------------------
// v0.2 Shadow Signal Engine — pure observation models.
//
// These types are added by v0.2 to support a *shadow* signal engine: it
// rebuilds market state, generates a decision, and records the outcome AFTER
// the market resolves. v0.2 explicitly does NOT trade, paper-trade, simulate
// orders, or hold a wallet — that is reserved for later phases. The contract
// is the same one v0.1 already enforced for the collector: read-only at the
// boundary.
//
// Field-naming follows the same transport-shape convention as the v0.1
// models: camelCase in TS, snake_case in Postgres. Repos translate.

/** What the engine decided when scoring a market state. */
export type SignalDecision = 'BUY_UP' | 'BUY_DOWN' | 'REJECT';

/** Direction of an accepted signal. Null when rejected. */
export type SignalSide = 'UP' | 'DOWN';

/**
 * v0.2 outcome of the *signal* (not the market itself).
 *
 *   WIN             — accepted signal whose side matched final_outcome.
 *   LOSS            — accepted signal whose side did not match final_outcome.
 *   NOT_APPLICABLE  — rejected signal; outcome scoring is not meaningful.
 */
export type SignalOutcome = 'WIN' | 'LOSS' | 'NOT_APPLICABLE';

/**
 * Reasons the signal engine may emit when rejecting a market state.
 *
 * The list is deliberately narrow and covers only what v0.2 actually checks
 * — every rejection path in the engine maps to exactly one of these so the
 * persisted `rejection_reasons` JSON stays deterministic and auditable.
 */
export type SignalRejectionReason =
  | 'DATA_INCOMPLETE'
  | 'PRICE_TO_BEAT_MISSING'
  | 'STALE_BTC_TICK'
  | 'STALE_UP_BOOK'
  | 'STALE_DOWN_BOOK'
  | 'TIME_REMAINING_TOO_LOW'
  | 'TIME_REMAINING_TOO_HIGH'
  | 'SPREAD_TOO_WIDE'
  | 'BTC_FEED_GAP_TOO_LARGE'
  | 'BTC_TOO_CLOSE_TO_PRICE_TO_BEAT'
  | 'ENTRY_PRICE_TOO_EXPENSIVE'
  | 'NO_EDGE';

/** Which BTC feed produced `MarketState.btcPrice`. */
export type BtcSource = 'rtds.chainlink' | 'rtds.binance' | (string & {});

/**
 * Snapshot of everything the signal engine needs to make ONE decision at
 * one timestamp. Pure data; the state builder fills it in from a Market plus
 * the latest receive_ts-visible book / tick rows. v0.2 never reads
 * `markets.final_outcome` or `markets.status` while building this.
 */
export interface MarketState {
  /** When this state was computed (engine clock). */
  ts: Date;
  marketId: string;

  btcPrice: number | null;
  btcSource: BtcSource | null;
  priceToBeat: number | null;
  /** btcPrice - priceToBeat. null if either side is missing. */
  distance: number | null;
  /** distance / priceToBeat * 10_000. null if either side is missing. */
  distanceBps: number | null;
  /** ms remaining until market.endTime (negative when past end). */
  timeRemainingMs: number | null;

  upBestBid: number | null;
  upBestAsk: number | null;
  downBestBid: number | null;
  downBestAsk: number | null;
  upSpread: number | null;
  downSpread: number | null;

  btcTickAgeMs: number | null;
  upBookAgeMs: number | null;
  downBookAgeMs: number | null;

  /** |chainlink - binance| / chainlink * 10_000, when both feeds available. */
  chainlinkBinanceGapBps: number | null;

  /** All required inputs were present and finite. */
  dataComplete: boolean;
  /** At least one input is too old per config thresholds. */
  stale: boolean;
}

/**
 * One scored outcome — either an accepted BUY_UP / BUY_DOWN or a REJECT.
 * Rejected and accepted decisions both carry `features` so post-hoc
 * analysis can compare both populations against the same numeric inputs.
 */
export interface Signal {
  /** Persistence-only id; null until the row is written. */
  id: bigint | null;
  ts: Date;
  marketId: string;
  /** FK to market_states.id; null until the underlying state is persisted. */
  marketStateId: bigint | null;

  decision: SignalDecision;
  side: SignalSide | null;
  /** Selected entry price (Up ask for BUY_UP, Down ask for BUY_DOWN). */
  price: number | null;
  estimatedProbability: number | null;
  estimatedEv: number | null;

  /** Redundant with decision != REJECT — kept for query ergonomics. */
  accepted: boolean;
  /** Empty when accepted; otherwise one or more reasons. */
  rejectionReasons: SignalRejectionReason[];
  /** Free-form numeric inputs preserved for post-hoc analysis. */
  features: Record<string, number | string | boolean | null>;

  /** Signal scoring result, set by outcome-labeler after market resolves. */
  outcome: SignalOutcome | null;
  /** Normalized market settlement snapshot copied at label time. */
  finalOutcome: SignalSide | null;
  /** When labeling ran. */
  resolvedAt: Date | null;
}
