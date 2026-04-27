import { describe, it, expect } from 'vitest';
import {
  MODELS_VERSION,
  type Market,
  type BookSnapshot,
  type BtcTick,
  type MarketState,
  type Signal,
  type SignalDecision,
  type SignalOutcome,
  type SignalRejectionReason,
  type SignalSide,
} from './index.js';

describe('MODELS_VERSION', () => {
  it('is a non-empty semver-ish string', () => {
    expect(typeof MODELS_VERSION).toBe('string');
    expect(MODELS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('domain model shapes (compile-time guards via runtime fixtures)', () => {
  it('Market accepts a full row with nullable conditionId / priceToBeat / finalOutcome', () => {
    const market: Market = {
      marketId: 'mkt-1',
      eventId: 'evt-1',
      slug: 'btc-updown-5m-1714000000',
      question: 'Will BTC be above $1?',
      conditionId: null,
      upTokenId: 't-up',
      downTokenId: 't-down',
      startTime: new Date(0),
      endTime: new Date(300_000),
      priceToBeat: null,
      resolutionSource: 'chainlink-btc-usd',
      status: 'open',
      finalOutcome: null,
    };
    expect(market.upTokenId).not.toBe(market.downTokenId);
  });

  it('BookSnapshot allows null sizes and spread for partial book updates', () => {
    const snap: BookSnapshot = {
      ts: new Date(),
      receiveTs: new Date(),
      marketId: 'mkt-1',
      tokenId: 't-up',
      bestBid: 0.42,
      bestAsk: 0.45,
      bidSize: null,
      askSize: null,
      spread: 0.03,
      rawEventId: null,
    };
    expect(snap.spread).toBe(0.03);
  });

  it('BtcTick allows null latencyMs for payloads without source ts', () => {
    const tick: BtcTick = {
      ts: new Date(),
      receiveTs: new Date(),
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67_000,
      latencyMs: null,
      rawEventId: null,
    };
    expect(tick.price).toBeGreaterThan(0);
  });
});

describe('v0.2 signal model shapes', () => {
  it('MarketState carries the full numeric snapshot the engine needs', () => {
    const state: MarketState = {
      ts: new Date('2026-04-25T12:32:30Z'),
      marketId: 'mkt-1',
      btcPrice: 67_500,
      btcSource: 'rtds.chainlink',
      priceToBeat: 67_250,
      distance: 250,
      distanceBps: (250 / 67_250) * 10_000,
      timeRemainingMs: 150_000,
      upBestBid: 0.55,
      upBestAsk: 0.6,
      downBestBid: 0.4,
      downBestAsk: 0.45,
      upSpread: 0.05,
      downSpread: 0.05,
      btcTickAgeMs: 500,
      upBookAgeMs: 800,
      downBookAgeMs: 900,
      chainlinkBinanceGapBps: 1.2,
      dataComplete: true,
      stale: false,
    };
    expect(state.dataComplete).toBe(true);
    expect(state.stale).toBe(false);
    expect(state.btcSource).toBe('rtds.chainlink');
  });

  it('MarketState supports incomplete state without crashing the type', () => {
    const state: MarketState = {
      ts: new Date(),
      marketId: 'mkt-1',
      btcPrice: null,
      btcSource: null,
      priceToBeat: null,
      distance: null,
      distanceBps: null,
      timeRemainingMs: null,
      upBestBid: null,
      upBestAsk: null,
      downBestBid: null,
      downBestAsk: null,
      upSpread: null,
      downSpread: null,
      btcTickAgeMs: null,
      upBookAgeMs: null,
      downBookAgeMs: null,
      chainlinkBinanceGapBps: null,
      dataComplete: false,
      stale: true,
    };
    expect(state.dataComplete).toBe(false);
  });

  it('Signal exposes accepted BUY_UP with empty rejectionReasons', () => {
    const sig: Signal = {
      id: null,
      ts: new Date(),
      marketId: 'mkt-1',
      marketStateId: null,
      decision: 'BUY_UP',
      side: 'UP',
      price: 0.6,
      estimatedProbability: 0.7,
      estimatedEv: 0.1,
      accepted: true,
      rejectionReasons: [],
      features: { distanceBps: 37.2 },
      outcome: null,
      finalOutcome: null,
      resolvedAt: null,
    };
    expect(sig.accepted).toBe(true);
    expect(sig.rejectionReasons).toEqual([]);
  });

  it('Signal exposes REJECT with one or more rejection reasons and features', () => {
    const reasons: SignalRejectionReason[] = ['NO_EDGE', 'BTC_TOO_CLOSE_TO_PRICE_TO_BEAT'];
    const sig: Signal = {
      id: null,
      ts: new Date(),
      marketId: 'mkt-1',
      marketStateId: null,
      decision: 'REJECT',
      side: null,
      price: null,
      estimatedProbability: 0.51,
      estimatedEv: -0.1,
      accepted: false,
      rejectionReasons: reasons,
      features: { distanceBps: 1.2 },
      outcome: null,
      finalOutcome: null,
      resolvedAt: null,
    };
    expect(sig.accepted).toBe(false);
    expect(sig.rejectionReasons).toContain('NO_EDGE');
  });

  it('SignalOutcome union admits exactly WIN | LOSS | NOT_APPLICABLE', () => {
    const outcomes: SignalOutcome[] = ['WIN', 'LOSS', 'NOT_APPLICABLE'];
    expect(outcomes).toHaveLength(3);
  });

  it('SignalDecision and SignalSide enum members compile', () => {
    const decisions: SignalDecision[] = ['BUY_UP', 'BUY_DOWN', 'REJECT'];
    const sides: SignalSide[] = ['UP', 'DOWN'];
    expect(decisions).toHaveLength(3);
    expect(sides).toHaveLength(2);
  });
});
