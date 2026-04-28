// Pulse5 v0.2.3 — frozen v0.2.2 estimator tests.
//
// These are the active, behavior-bearing tests v0.2.2 reserved as
// `it.todo` placeholders. v0.2.3 owns implementing the estimator body
// against these tests. Constants live in
// `signal-engine-v022-config.ts` and are pre-registered (frozen).

import { describe, it, expect } from 'vitest';
import type { BtcTick, MarketState } from '@pulse5/models';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';
import { generateSignalV022 } from './signal-engine-v022.js';
import {
  P_UP_CLAMP_LO,
  P_UP_CLAMP_HI,
} from './signal-engine-v022-config.js';

const T = new Date('2026-04-25T12:32:30Z');

function tickAt(offsetMs: number, price: number): BtcTick {
  const ts = new Date(T.getTime() + offsetMs);
  return {
    ts,
    receiveTs: ts,
    source: 'rtds.chainlink',
    symbol: 'BTC',
    price,
    latencyMs: null,
    rawEventId: null,
  };
}

/**
 * Build a 180s tick history at 30s cadence. Newest tick is at `T`,
 * matching `state.ts`. Prices walk linearly to `endPrice` from
 * `startPrice`. Sorted ascending by receiveTs.
 */
function tickHistory(startPrice: number, endPrice: number): BtcTick[] {
  const offsets = [-180_000, -150_000, -120_000, -90_000, -60_000, -30_000, 0];
  return offsets.map((dt, i) => {
    const f = i / (offsets.length - 1);
    return tickAt(dt, startPrice + (endPrice - startPrice) * f);
  });
}

function fixtureState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ts: T,
    marketId: 'mkt-1',
    btcPrice: 67_500,
    btcSource: 'rtds.chainlink',
    priceToBeat: 67_000,
    distance: 500,
    distanceBps: (500 / 67_000) * 10_000, // ≈ 74.63
    timeRemainingMs: 120_000,
    upBestBid: 0.55,
    upBestAsk: 0.6,
    downBestBid: 0.4,
    downBestAsk: 0.45,
    upSpread: 0.05,
    downSpread: 0.05,
    btcTickAgeMs: 0,
    upBookAgeMs: 800,
    downBookAgeMs: 900,
    chainlinkBinanceGapBps: 1.0,
    dataComplete: true,
    stale: false,
    ...overrides,
  };
}

