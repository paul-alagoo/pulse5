import { describe, it, expect } from 'vitest';
import { MODELS_VERSION, type Market, type BookSnapshot, type BtcTick } from './index.js';

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
