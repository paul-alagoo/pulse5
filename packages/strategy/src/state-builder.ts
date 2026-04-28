// Pulse5 v0.2 — pure market state builder.
//
// Builds a `MarketState` snapshot from the Market metadata plus the latest
// receive_ts-visible book / tick rows. Pure: no DB, no fetch, no clock —
// the caller passes `targetTimestamp`. Live and replay both call this.
//
// Replay safety:
//   - The caller is responsible for filtering inputs by `receive_ts <=
//     targetTimestamp`. This module only consumes what it is given; it
//     does NOT look at `markets.final_outcome` or `markets.status`.
//   - When `market.priceToBeat` is null, this module may derive a fallback
//     from a Chainlink BTC tick near `market.startTime` (within
//     `config.priceToBeatToleranceMs`). If still missing, `data_complete`
//     stays false and the signal engine rejects with `PRICE_TO_BEAT_MISSING`.

import type { BookSnapshot, BtcTick, Market, MarketState } from '@pulse5/models';
import type { StrategyConfig } from './config.js';

export interface StateBuilderInput {
  market: Market;
  /** Latest book snapshot for `market.upTokenId` visible at `targetTimestamp`. */
  upBook: BookSnapshot | null;
  /** Latest book snapshot for `market.downTokenId` visible at `targetTimestamp`. */
  downBook: BookSnapshot | null;
  /** Latest visible Chainlink tick (preferred for btcPrice). */
  chainlinkTick: BtcTick | null;
  /** Latest visible Binance tick. Used for the gap check and as a fallback btcPrice. */
  binanceTick: BtcTick | null;
  /**
   * Optional Chainlink tick near `market.startTime` used to derive a
   * fallback `priceToBeat` when `market.priceToBeat` is null. Caller picks
   * the nearest tick within `config.priceToBeatToleranceMs`; the builder
   * verifies the ts proximity defensively.
   */
  priceToBeatFallbackTick?: BtcTick | null;
  /** When this state is being built. Replay passes a historical timestamp. */
  targetTimestamp: Date;
}

function ageMs(receiveTs: Date, target: Date): number {
  return target.getTime() - receiveTs.getTime();
}

function isFinitePositive(n: number | null | undefined): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

/**
 * Builds a MarketState. The function is total — it never throws on
 * incomplete input; instead `dataComplete=false` and `stale` reflect the
 * shortcomings, and the engine downstream maps them to rejection reasons.
 */