describe('generateSignalV022 — frozen estimator behavior', () => {
  it('clamps pUp into [P_UP_CLAMP_LO, P_UP_CLAMP_HI]', () => {
    // Drive features to a saturating-up regime: very large positive
    // signedDistanceBps + positive momentum + low vol so logit > 10.
    // Without the clamp pUp would round to 1.0; with the clamp it caps
    // at P_UP_CLAMP_HI = 0.98.
    const upState = fixtureState({
      btcPrice: 73_700, // + 6_700 → ~1000 bps
      distance: 6_700,
      distanceBps: (6_700 / 67_000) * 10_000, // 1000 bps
    });
    const upTicks = tickHistory(67_000, 73_700);
    const upSig = generateSignalV022(
      { state: upState, recentBtcTicks: upTicks },
      DEFAULT_STRATEGY_CONFIG
    );
    expect(upSig.estimatedProbability).not.toBeNull();
    if (upSig.side === 'UP' && upSig.estimatedProbability !== null) {
      expect(upSig.estimatedProbability).toBeLessThanOrEqual(P_UP_CLAMP_HI);
      expect(upSig.estimatedProbability).toBeGreaterThanOrEqual(P_UP_CLAMP_LO);
      // saturation case: must hit the upper clamp
      expect(upSig.estimatedProbability).toBeCloseTo(P_UP_CLAMP_HI, 10);
    }

    // Mirror: saturating-down regime hits the lower clamp on pUp; the
    // *recorded* estimatedProbability for a BUY_DOWN signal is pDown =
    // 1 - pUp = 1 - P_UP_CLAMP_LO.
    const downState = fixtureState({
      btcPrice: 60_300, // - 6_700
      distance: -6_700,
      distanceBps: -(6_700 / 67_000) * 10_000,
    });
    const downTicks = tickHistory(67_000, 60_300);
    const downSig = generateSignalV022(
      { state: downState, recentBtcTicks: downTicks },
      DEFAULT_STRATEGY_CONFIG
    );
    if (downSig.side === 'DOWN' && downSig.estimatedProbability !== null) {
      expect(downSig.estimatedProbability).toBeCloseTo(1 - P_UP_CLAMP_LO, 10);
    }
  });

  it('records pDown = 1 - pUp by construction (binary market)', () => {
    // Both pUp and pDown are written into the per-signal features so
    // post-hoc analysis can read either. The binary-market contract is
    // pDown = 1 - pUp exactly. Run for both an up-leaning and a
    // down-leaning state to be sure the invariant holds for either
    // selected side.
    const states = [
      fixtureState(),
      fixtureState({
        btcPrice: 66_500,
        distance: -500,
        distanceBps: -(500 / 67_000) * 10_000,
      }),
    ];
    const histories = [tickHistory(67_000, 67_500), tickHistory(67_500, 66_500)];
    for (let i = 0; i < states.length; i += 1) {
      const sig = generateSignalV022(
        { state: states[i]!, recentBtcTicks: histories[i]! },
        DEFAULT_STRATEGY_CONFIG
      );
      const pUp = sig.features.pUp;
      const pDown = sig.features.pDown;
      expect(typeof pUp).toBe('number');
      expect(typeof pDown).toBe('number');
      if (typeof pUp === 'number' && typeof pDown === 'number') {
        expect(pUp + pDown).toBeCloseTo(1, 10);
      }
    }
  });

  it('extracts recentMomentumBps from the last 60 s of visible BTC ticks', () => {
    // Two histories chosen so they have the SAME set of consecutive
    // log-returns (so realizedVolatilityBps is identical — sample stdev
    // is order-independent) but DIFFERENT t-60s baseline prices (so
    // momentum differs). All other state fields are identical.
    //
    // ticksHigh: baseline at t-60s = 67_000; current = 67_500 →
    //            momentum ≈ +74.6 bps.
    // ticksLow:  baseline at t-60s = 67_500; current = 67_500 →
    //            momentum = 0 bps.
    // Returns are the same multiset {0, 0, ln(67500/67000)} just
    // permuted, so vol matches by sample-stdev order-independence.
    const ticksHigh: BtcTick[] = [
      tickAt(-180_000, 67_000),
      tickAt(-120_000, 67_000),
      tickAt(-60_000, 67_000),
      tickAt(0, 67_500),
    ];
    const ticksLow: BtcTick[] = [
      tickAt(-180_000, 67_000),
      tickAt(-120_000, 67_000),
      tickAt(-60_000, 67_500),
      tickAt(0, 67_500),
    ];
    const sigHigh = generateSignalV022(
      { state: fixtureState(), recentBtcTicks: ticksHigh },
      DEFAULT_STRATEGY_CONFIG
    );
    const sigLow = generateSignalV022(
      { state: fixtureState(), recentBtcTicks: ticksLow },
      DEFAULT_STRATEGY_CONFIG
    );
    // Sanity: vol identical (set of log returns is the same multiset).
    expect(sigHigh.features.realizedVolatilityBps).toBe(
      sigLow.features.realizedVolatilityBps
    );
    // Momentum strictly higher in `sigHigh`.
    expect(sigHigh.features.recentMomentumBps).toBeGreaterThan(
      sigLow.features.recentMomentumBps as number
    );
    // beta2 > 0 → higher momentum drives higher pUp.
    expect(sigHigh.features.pUp as number).toBeGreaterThan(
      sigLow.features.pUp as number
    );
  });

  it('computes realizedVolatilityBps over the last 180 s of visible ticks', () => {
    // Flat history → realizedVolatilityBps = 0 → normalizedDistance uses
    // the volatility floor. Wavy history with the SAME endpoints → vol >
    // 0 → normalizedDistance is smaller (denominator larger) → pUp is
    // smaller too. This proves the volatility window is consulted, and
    // proves it spans more than just the last few ticks (the wavy
    // history's mid-window swings would be invisible to a 60s-only
    // window).
    const flatTicks: BtcTick[] = [
      tickAt(-180_000, 67_500),
      tickAt(-120_000, 67_500),
      tickAt(-60_000, 67_500),
      tickAt(0, 67_500),
    ];
    const wavyTicks: BtcTick[] = [
      tickAt(-180_000, 67_500),
      tickAt(-150_000, 67_300), // dip
      tickAt(-120_000, 67_700), // peak
      tickAt(-90_000, 67_300), // dip
      tickAt(-60_000, 67_700), // peak
      tickAt(-30_000, 67_300),
      tickAt(0, 67_500),
    ];
    const flatSig = generateSignalV022(
      { state: fixtureState(), recentBtcTicks: flatTicks },
      DEFAULT_STRATEGY_CONFIG
    );
    const wavySig = generateSignalV022(
      { state: fixtureState(), recentBtcTicks: wavyTicks },
      DEFAULT_STRATEGY_CONFIG
    );
    expect(flatSig.estimatedProbability).not.toBeNull();
    expect(wavySig.estimatedProbability).not.toBeNull();
    if (
      flatSig.estimatedProbability !== null &&
      wavySig.estimatedProbability !== null
    ) {
      // beta4 < 0 (vol pulls toward 0.5) and beta5 > 0 with smaller
      // normalizedDistance under high vol → wavy pUp < flat pUp.
      expect(wavySig.estimatedProbability).toBeLessThan(flatSig.estimatedProbability);
    }
  });

  it('never reads BTC ticks with receive_ts > t — no-lookahead', () => {
    const baseTicks = tickHistory(67_000, 67_500);
    // Add a "future" tick whose receive_ts > state.ts. A no-lookahead
    // estimator must produce a signal identical to one without it.
    const futureTick: BtcTick = {
      ts: new Date(T.getTime() + 30_000),
      receiveTs: new Date(T.getTime() + 30_000),
      source: 'rtds.chainlink',
      symbol: 'BTC',
      price: 99_999, // wildly different so a leak would change pUp
      latencyMs: null,
      rawEventId: null,
    };
    const honest = generateSignalV022(
      { state: fixtureState(), recentBtcTicks: baseTicks },
      DEFAULT_STRATEGY_CONFIG
    );
    const polluted = generateSignalV022(
      {
        state: fixtureState(),
        recentBtcTicks: [...baseTicks, futureTick],
      },
      DEFAULT_STRATEGY_CONFIG
    );
    expect(polluted.estimatedProbability).toBe(honest.estimatedProbability);
    expect(polluted.estimatedEv).toBe(honest.estimatedEv);
    expect(polluted.decision).toBe(honest.decision);
    expect(polluted.side).toBe(honest.side);
  });

  it('selects side as argmax(upEv, downEv) — EV-based side selection', () => {
    // Scenario A: pUp ≈ 0.5 region, but downBestAsk = 0.30 makes downEv
    // = 0.5 - 0.3 = 0.2; upBestAsk = 0.55 makes upEv = 0.5 - 0.55 =
    // -0.05. EV-based selection must pick DOWN even though
    // signedDistanceBps is mildly positive.
    const ticks = [
      tickAt(-180_000, 67_000),
      tickAt(-120_000, 67_000),
      tickAt(-60_000, 67_000), // momentum baseline
      tickAt(0, 67_005), // tiny positive distance
    ];
    const evState = fixtureState({
      btcPrice: 67_005,
      distance: 5,
      distanceBps: (5 / 67_000) * 10_000, // ≈ 0.75 bps — tiny
      upBestAsk: 0.55,
      upBestBid: 0.5,
      upSpread: 0.05,
      downBestAsk: 0.30,
      downBestBid: 0.25,
      downSpread: 0.05,
    });
    const sig = generateSignalV022(
      { state: evState, recentBtcTicks: ticks },
      DEFAULT_STRATEGY_CONFIG
    );
    // pUp is near 0.5; downEv >> upEv → side must be DOWN.
    expect(sig.side).toBe('DOWN');
    expect(sig.decision).toBe('BUY_DOWN');
    expect(sig.price).toBe(0.30);
    if (sig.estimatedEv !== null) {
      expect(sig.estimatedEv).toBeGreaterThan(0);
    }
  });
});
