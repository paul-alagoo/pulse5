import { describe, it, expect } from 'vitest';
import type { MarketState } from '@pulse5/models';
import { generateSignal } from './signal-engine.js';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';

const TS = new Date('2026-04-25T12:32:30Z');

function fixtureState(overrides: Partial<MarketState> = {}): MarketState {
  // A "well-formed BUY_UP" baseline: BTC well above price_to_beat, fresh
  // data, generous time window, tight spread, cheap up ask.
  return {
    ts: TS,
    marketId: 'mkt-1',
    btcPrice: 67_500,
    btcSource: 'rtds.chainlink',
    priceToBeat: 67_000,
    distance: 500,
    distanceBps: (500 / 67_000) * 10_000, // ≈ 74.6 bps
    timeRemainingMs: 120_000,
    upBestBid: 0.55,
    upBestAsk: 0.6,
    downBestBid: 0.4,
    downBestAsk: 0.45,
    upSpread: 0.05,
    downSpread: 0.05,
    btcTickAgeMs: 500,
    upBookAgeMs: 800,
    downBookAgeMs: 900,
    chainlinkBinanceGapBps: 1.0,
    dataComplete: true,
    stale: false,
    ...overrides,
  };
}

describe('generateSignal — accepted', () => {
  it('accepts BUY_UP when BTC is sufficiently above price_to_beat and up ask is acceptable', () => {
    const sig = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    expect(sig.decision).toBe('BUY_UP');
    expect(sig.side).toBe('UP');
    expect(sig.accepted).toBe(true);
    expect(sig.price).toBe(0.6);
    expect(sig.rejectionReasons).toEqual([]);
    expect(sig.features).toBeDefined();
  });

  it('accepts BUY_DOWN when BTC is sufficiently below price_to_beat and down ask is acceptable', () => {
    const sig = generateSignal(
      fixtureState({
        btcPrice: 66_500,
        distance: -500,
        distanceBps: -(500 / 67_000) * 10_000,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.decision).toBe('BUY_DOWN');
    expect(sig.side).toBe('DOWN');
    expect(sig.price).toBe(0.45);
    expect(sig.rejectionReasons).toEqual([]);
  });

  it('accepted signals carry features even though rejection_reasons is empty', () => {
    const sig = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    expect(sig.features['distanceBps']).toBeCloseTo(74.6, 0);
    expect(sig.features['btcSource']).toBe('rtds.chainlink');
  });
});

describe('generateSignal — rejection reasons', () => {
  it('rejects with PRICE_TO_BEAT_MISSING when priceToBeat is null', () => {
    const sig = generateSignal(
      fixtureState({
        priceToBeat: null,
        distance: null,
        distanceBps: null,
        dataComplete: false,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.decision).toBe('REJECT');
    expect(sig.rejectionReasons).toContain('PRICE_TO_BEAT_MISSING');
    // dataComplete=false also surfaces.
    expect(sig.rejectionReasons).toContain('DATA_INCOMPLETE');
  });

  it('rejects with STALE_BTC_TICK when btcTickAgeMs exceeds threshold', () => {
    const sig = generateSignal(
      fixtureState({ btcTickAgeMs: DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs + 1, stale: true }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.decision).toBe('REJECT');
    expect(sig.rejectionReasons).toContain('STALE_BTC_TICK');
  });

  it('rejects with STALE_UP_BOOK when upBookAgeMs exceeds threshold', () => {
    const sig = generateSignal(
      fixtureState({ upBookAgeMs: DEFAULT_STRATEGY_CONFIG.maxBookAgeMs + 1, stale: true }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('STALE_UP_BOOK');
  });

  it('rejects with STALE_DOWN_BOOK when downBookAgeMs exceeds threshold (DOWN trajectory)', () => {
    const sig = generateSignal(
      fixtureState({
        btcPrice: 66_500,
        distance: -500,
        distanceBps: -(500 / 67_000) * 10_000,
        downBookAgeMs: DEFAULT_STRATEGY_CONFIG.maxBookAgeMs + 1,
        stale: true,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('STALE_DOWN_BOOK');
  });

  it('rejects with SPREAD_TOO_WIDE on the chosen side', () => {
    const sig = generateSignal(
      fixtureState({ upSpread: DEFAULT_STRATEGY_CONFIG.maxSpread + 0.01 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('SPREAD_TOO_WIDE');
  });

  it('rejects with BTC_TOO_CLOSE_TO_PRICE_TO_BEAT when |distance_bps| < minDistanceBps', () => {
    const sig = generateSignal(
      fixtureState({
        distance: 1,
        distanceBps: DEFAULT_STRATEGY_CONFIG.minDistanceBps - 1,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('BTC_TOO_CLOSE_TO_PRICE_TO_BEAT');
  });

  it('rejects with ENTRY_PRICE_TOO_EXPENSIVE when up ask exceeds maxEntryPrice', () => {
    const sig = generateSignal(
      fixtureState({ upBestAsk: DEFAULT_STRATEGY_CONFIG.maxEntryPrice + 0.01 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('ENTRY_PRICE_TOO_EXPENSIVE');
  });

  it('rejects with NO_EDGE when estimated EV falls below minEstimatedEv', () => {
    // distance is positive but tiny — probability ≈ 0.5 + 5/100 = 0.55, EV
    // = 0.55 - 0.6 = -0.05 (below minEstimatedEv=0.02).
    const sig = generateSignal(
      fixtureState({
        distance: 33.5,
        distanceBps: 5,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('NO_EDGE');
  });

  it('rejects with TIME_REMAINING_TOO_LOW when below threshold', () => {
    const sig = generateSignal(
      fixtureState({ timeRemainingMs: DEFAULT_STRATEGY_CONFIG.minTimeRemainingMs - 1 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('TIME_REMAINING_TOO_LOW');
  });

  it('rejects with TIME_REMAINING_TOO_HIGH when above threshold', () => {
    const sig = generateSignal(
      fixtureState({ timeRemainingMs: DEFAULT_STRATEGY_CONFIG.maxTimeRemainingMs + 1 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('TIME_REMAINING_TOO_HIGH');
  });

  it('rejects with BTC_FEED_GAP_TOO_LARGE when chainlink/binance gap exceeds threshold', () => {
    const sig = generateSignal(
      fixtureState({
        chainlinkBinanceGapBps: DEFAULT_STRATEGY_CONFIG.maxChainlinkBinanceGapBps + 0.1,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('BTC_FEED_GAP_TOO_LARGE');
  });

  it('rejects with no selectable side when distanceBps is exactly zero (BTC at price_to_beat)', () => {
    // distance = 0 means neither isUpward nor isDownward → no side, no
    // entry price. The engine accumulates BTC_TOO_CLOSE_TO_PRICE_TO_BEAT
    // and falls through to REJECT.
    const sig = generateSignal(
      fixtureState({ distance: 0, distanceBps: 0 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.decision).toBe('REJECT');
    expect(sig.side).toBeNull();
    expect(sig.price).toBeNull();
    expect(sig.rejectionReasons).toContain('BTC_TOO_CLOSE_TO_PRICE_TO_BEAT');
  });

  it('aggregates multiple rejection reasons rather than short-circuiting', () => {
    const sig = generateSignal(
      fixtureState({
        upBookAgeMs: DEFAULT_STRATEGY_CONFIG.maxBookAgeMs + 1,
        upBestAsk: DEFAULT_STRATEGY_CONFIG.maxEntryPrice + 0.01,
        stale: true,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.rejectionReasons).toContain('STALE_UP_BOOK');
    expect(sig.rejectionReasons).toContain('ENTRY_PRICE_TOO_EXPENSIVE');
  });

  it('rejected signals still carry features for post-hoc analysis', () => {
    const sig = generateSignal(
      fixtureState({
        upBookAgeMs: DEFAULT_STRATEGY_CONFIG.maxBookAgeMs + 1,
        stale: true,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.accepted).toBe(false);
    expect(sig.features['distanceBps']).toBeDefined();
  });
});

describe('generateSignal — purity / determinism', () => {
  it('returns the same Signal for the same MarketState and config', () => {
    const a = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    const b = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    // We exclude `id` (always null pre-persist) and compare deeply.
    expect(a).toEqual(b);
  });
});
