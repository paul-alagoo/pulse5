// Pulse5 v0.2 Shadow Signal Engine — default thresholds.
//
// These constants are deliberately *deterministic v0.2 defaults for
// tests / replay*, not tuned trading thresholds. Tuning is reserved for a
// later phase that has actually been calibrated against historical replay
// outcomes; v0.2's only job is to build market state, score it, and label
// outcomes — *not* to predict profitable trades. Treat any change here as a
// config change to the shadow engine, not a strategy change.

/**
 * Threshold pack consumed by the signal engine. All durations are in
 * milliseconds; bps fields are absolute (10 bps = 0.10%); price fields are
 * Polymarket Yes/No probability units (0–1).
 */
export interface StrategyConfig {
  /** Reject if the latest BTC tick is older than this. */
  maxBtcTickAgeMs: number;
  /** Reject if the latest top-of-book for the chosen side is older than this. */
  maxBookAgeMs: number;
  /** Reject if the market window has less time remaining than this. */
  minTimeRemainingMs: number;
  /** Reject if the market window has more time remaining than this. */
  maxTimeRemainingMs: number;
  /** Reject if the chosen side's spread exceeds this. */
  maxSpread: number;
  /** Reject if |Chainlink - Binance| in bps exceeds this (when both feeds present). */
  maxChainlinkBinanceGapBps: number;
  /** Reject if BTC's distance from price_to_beat (in bps) is below this. */
  minDistanceBps: number;
  /** Reject if the chosen side's ask is above this. */
  maxEntryPrice: number;
  /** Reject (NO_EDGE) if the heuristic estimated probability is below this. */
  minEstimatedProbability: number;
  /** Reject (NO_EDGE) if the heuristic estimated EV is below this. */
  minEstimatedEv: number;
  /**
   * Tolerance window used by the price_to_beat fallback: when
   * `markets.price_to_beat` is null, the state builder may derive it from
   * the Chainlink BTC tick whose ts is within this many ms of the market's
   * startTime. Documented as a v0.2 fallback, not a tuned trading
   * assumption. See README v0.2 section.
   */
  priceToBeatToleranceMs: number;
}

export const DEFAULT_STRATEGY_CONFIG: StrategyConfig = {
  maxBtcTickAgeMs: 10_000,
  maxBookAgeMs: 5_000,
  minTimeRemainingMs: 15_000,
  maxTimeRemainingMs: 240_000,
  maxSpread: 0.08,
  maxChainlinkBinanceGapBps: 10,
  minDistanceBps: 10,
  maxEntryPrice: 0.75,
  minEstimatedProbability: 0.55,
  minEstimatedEv: 0.02,
  priceToBeatToleranceMs: 10_000,
};
