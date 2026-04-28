import { describe, it, expect } from 'vitest';
import type { BookSnapshot, BtcTick, Market } from '@pulse5/models';
import { buildMarketState, type StateBuilderInput } from './state-builder.js';
import { DEFAULT_STRATEGY_CONFIG } from './config.js';

const START = new Date('2026-04-25T12:30:00Z');
const END = new Date('2026-04-25T12:35:00Z');
const TARGET = new Date('2026-04-25T12:32:30Z');

function fixtureMarket(overrides: Partial<Market> = {}): Market {
  return {
    marketId: 'mkt-1',
    eventId: 'evt-1',
    slug: 'btc-updown-5m-1714000000',
    question: 'Will BTC be above $67,250 at 12:35 PM ET?',
    conditionId: 'cond-1',
    upTokenId: 'tok-up',
    downTokenId: 'tok-down',
    startTime: START,
    endTime: END,
    priceToBeat: 67_250,
    resolutionSource: 'chainlink-btc-usd',
    status: 'open',
    finalOutcome: null,
    ...overrides,
  };
}

function fixtureBook(overrides: Partial<BookSnapshot> = {}): BookSnapshot {
  return {
    ts: new Date('2026-04-25T12:32:29Z'),
    receiveTs: new Date('2026-04-25T12:32:29.500Z'),
    marketId: 'mkt-1',
    tokenId: 'tok-up',
    bestBid: 0.55,
    bestAsk: 0.6,
    bidSize: 100,
    askSize: 100,
    spread: 0.05,
    rawEventId: 1n,
    ...overrides,
  };
}

function fixtureTick(overrides: Partial<BtcTick> = {}): BtcTick {
  return {
    ts: new Date('2026-04-25T12:32:30Z'),
    receiveTs: new Date('2026-04-25T12:32:30Z'),
    source: 'rtds.chainlink',
    symbol: 'btc/usd',
    price: 67_500,
    latencyMs: 100,
    rawEventId: 1n,
    ...overrides,
  };
}

function makeInput(overrides: Partial<StateBuilderInput> = {}): StateBuilderInput {
  return {
    market: fixtureMarket(),
    upBook: fixtureBook({ tokenId: 'tok-up' }),
    downBook: fixtureBook({
      tokenId: 'tok-down',
      bestBid: 0.4,
      bestAsk: 0.45,
      spread: 0.05,
    }),
    chainlinkTick: fixtureTick(),
    binanceTick: fixtureTick({
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67_510,
    }),
    targetTimestamp: TARGET,
    ...overrides,
  };
}

describe('buildMarketState — happy path', () => {
  it('computes btcPrice / source / age from chainlink and the gap from binance', () => {
    const state = buildMarketState(makeInput(), DEFAULT_STRATEGY_CONFIG);
    expect(state.btcPrice).toBe(67_500);
    expect(state.btcSource).toBe('rtds.chainlink');
    expect(state.btcTickAgeMs).toBe(0);
    expect(state.chainlinkBinanceGapBps).toBeCloseTo(
      (Math.abs(67_500 - 67_510) / 67_500) * 10_000,
      6
    );
  });

  it('uses market.priceToBeat when present', () => {
    const state = buildMarketState(makeInput(), DEFAULT_STRATEGY_CONFIG);
    expect(state.priceToBeat).toBe(67_250);
    expect(state.distance).toBe(250);
    expect(state.distanceBps).toBeCloseTo((250 / 67_250) * 10_000, 6);
  });

  it('computes timeRemainingMs from endTime - target', () => {
    const state = buildMarketState(makeInput(), DEFAULT_STRATEGY_CONFIG);
    expect(state.timeRemainingMs).toBe(150_000);
  });

  it('extracts top-of-book and spreads for both sides', () => {
    const state = buildMarketState(makeInput(), DEFAULT_STRATEGY_CONFIG);
    expect(state.upBestBid).toBe(0.55);
    expect(state.upBestAsk).toBe(0.6);
    expect(state.downBestBid).toBe(0.4);
    expect(state.downBestAsk).toBe(0.45);
    expect(state.upSpread).toBeCloseTo(0.05, 10);
    expect(state.downSpread).toBeCloseTo(0.05, 10);
  });

  it('reports dataComplete=true and stale=false on a full payload', () => {
    const state = buildMarketState(makeInput(), DEFAULT_STRATEGY_CONFIG);
    expect(state.dataComplete).toBe(true);
    expect(state.stale).toBe(false);
  });
});

