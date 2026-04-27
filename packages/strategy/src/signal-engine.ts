// Pulse5 v0.2 — pure signal engine.
//
// Consumes a `MarketState` and emits a `Signal`: BUY_UP / BUY_DOWN /
// REJECT. Pure: no I/O, no clock, no DB. Live and replay both call this.
//
// v0.2 contract:
//   - REJECT signals must include explicit `rejectionReasons`.
//   - Both accepted and rejected signals carry `features` so post-hoc
//     analysis can compare populations.
//   - No signal creates or implies an order. v0.2 does not trade.
//
// The NO_EDGE heuristic is deliberately simple and deterministic so that
// replay produces identical signals across runs:
//
//   estimated_probability = clamp(0.5 + min(|distance_bps| / 100, 0.4), 0.5, 0.9)
//   selected entry        = up ask for BUY_UP, down ask for BUY_DOWN
//   estimated_ev          = estimated_probability - selected entry price
//
// This is *only* a shadow / replay heuristic, not a trading model.

import type {
  MarketState,
  Signal,
  SignalDecision,
  SignalRejectionReason,
  SignalSide,
} from '@pulse5/models';
import type { StrategyConfig } from './config.js';

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function estimatedProbabilityFromDistanceBps(distanceBps: number): number {
  return clamp(0.5 + Math.min(Math.abs(distanceBps) / 100, 0.4), 0.5, 0.9);
}

interface RejectionAccumulator {
  reasons: SignalRejectionReason[];
  add(reason: SignalRejectionReason): void;
}

function makeAccumulator(): RejectionAccumulator {
  const reasons: SignalRejectionReason[] = [];
  return {
    reasons,
    add(reason): void {
      if (!reasons.includes(reason)) {
        reasons.push(reason);
      }
    },
  };
}

function buildFeatures(state: MarketState): Signal['features'] {
  return {
    btcPrice: state.btcPrice,
    btcSource: state.btcSource,
    priceToBeat: state.priceToBeat,
    distance: state.distance,
    distanceBps: state.distanceBps,
    timeRemainingMs: state.timeRemainingMs,
    upBestAsk: state.upBestAsk,
    downBestAsk: state.downBestAsk,
    upSpread: state.upSpread,
    downSpread: state.downSpread,
    btcTickAgeMs: state.btcTickAgeMs,
    upBookAgeMs: state.upBookAgeMs,
    downBookAgeMs: state.downBookAgeMs,
    chainlinkBinanceGapBps: state.chainlinkBinanceGapBps,
    dataComplete: state.dataComplete,
    stale: state.stale,
  };
}

interface EngineDecision {
  decision: SignalDecision;
  side: SignalSide | null;
  price: number | null;
  estimatedProbability: number | null;
  estimatedEv: number | null;
  rejectionReasons: SignalRejectionReason[];
}

function decide(state: MarketState, config: StrategyConfig): EngineDecision {
  const reasons = makeAccumulator();

  // 1. Hard-stop rejections — these gate everything that follows. We still
  //    accumulate every applicable reason instead of short-circuiting so
  //    the persisted record is auditable.
  if (!state.dataComplete) {
    reasons.add('DATA_INCOMPLETE');
  }
  if (state.priceToBeat === null) {
    reasons.add('PRICE_TO_BEAT_MISSING');
  }
  if (
    state.btcTickAgeMs !== null &&
    state.btcTickAgeMs > config.maxBtcTickAgeMs
  ) {
    reasons.add('STALE_BTC_TICK');
  }
  if (
    state.upBookAgeMs !== null &&
    state.upBookAgeMs > config.maxBookAgeMs
  ) {
    reasons.add('STALE_UP_BOOK');
  }
  if (
    state.downBookAgeMs !== null &&
    state.downBookAgeMs > config.maxBookAgeMs
  ) {
    reasons.add('STALE_DOWN_BOOK');
  }

  // 2. Time window.
  if (
    state.timeRemainingMs !== null &&
    state.timeRemainingMs < config.minTimeRemainingMs
  ) {
    reasons.add('TIME_REMAINING_TOO_LOW');
  }
  if (
    state.timeRemainingMs !== null &&
    state.timeRemainingMs > config.maxTimeRemainingMs
  ) {
    reasons.add('TIME_REMAINING_TOO_HIGH');
  }

  // 3. Feed integrity.
  if (
    state.chainlinkBinanceGapBps !== null &&
    state.chainlinkBinanceGapBps > config.maxChainlinkBinanceGapBps
  ) {
    reasons.add('BTC_FEED_GAP_TOO_LARGE');
  }

  // 4. Edge-related checks. These need a usable distance.
  const distanceBps = state.distanceBps;
  const isUpward = distanceBps !== null && distanceBps > 0;
  const isDownward = distanceBps !== null && distanceBps < 0;

  if (
    distanceBps !== null &&
    Math.abs(distanceBps) < config.minDistanceBps
  ) {
    reasons.add('BTC_TOO_CLOSE_TO_PRICE_TO_BEAT');
  }

  // Pick a tentative side from sign(distance). Spread + entry price checks
  // operate on whatever side we'd have chosen; if neither side is selectable
  // we fall through to NO_EDGE.
  let side: SignalSide | null = null;
  let entryPrice: number | null = null;
  if (isUpward) {
    side = 'UP';
    entryPrice = state.upBestAsk;
    if (state.upSpread !== null && state.upSpread > config.maxSpread) {
      reasons.add('SPREAD_TOO_WIDE');
    }
  } else if (isDownward) {
    side = 'DOWN';
    entryPrice = state.downBestAsk;
    if (state.downSpread !== null && state.downSpread > config.maxSpread) {
      reasons.add('SPREAD_TOO_WIDE');
    }
  }

  if (entryPrice !== null && entryPrice > config.maxEntryPrice) {
    reasons.add('ENTRY_PRICE_TOO_EXPENSIVE');
  }

  // 5. NO_EDGE heuristic.
  let estimatedProbability: number | null = null;
  let estimatedEv: number | null = null;
  if (distanceBps !== null) {
    estimatedProbability = estimatedProbabilityFromDistanceBps(distanceBps);
    if (entryPrice !== null) {
      estimatedEv = estimatedProbability - entryPrice;
      if (
        estimatedProbability < config.minEstimatedProbability ||
        estimatedEv < config.minEstimatedEv
      ) {
        reasons.add('NO_EDGE');
      }
    }
  }

  if (reasons.reasons.length > 0 || side === null || entryPrice === null) {
    return {
      decision: 'REJECT',
      side: null,
      price: null,
      estimatedProbability,
      estimatedEv,
      rejectionReasons: reasons.reasons,
    };
  }

  return {
    decision: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
    side,
    price: entryPrice,
    estimatedProbability,
    estimatedEv,
    rejectionReasons: [],
  };
}

/**
 * Score a `MarketState` and emit a `Signal`. Pure function: identical
 * inputs always produce the same output, so live and replay are guaranteed
 * to agree on every decision.
 */
export function generateSignal(state: MarketState, config: StrategyConfig): Signal {
  const result = decide(state, config);
  return {
    id: null,
    ts: state.ts,
    marketId: state.marketId,
    marketStateId: null,
    decision: result.decision,
    side: result.side,
    price: result.price,
    estimatedProbability: result.estimatedProbability,
    estimatedEv: result.estimatedEv,
    accepted: result.decision !== 'REJECT',
    rejectionReasons: result.rejectionReasons,
    features: buildFeatures(state),
    outcome: null,
    finalOutcome: null,
    resolvedAt: null,
  };
}
