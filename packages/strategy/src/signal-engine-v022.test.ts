import { describe, it, expect } from 'vitest';
import type { MarketState } from '@pulse5/models';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';
import {
  V022_PENDING_ERROR_MESSAGE,
  generateSignalV022,
} from './signal-engine-v022.js';

const TS = new Date('2026-04-25T12:32:30Z');

function fixtureState(overrides: Partial<MarketState> = {}): MarketState {
  return {
    ts: TS,
    marketId: 'mkt-1',
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

describe('generateSignalV022 — fail-closed stub', () => {
  it('throws V022_PENDING_ERROR_MESSAGE on a well-formed BUY_UP-shaped state', () => {
    expect(() =>
      generateSignalV022(fixtureState(), DEFAULT_STRATEGY_CONFIG)
    ).toThrow(V022_PENDING_ERROR_MESSAGE);
  });

  it('throws on a degenerate / data-incomplete state too — never silently passes', () => {
    expect(() =>
      generateSignalV022(
        fixtureState({
          priceToBeat: null,
          distance: null,
          distanceBps: null,
          dataComplete: false,
        }),
        DEFAULT_STRATEGY_CONFIG
      )
    ).toThrow(/v0\.2\.3 implementation pending/);
  });

  it('throws on a stale state — there is no data path through this stub', () => {
    expect(() =>
      generateSignalV022(
        fixtureState({
          btcTickAgeMs: DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs + 1,
          stale: true,
        }),
        DEFAULT_STRATEGY_CONFIG
      )
    ).toThrow(Error);
  });

  it('error message names v0.2.3 as the owner so callers know where to look', () => {
    expect(V022_PENDING_ERROR_MESSAGE).toMatch(/v0\.2\.3 implementation pending/);
    expect(V022_PENDING_ERROR_MESSAGE).toMatch(/v0\.2\.2/);
  });
});

// The behaviors below are owned by v0.2.3, frozen in
// research/reports/v0.2.2-estimator-design-note.md. They are declared
// here as `it.todo` so v0.2.3 can convert them to active tests without
// renaming. Implementing any of them inside v0.2.2 violates the
// design-freeze scope.
describe('generateSignalV022 — v0.2.3 behavior placeholders', () => {
  it.todo('clamps pUp into [0.02, 0.98] — v0.2.3 implementation pending');
  it.todo('returns pDown = 1 - pUp by construction — v0.2.3 implementation pending');
  it.todo(
    'extracts recentMomentumBps from the last 60 s of visible BTC ticks — v0.2.3 implementation pending'
  );
  it.todo(
    'extracts realizedVolatilityBps from the last 180 s of visible BTC ticks — v0.2.3 implementation pending'
  );
  it.todo(
    'never reads BTC ticks with receive_ts > t — no-lookahead — v0.2.3 implementation pending'
  );
  it.todo(
    'selects EV side as argmax of upEv vs downEv — v0.2.3 implementation pending'
  );
});
