// Pulse5 v0.2.3 — frozen v0.2.2 estimator implementation.
//
// Implements the design frozen in
// research/reports/v0.2.2-estimator-design-note.md. Numeric constants
// are committed in `signal-engine-v022-config.ts` and may not be tuned
// in this task — see §9 of the design note.
//
// Pure: no I/O, no clock, no DB. Live and replay must call this with
// the same input shape and obtain bit-identical signals.

import type {
  BtcTick,
  MarketState,
  Signal,
  SignalDecision,
  SignalRejectionReason,
  SignalSide,
} from '@pulse5/models';
import type { StrategyConfig } from './config.js';
import {
  BETA_0,
  BETA_1,
  BETA_2,
  BETA_3,
  BETA_4,
  BETA_5,
  V022_MIN_ESTIMATED_EV,
  MOMENTUM_WINDOW_MS,
  VOLATILITY_WINDOW_MS,
  VOLATILITY_FLOOR_BPS,
  P_UP_CLAMP_LO,
  P_UP_CLAMP_HI,
  MIN_TICKS_FOR_MOMENTUM,
  MIN_TICKS_FOR_VOLATILITY,
} from './signal-engine-v022-config.js';

/**
 * Input to the frozen v0.2.2 estimator. Keeping `state` and
 * `recentBtcTicks` as separate fields makes the no-lookahead contract
 * explicit at the call site: the caller must filter `recentBtcTicks`
 * by `receiveTs <= state.ts` (the estimator additionally enforces this
 * defensively) and by `source === state.btcSource` so that all
 * features at `t` come from the same feed (design-note §5).
 */
export interface SignalEngineV022Input {
  state: MarketState;
  /**
   * Visible BTC ticks for the source chosen by `buildMarketState`,
   * sorted ascending by `receiveTs`. Must include enough history to
   * cover the volatility window (180s); the estimator slices the
   * momentum subwindow itself.
   */
  recentBtcTicks: readonly BtcTick[];
}

