// Pulse5 v0.2.3 — frozen v0.2.2 estimator constants.
//
// This module is the *single source of truth* for the numeric values the
// frozen v0.2.2 estimator uses. Per
// research/reports/v0.2.2-estimator-design-note.md §3 and §9, these
// constants are pre-registered: they are committed BEFORE any replay or
// holdout evaluation, and may NOT be tuned in response to replay output
// inside the same task. Any change here is a redesign that must open a
// new scoped task and a new design freeze.
//
// All windows, clamp bounds, the volatility floor, the BTC-source rule,
// the EV side-selection rule, and `v022MinEstimatedEv` are also frozen
// per the design note. Edit none of these in v0.2.3.

/**
 * Logistic intercept and feature weights for the frozen v0.2.2
 * estimator:
 *
 *   rawPUp = sigmoid(
 *       beta0
 *     + beta1 * signedDistanceBps
 *     + beta2 * recentMomentumBps
 *     + beta3 * log(timeRemainingMs)
 *     + beta4 * realizedVolatilityBps
 *     + beta5 * normalizedDistance
 *   )
 *
 * These are hand-picked heuristic constants — no parameter is fit on
 * data. Selection criteria, per design-note §3:
 *   (a) reproduce v0.2.1-style "BTC clearly above price_to_beat → pUp >
 *       0.5" behavior, and
 *   (b) give non-trivial sensitivity to momentum and volatility.
 *
 * Sanity check at signedDistanceBps=0, momentum=0, vol=0, normDist=0,
 * timeRemaining=120000:
 *   logit = 0 + 0 + 0 + 0 + 0 + 0 = 0  →  sigmoid(0) = 0.5
 *
 * Sanity check at signedDistanceBps≈74.6, momentum=10, vol=30,
 * normDist=74.6/30≈2.49:
 *   logit = 0 + 0.01*74.6 + 0.02*10 + 0 + (-0.005)*30 + 0.15*2.49
 *         ≈ 0.746 + 0.2 - 0.15 + 0.373
 *         ≈ 1.17  →  sigmoid ≈ 0.763
 *
 * Symmetric for the negative side.
 */
export const BETA_0 = 0.0;
export const BETA_1 = 0.01;
export const BETA_2 = 0.02;
export const BETA_3 = 0.0;
export const BETA_4 = -0.005;
export const BETA_5 = 0.15;

/**
 * Version-specific minimum estimated EV gate for v0.2.2.
 * Frozen per design-note §9. v0.2.2's gate is intentionally separate
 * from v0.2.1's `StrategyConfig.minEstimatedEv` so the two engines can
 * be calibrated independently.
 */
export const V022_MIN_ESTIMATED_EV = 0.02;

/** Momentum window in ms. Frozen per design-note §4. */
export const MOMENTUM_WINDOW_MS = 60_000;

/** Volatility window in ms. Frozen per design-note §4. */
export const VOLATILITY_WINDOW_MS = 180_000;

/**
 * Volatility floor (bps). Prevents division by zero / overflow when BTC
 * has been flat across the window. Frozen per design-note §4.
 */
export const VOLATILITY_FLOOR_BPS = 1.0;

/** pUp clamp lower bound. Frozen per design-note §7. */
export const P_UP_CLAMP_LO = 0.02;

/** pUp clamp upper bound. Frozen per design-note §7. */
export const P_UP_CLAMP_HI = 0.98;

/**
 * Minimum number of visible BTC ticks required to compute
 * recentMomentumBps. Need at least the current tick plus one prior tick
 * inside the 60s window. Frozen per design-note §4.
 */
export const MIN_TICKS_FOR_MOMENTUM = 2;

/**
 * Minimum number of visible BTC ticks required to compute
 * realizedVolatilityBps. Need ≥2 log returns, i.e. ≥3 ticks. Frozen per
 * design-note §4.
 */
export const MIN_TICKS_FOR_VOLATILITY = 3;