describe('buildMarketState — priceToBeat fallback', () => {
  it('derives priceToBeat from a Chainlink tick near startTime when market.priceToBeat is null', () => {
    const fallback = fixtureTick({
      ts: new Date(START.getTime() + 500),
      receiveTs: new Date(START.getTime() + 600),
      price: 67_300,
    });
    const state = buildMarketState(
      makeInput({
        market: fixtureMarket({ priceToBeat: null }),
        priceToBeatFallbackTick: fallback,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.priceToBeat).toBe(67_300);
    expect(state.distance).toBe(67_500 - 67_300);
    expect(state.dataComplete).toBe(true);
  });

  it('rejects the fallback tick when ts is outside priceToBeatToleranceMs window', () => {
    const farTick = fixtureTick({
      ts: new Date(START.getTime() + DEFAULT_STRATEGY_CONFIG.priceToBeatToleranceMs + 5_000),
    });
    const state = buildMarketState(
      makeInput({
        market: fixtureMarket({ priceToBeat: null }),
        priceToBeatFallbackTick: farTick,
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.priceToBeat).toBeNull();
    expect(state.distance).toBeNull();
    expect(state.distanceBps).toBeNull();
    expect(state.dataComplete).toBe(false);
  });

  it('reports dataComplete=false when priceToBeat is missing entirely', () => {
    const state = buildMarketState(
      makeInput({ market: fixtureMarket({ priceToBeat: null }) }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.priceToBeat).toBeNull();
    expect(state.dataComplete).toBe(false);
  });
});

describe('buildMarketState — fallback BTC source', () => {
  it('falls back to Binance when Chainlink tick is missing', () => {
    const state = buildMarketState(
      makeInput({ chainlinkTick: null }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.btcSource).toBe('rtds.binance');
    expect(state.chainlinkBinanceGapBps).toBeNull();
  });

  // Frozen design (v0.2.2-estimator-design-note §5): Binance is the
  // fallback whenever the Chainlink tick is missing OR stale (age >
  // maxBtcTickAgeMs). The previous implementation only fell back when
  // Chainlink was missing entirely — a stale Chainlink tick would still
  // be selected as `btcSource`, leaking the stale price into the
  // estimator. Test with a fresh Binance tick available.
  it('falls back to Binance when Chainlink tick is stale and Binance is fresh', () => {
    const staleChainlink = fixtureTick({
      receiveTs: new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs - 1),
      price: 67_400,
    });
    const freshBinance = fixtureTick({
      source: 'rtds.binance',
      symbol: 'btcusdt',
      receiveTs: new Date(TARGET.getTime() - 200),
      price: 67_510,
    });
    const state = buildMarketState(
      makeInput({ chainlinkTick: staleChainlink, binanceTick: freshBinance }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.btcSource).toBe('rtds.binance');
    expect(state.btcPrice).toBe(67_510);
    expect(state.btcTickAgeMs).toBe(200);
  });

  it('keeps stale Chainlink when Binance tick is missing (fail-closed via stale flag)', () => {
    const staleChainlink = fixtureTick({
      receiveTs: new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs - 1),
      price: 67_400,
    });
    const state = buildMarketState(
      makeInput({ chainlinkTick: staleChainlink, binanceTick: null }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.btcSource).toBe('rtds.chainlink');
    expect(state.btcPrice).toBe(67_400);
    expect(state.stale).toBe(true);
  });

  it('keeps stale Chainlink when Binance is also stale (no fresh fallback available)', () => {
    const staleChainlink = fixtureTick({
      receiveTs: new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs - 1),
      price: 67_400,
    });
    const staleBinance = fixtureTick({
      source: 'rtds.binance',
      symbol: 'btcusdt',
      receiveTs: new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs - 50),
      price: 67_510,
    });
    const state = buildMarketState(
      makeInput({ chainlinkTick: staleChainlink, binanceTick: staleBinance }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.btcSource).toBe('rtds.chainlink');
    expect(state.stale).toBe(true);
  });
});

describe('buildMarketState — replay safety', () => {
  it('does not consult markets.final_outcome / status (resolved markets pass through unchanged)', () => {
    const state = buildMarketState(
      makeInput({
        market: fixtureMarket({ status: 'resolved', finalOutcome: 'Up' }),
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    // The state builder is not allowed to react to settlement; the fact
    // that two resolved markets with different finalOutcomes still produce
    // identical states is the invariant we care about.
    const resolvedDown = buildMarketState(
      makeInput({
        market: fixtureMarket({ status: 'resolved', finalOutcome: 'Down' }),
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.btcPrice).toBe(resolvedDown.btcPrice);
    expect(state.priceToBeat).toBe(resolvedDown.priceToBeat);
    expect(state.distanceBps).toBe(resolvedDown.distanceBps);
    expect(state.upBestAsk).toBe(resolvedDown.upBestAsk);
  });

  it('uses the targetTimestamp the caller passed (replay does not see future receive_ts)', () => {
    const earlyTarget = new Date(TARGET.getTime() - 60_000);
    const state = buildMarketState(
      makeInput({ targetTimestamp: earlyTarget }),
      DEFAULT_STRATEGY_CONFIG
    );
    // ageMs flips negative when the only "visible" tick the caller passed
    // is actually newer than the target. The builder doesn't second-guess
    // the caller — replay correctness is the caller's job at the query
    // layer.
    expect(state.timeRemainingMs).toBe(END.getTime() - earlyTarget.getTime());
  });
});

describe('buildMarketState — null / partial book inputs', () => {
  it('treats a missing upBook as null prices, null spread, null age', () => {
    const state = buildMarketState(
      makeInput({ upBook: null }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.upBestBid).toBeNull();
    expect(state.upBestAsk).toBeNull();
    expect(state.upSpread).toBeNull();
    expect(state.upBookAgeMs).toBeNull();
    expect(state.dataComplete).toBe(false);
  });

  it('treats a missing downBook as null prices, null spread, null age', () => {
    const state = buildMarketState(
      makeInput({ downBook: null }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.downBestBid).toBeNull();
    expect(state.downBestAsk).toBeNull();
    expect(state.downSpread).toBeNull();
    expect(state.downBookAgeMs).toBeNull();
    expect(state.dataComplete).toBe(false);
  });

  it('keeps spread null when one side of the book is partially populated', () => {
    const state = buildMarketState(
      makeInput({
        upBook: fixtureBook({ bestBid: null, bestAsk: 0.6, spread: null }),
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.upBestBid).toBeNull();
    expect(state.upBestAsk).toBe(0.6);
    expect(state.upSpread).toBeNull();
  });

  it('reports dataComplete=false when the up ask is missing', () => {
    const state = buildMarketState(
      makeInput({
        upBook: fixtureBook({ bestAsk: null }),
      }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.dataComplete).toBe(false);
  });
});

describe('buildMarketState — staleness', () => {
  it('flags stale=true when btc tick age exceeds maxBtcTickAgeMs (no fresh fallback)', () => {
    // Both feeds stale: the design fallback only kicks in when Binance is
    // *fresh*, so when both are stale the state remains stale.
    const stale = (offset: number): Date =>
      new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs - offset);
    const chainlinkTick = fixtureTick({ receiveTs: stale(1) });
    const binanceTick = fixtureTick({
      source: 'rtds.binance',
      symbol: 'btcusdt',
      receiveTs: stale(50),
    });
    const state = buildMarketState(
      makeInput({ chainlinkTick, binanceTick }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.stale).toBe(true);
  });

  it('flags stale=true when up book age exceeds maxBookAgeMs', () => {
    const book = fixtureBook({
      receiveTs: new Date(TARGET.getTime() - DEFAULT_STRATEGY_CONFIG.maxBookAgeMs - 1),
    });
    const state = buildMarketState(
      makeInput({ upBook: book }),
      DEFAULT_STRATEGY_CONFIG
    );
    expect(state.stale).toBe(true);
  });
});