function clamp(n: number, lo: number, hi: number): number {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function sigmoid(x: number): number {
  // Numerically stable sigmoid for both signs of x.
  if (x >= 0) {
    const ez = Math.exp(-x);
    return 1 / (1 + ez);
  }
  const ez = Math.exp(x);
  return ez / (1 + ez);
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

/**
 * Drop ticks that violate the no-lookahead rule, then keep only ticks
 * matching the chosen BTC source. Returns ticks sorted ascending by
 * `receiveTs`. Pure.
 */
function visibleTicksForState(
  state: MarketState,
  ticks: readonly BtcTick[]
): BtcTick[] {
  const tMs = state.ts.getTime();
  const filtered = ticks.filter(
    (tick) =>
      tick.receiveTs.getTime() <= tMs &&
      (state.btcSource === null || tick.source === state.btcSource)
  );
  // Be defensive about ordering — caller is supposed to pass ascending,
  // but a bug there would silently corrupt momentum/volatility.
  return [...filtered].sort(
    (a, b) => a.receiveTs.getTime() - b.receiveTs.getTime()
  );
}

/**
 * recentMomentumBps per design-note §4: largest receiveTs <= t -
 * MOMENTUM_WINDOW_MS as the baseline; current btcPrice as the head.
 * Returns null when fewer than MIN_TICKS_FOR_MOMENTUM ticks lie in the
 * 60s window or no baseline-eligible tick exists. Pure.
 */
function computeRecentMomentumBps(
  state: MarketState,
  visibleTicks: readonly BtcTick[]
): number | null {
  if (state.btcPrice === null || !Number.isFinite(state.btcPrice)) return null;
  const tMs = state.ts.getTime();
  const baselineCutoffMs = tMs - MOMENTUM_WINDOW_MS;
  // ticks at-or-after the cutoff form the in-window set we count
  // against MIN_TICKS_FOR_MOMENTUM. Ticks before the cutoff are still
  // candidates for the baseline (largest receiveTs <= cutoff).
  const inWindowCount = visibleTicks.filter(
    (tick) => tick.receiveTs.getTime() >= baselineCutoffMs
  ).length;
  if (inWindowCount < MIN_TICKS_FOR_MOMENTUM) return null;

  // Largest receiveTs satisfying receiveTs <= t - 60_000.
  let baseline: BtcTick | null = null;
  for (const tick of visibleTicks) {
    if (tick.receiveTs.getTime() <= baselineCutoffMs) {
      if (
        baseline === null ||
        tick.receiveTs.getTime() > baseline.receiveTs.getTime()
      ) {
        baseline = tick;
      }
    }
  }
  if (baseline === null || !Number.isFinite(baseline.price) || baseline.price === 0) {
    return null;
  }
  return ((state.btcPrice - baseline.price) / baseline.price) * 10_000;
}

/**
 * realizedVolatilityBps per design-note §4: sample stdev of log returns
 * across BTC ticks within the last VOLATILITY_WINDOW_MS, scaled to bps
 * (×10_000). Frozen as *sample* stdev (Bessel-corrected, divide by
 * n-1) — fixed here because the design note says "stdev" without
 * specifying. Returns null when fewer than MIN_TICKS_FOR_VOLATILITY
 * ticks lie in the 180s window or any return is non-finite. Pure.
 */
function computeRealizedVolatilityBps(
  state: MarketState,
  visibleTicks: readonly BtcTick[]
): number | null {
  const tMs = state.ts.getTime();
  const windowStartMs = tMs - VOLATILITY_WINDOW_MS;
  const windowTicks = visibleTicks.filter(
    (tick) => tick.receiveTs.getTime() >= windowStartMs
  );
  if (windowTicks.length < MIN_TICKS_FOR_VOLATILITY) return null;

  const logReturns: number[] = [];
  for (let i = 1; i < windowTicks.length; i += 1) {
    const prev = windowTicks[i - 1];
    const cur = windowTicks[i];
    if (
      !prev ||
      !cur ||
      !Number.isFinite(prev.price) ||
      !Number.isFinite(cur.price) ||
      prev.price <= 0 ||
      cur.price <= 0
    ) {
      return null;
    }
    const r = Math.log(cur.price / prev.price);
    if (!Number.isFinite(r)) return null;
    logReturns.push(r);
  }
  if (logReturns.length < 2) return null;

  let mean = 0;
  for (const r of logReturns) mean += r;
  mean /= logReturns.length;

  let sumSq = 0;
  for (const r of logReturns) sumSq += (r - mean) ** 2;
  // Sample stdev (Bessel correction).
  const variance = sumSq / (logReturns.length - 1);
  if (!Number.isFinite(variance) || variance < 0) return null;
  return Math.sqrt(variance) * 10_000;
}

interface EstimatorFeatures {
  signedDistanceBps: number;
  recentMomentumBps: number;
  logTimeRemainingMs: number;
  realizedVolatilityBps: number;
  normalizedDistance: number;
}

function computeFeatures(
  state: MarketState,
  visibleTicks: readonly BtcTick[]
): EstimatorFeatures | null {
  if (
    state.distanceBps === null ||
    !Number.isFinite(state.distanceBps) ||
    state.timeRemainingMs === null ||
    !Number.isFinite(state.timeRemainingMs) ||
    state.timeRemainingMs <= 0
  ) {
    return null;
  }

  const momentum = computeRecentMomentumBps(state, visibleTicks);
  if (momentum === null || !Number.isFinite(momentum)) return null;

  const vol = computeRealizedVolatilityBps(state, visibleTicks);
  if (vol === null || !Number.isFinite(vol) || vol < 0) return null;

  const denom = Math.max(vol, VOLATILITY_FLOOR_BPS);
  const normalizedDistance = state.distanceBps / denom;
  if (!Number.isFinite(normalizedDistance)) return null;

  return {
    signedDistanceBps: state.distanceBps,
    recentMomentumBps: momentum,
    logTimeRemainingMs: Math.log(state.timeRemainingMs),
    realizedVolatilityBps: vol,
    normalizedDistance,
  };
}

function computePUp(features: EstimatorFeatures): number {
  const logit =
    BETA_0 +
    BETA_1 * features.signedDistanceBps +
    BETA_2 * features.recentMomentumBps +
    BETA_3 * features.logTimeRemainingMs +
    BETA_4 * features.realizedVolatilityBps +
    BETA_5 * features.normalizedDistance;
  const raw = sigmoid(logit);
  return clamp(raw, P_UP_CLAMP_LO, P_UP_CLAMP_HI);
}

function buildFeaturesRecord(
  state: MarketState,
  features: EstimatorFeatures | null,
  pUp: number | null
): Signal['features'] {
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
    signalEngineVersion: 'v0.2.2',
    pUp,
    pDown: pUp === null ? null : 1 - pUp,
    recentMomentumBps: features?.recentMomentumBps ?? null,
    realizedVolatilityBps: features?.realizedVolatilityBps ?? null,
    normalizedDistance: features?.normalizedDistance ?? null,
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

function decide(
  state: MarketState,
  visibleTicks: readonly BtcTick[],
  config: StrategyConfig
): { decision: EngineDecision; features: EstimatorFeatures | null; pUp: number | null } {
  const reasons = makeAccumulator();

  // Stage 1: data-quality hard gates. These mirror v0.2.1's hard gates
  // since they are about *whether the inputs are usable at all*, not
  // about EV.
  if (!state.dataComplete) reasons.add('DATA_INCOMPLETE');
  if (state.priceToBeat === null) reasons.add('PRICE_TO_BEAT_MISSING');
  if (
    state.btcTickAgeMs !== null &&
    state.btcTickAgeMs > config.maxBtcTickAgeMs
  ) {
    reasons.add('STALE_BTC_TICK');
  }
  if (state.upBookAgeMs !== null && state.upBookAgeMs > config.maxBookAgeMs) {
    reasons.add('STALE_UP_BOOK');
  }
  if (
    state.downBookAgeMs !== null &&
    state.downBookAgeMs > config.maxBookAgeMs
  ) {
    reasons.add('STALE_DOWN_BOOK');
  }
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
  if (
    state.chainlinkBinanceGapBps !== null &&
    state.chainlinkBinanceGapBps > config.maxChainlinkBinanceGapBps
  ) {
    reasons.add('BTC_FEED_GAP_TOO_LARGE');
  }

  // Stage 2: estimator + EV decision. v0.2.2 does NOT use distance,
  // entry-price, or estimated-probability as independent hard vetos.
  // Spread is still a data-quality-ish gate per §6 motivation, applied
  // on the SELECTED side after EV chooses it.
  const features = computeFeatures(state, visibleTicks);
  if (features === null) {
    // Fail-closed. Match the existing v0.2.1 reason vocabulary so the
    // replay rejection-reason histogram stays comparable.
    if (!reasons.reasons.includes('DATA_INCOMPLETE')) {
      reasons.add('DATA_INCOMPLETE');
    }
    return {
      decision: {
        decision: 'REJECT',
        side: null,
        price: null,
        estimatedProbability: null,
        estimatedEv: null,
        rejectionReasons: reasons.reasons,
      },
      features: null,
      pUp: null,
    };
  }

  const pUp = computePUp(features);
  const pDown = 1 - pUp;

  const upAsk = state.upBestAsk;
  const downAsk = state.downBestAsk;

  // EV-side selection per scope.zh.md §2 and the v0.2.3 task spec:
  //   upEv = pUp - upBestAsk
  //   downEv = (1 - pUp) - downBestAsk
  //   side = argmax(upEv, downEv)
  const upEv = upAsk !== null && Number.isFinite(upAsk) ? pUp - upAsk : null;
  const downEv =
    downAsk !== null && Number.isFinite(downAsk) ? pDown - downAsk : null;

  let side: SignalSide | null = null;
  let entryPrice: number | null = null;
  let selectedP: number | null = null;
  let selectedEv: number | null = null;

  if (upEv !== null && (downEv === null || upEv >= downEv)) {
    side = 'UP';
    entryPrice = upAsk;
    selectedP = pUp;
    selectedEv = upEv;
  } else if (downEv !== null) {
    side = 'DOWN';
    entryPrice = downAsk;
    selectedP = pDown;
    selectedEv = downEv;
  }

  // Apply spread / entry-price gates on the selected side only — single
  // veto each, mapped to existing reason codes so the rejection-reason
  // histogram remains comparable to v0.2.1.
  if (side === 'UP') {
    if (state.upSpread !== null && state.upSpread > config.maxSpread) {
      reasons.add('SPREAD_TOO_WIDE');
    }
  } else if (side === 'DOWN') {
    if (state.downSpread !== null && state.downSpread > config.maxSpread) {
      reasons.add('SPREAD_TOO_WIDE');
    }
  }
  if (entryPrice !== null && entryPrice > config.maxEntryPrice) {
    reasons.add('ENTRY_PRICE_TOO_EXPENSIVE');
  }

  // EV gate: v0.2.2 minEstimatedEv (NOT v0.2.1's). The
  // BTC_TOO_CLOSE_TO_PRICE_TO_BEAT gate is dropped per
  // redesign-issue-spec §"2. Gate Structure Redesign" — distance is now
  // a feature, not an independent veto.
  if (selectedEv === null || selectedEv < V022_MIN_ESTIMATED_EV) {
    reasons.add('NO_EDGE');
  }

  if (
    reasons.reasons.length > 0 ||
    side === null ||
    entryPrice === null ||
    selectedP === null ||
    selectedEv === null
  ) {
    return {
      decision: {
        decision: 'REJECT',
        side: null,
        price: null,
        estimatedProbability: selectedP,
        estimatedEv: selectedEv,
        rejectionReasons: reasons.reasons,
      },
      features,
      pUp,
    };
  }

  return {
    decision: {
      decision: side === 'UP' ? 'BUY_UP' : 'BUY_DOWN',
      side,
      price: entryPrice,
      estimatedProbability: selectedP,
      estimatedEv: selectedEv,
      rejectionReasons: [],
    },
    features,
    pUp,
  };
}

/**
 * Score a `MarketState` plus visible BTC tick history with the frozen
 * v0.2.2 estimator and emit a `Signal`. Pure: identical inputs always
 * produce the same output.
 *
 * The numerical body (beta0..beta5, windows, clamps, EV gate) is
 * pre-registered in `signal-engine-v022-config.ts`. Per design-note
 * §9, none of those values may be changed in the same task as the
 * holdout replay.
 */
export function generateSignalV022(
  input: SignalEngineV022Input,
  config: StrategyConfig
): Signal {
  const { state, recentBtcTicks } = input;
  const visibleTicks = visibleTicksForState(state, recentBtcTicks);
  const { decision, features, pUp } = decide(state, visibleTicks, config);

  return {
    id: null,
    ts: state.ts,
    marketId: state.marketId,
    marketStateId: null,
    decision: decision.decision,
    side: decision.side,
    price: decision.price,
    estimatedProbability: decision.estimatedProbability,
    estimatedEv: decision.estimatedEv,
    accepted: decision.decision !== 'REJECT',
    rejectionReasons: decision.rejectionReasons,
    features: buildFeaturesRecord(state, features, pUp),
    outcome: null,
    finalOutcome: null,
    resolvedAt: null,
  };
}
