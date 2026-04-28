import { describe, it, expect } from 'vitest';
import type { MarketState } from '@pulse5/models';
import { generateSignal } from './signal-engine.js';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';
import {
  DEFAULT_SIGNAL_ENGINE_VERSION,
  V022_PENDING_ERROR_MESSAGE,
  generateSignalV022,
} from './index.js';

// v0.2.1 numeric output anchor. v0.2.2 design-freeze adds versioned
// scaffolding but must not change v0.2.1 outputs even by a hair. If any
// of these constants change, v0.2.1 reproducibility is broken and the
// v0.2.1 replay reports are invalidated.
const TS = new Date('2026-04-25T12:32:30Z');

function fixtureState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ts: TS,
    marketId: 'mkt-anchor',
    btcPrice: 67_500,
    btcSource: 'rtds.chainlink',
    priceToBeat: 67_000,
    distance: 500,
    distanceBps: (500 / 67_000) * 10_000,
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

describe('v0.2.1 regression — output is bit-stable under v0.2.2 scaffolding', () => {
  it('BUY_UP anchor: probability and EV match v0.2.1 closed-form', () => {
    const sig = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    expect(sig.decision).toBe('BUY_UP');
    expect(sig.side).toBe('UP');
    // v0.2.1: estimatedProbability = clamp(0.5 + min(|distBps|/100, 0.4), 0.5, 0.9)
    // distBps ≈ 74.6 → 0.5 + 0.4 = 0.9 (saturates at clamp upper bound)
    expect(sig.estimatedProbability).toBeCloseTo(0.9, 10);
    // EV = 0.9 - 0.6 = 0.3
    expect(sig.estimatedEv).toBeCloseTo(0.3, 10);
    expect(sig.price).toBe(0.6);
    expect(sig.rejectionReasons).toEqual([]);
  });

  it('BUY_DOWN anchor: probability and EV match v0.2.1 closed-form', () => {
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
    expect(sig.estimatedProbability).toBeCloseTo(0.9, 10);
    expect(sig.estimatedEv).toBeCloseTo(0.45, 10); // 0.9 - 0.45
    expect(sig.price).toBe(0.45);
  });

  it('REJECT anchor (NO_EDGE + BTC_TOO_CLOSE): rejection list matches v0.2.1', () => {
    const sig = generateSignal(
      fixtureState({ distance: 33.5, distanceBps: 5 }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(sig.decision).toBe('REJECT');
    expect(sig.rejectionReasons).toContain('BTC_TOO_CLOSE_TO_PRICE_TO_BEAT');
    // probability = 0.5 + min(5/100, 0.4) = 0.55, EV = 0.55 - 0.6 = -0.05
    // → fails both minEstimatedProbability and minEstimatedEv → NO_EDGE
    expect(sig.rejectionReasons).toContain('NO_EDGE');
    expect(sig.estimatedProbability).toBeCloseTo(0.55, 10);
    expect(sig.estimatedEv).toBeCloseTo(-0.05, 10);
  });

  it('determinism: identical inputs produce identical signals', () => {
    const a = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    const b = generateSignal(fixtureState(), DEFAULT_STRATEGY_CONFIG);
    expect(a).toEqual(b);
  });

  it('default engine version stays v0.2.1 — v0.2.2 must not promote itself', () => {
    expect(DEFAULT_SIGNAL_ENGINE_VERSION).toBe('v0.2.1');
  });

  it('the v0.2.2 stub is reachable through the public package surface and fails closed', () => {
    // Calling the v0.2.2 stub via the package index must throw — proves
    // the stub is wired through index.ts and that no caller can fall
    // through to "v0.2.2 behavior" silently.
    expect(() =>
      generateSignalV022(fixtureState(), DEFAULT_STRATEGY_CONFIG)
    ).toThrow(V022_PENDING_ERROR_MESSAGE);
  });
});