export function buildMarketState(
  input: StateBuilderInput,
  config: StrategyConfig
): MarketState {
  const { market, upBook, downBook, chainlinkTick, binanceTick, targetTimestamp } = input;

  // BTC price: prefer Chainlink (the resolution feed), fall back to Binance.
  // Frozen design (v0.2.2-estimator-design-note §5): the Binance fallback
  // is used when the most recent Chainlink tick is missing OR stale per
  // `maxBtcTickAgeMs`. A stale Chainlink tick must NOT be selected when a
  // fresh Binance tick is available, otherwise the stale price would leak
  // into the estimator's features.
  const chainlinkUsable =
    chainlinkTick !== null && Number.isFinite(chainlinkTick.price);
  const chainlinkAgeMs = chainlinkUsable
    ? ageMs(chainlinkTick.receiveTs, targetTimestamp)
    : null;
  const chainlinkFresh =
    chainlinkUsable && chainlinkAgeMs !== null && chainlinkAgeMs <= config.maxBtcTickAgeMs;
  const binanceUsable =
    binanceTick !== null && Number.isFinite(binanceTick.price);
  const binanceAgeMs = binanceUsable
    ? ageMs(binanceTick.receiveTs, targetTimestamp)
    : null;
  const binanceFresh =
    binanceUsable && binanceAgeMs !== null && binanceAgeMs <= config.maxBtcTickAgeMs;

  let btcPrice: number | null = null;
  let btcSource: MarketState['btcSource'] = null;
  let btcTickAgeMs: number | null = null;

  if (chainlinkFresh) {
    btcPrice = chainlinkTick.price;
    btcSource = chainlinkTick.source;
    btcTickAgeMs = chainlinkAgeMs;
  } else if (binanceFresh) {
    btcPrice = binanceTick.price;
    btcSource = binanceTick.source;
    btcTickAgeMs = binanceAgeMs;
  } else if (chainlinkUsable) {
    // Both feeds are missing-or-stale and Chainlink is at least present —
    // surface its (stale) value so downstream `stale=true` plus
    // `STALE_BTC_TICK` rejection still fire deterministically.
    btcPrice = chainlinkTick.price;
    btcSource = chainlinkTick.source;
    btcTickAgeMs = chainlinkAgeMs;
  } else if (binanceUsable) {
    btcPrice = binanceTick.price;
    btcSource = binanceTick.source;
    btcTickAgeMs = binanceAgeMs;
  }

  // priceToBeat: prefer market.priceToBeat; otherwise the Chainlink-tick
  // fallback if it is within tolerance of market.startTime. The fallback is
  // documented as a v0.2 escape hatch — not a tuned trading assumption —
  // because v0.1's discovery does not always populate `markets.price_to_beat`.
  let priceToBeat: number | null = null;
  if (market.priceToBeat !== null && Number.isFinite(market.priceToBeat)) {
    priceToBeat = market.priceToBeat;
  } else if (input.priceToBeatFallbackTick) {
    const tick = input.priceToBeatFallbackTick;
    const proximityMs = Math.abs(tick.ts.getTime() - market.startTime.getTime());
    if (proximityMs <= config.priceToBeatToleranceMs && Number.isFinite(tick.price)) {
      priceToBeat = tick.price;
    }
  }

  const distance =
    btcPrice !== null && priceToBeat !== null ? btcPrice - priceToBeat : null;
  const distanceBps =
    distance !== null && priceToBeat !== null && priceToBeat !== 0
      ? (distance / priceToBeat) * 10_000
      : null;

  const timeRemainingMs = market.endTime.getTime() - targetTimestamp.getTime();

  const upBestBid = upBook?.bestBid ?? null;
  const upBestAsk = upBook?.bestAsk ?? null;
  const downBestBid = downBook?.bestBid ?? null;
  const downBestAsk = downBook?.bestAsk ?? null;

  const upSpread =
    upBestBid !== null && upBestAsk !== null ? upBestAsk - upBestBid : null;
  const downSpread =
    downBestBid !== null && downBestAsk !== null ? downBestAsk - downBestBid : null;

  const upBookAgeMs = upBook ? ageMs(upBook.receiveTs, targetTimestamp) : null;
  const downBookAgeMs = downBook ? ageMs(downBook.receiveTs, targetTimestamp) : null;

  let chainlinkBinanceGapBps: number | null = null;
  if (
    chainlinkTick &&
    binanceTick &&
    Number.isFinite(chainlinkTick.price) &&
    Number.isFinite(binanceTick.price) &&
    chainlinkTick.price !== 0
  ) {
    const gap = Math.abs(chainlinkTick.price - binanceTick.price);
    chainlinkBinanceGapBps = (gap / chainlinkTick.price) * 10_000;
  }

  // dataComplete: every input the engine *requires* is present and finite.
  // priceToBeat can be null and the engine will reject explicitly with
  // PRICE_TO_BEAT_MISSING, so the builder reports `dataComplete=false` in
  // that case rather than silently fabricating one.
  const dataComplete =
    btcPrice !== null &&
    priceToBeat !== null &&
    isFinitePositive(upBestAsk) &&
    isFinitePositive(downBestAsk) &&
    timeRemainingMs > 0;

  // stale: any of the available age fields exceeds the configured ceiling.
  const stale =
    (btcTickAgeMs !== null && btcTickAgeMs > config.maxBtcTickAgeMs) ||
    (upBookAgeMs !== null && upBookAgeMs > config.maxBookAgeMs) ||
    (downBookAgeMs !== null && downBookAgeMs > config.maxBookAgeMs);

  return {
    ts: targetTimestamp,
    marketId: market.marketId,
    btcPrice,
    btcSource,
    priceToBeat,
    distance,
    distanceBps,
    timeRemainingMs,
    upBestBid,
    upBestAsk,
    downBestBid,
    downBestAsk,
    upSpread,
    downSpread,
    btcTickAgeMs,
    upBookAgeMs,
    downBookAgeMs,
    chainlinkBinanceGapBps,
    dataComplete,
    stale,
  };
}
