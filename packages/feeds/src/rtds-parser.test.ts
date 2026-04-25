import { describe, it, expect } from 'vitest';
import { parseRtdsCryptoPrice } from './rtds-parser.js';

const RECEIVE = new Date(1714000005_000);

describe('parseRtdsCryptoPrice — happy paths', () => {
  it('extracts price + source ts (ms) for crypto_prices/btcusdt', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: '67500.25', timestamp: 1714000004500 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceLabel).toBe('rtds.binance');
    expect(result.tick.price).toBe(67500.25);
    expect(result.tick.symbol).toBe('btcusdt');
    expect(result.tick.source).toBe('rtds.binance');
    expect(result.tick.ts.getTime()).toBe(1714000004500);
    expect(result.tick.latencyMs).toBe(500);
    expect(result.tick.receiveTs).toBe(RECEIVE);
  });

  it('handles chainlink topic and "price" alias field', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices_chainlink',
      symbol: 'BTC/USD',
      payload: { price: 67200.5, ts: 1714000004900 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.sourceLabel).toBe('rtds.chainlink');
    expect(result.tick.symbol).toBe('btc/usd');
    expect(result.tick.price).toBe(67200.5);
    expect(result.tick.latencyMs).toBe(100);
  });

  it('auto-converts seconds to ms when magnitude < 1e12', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: 67000, timestamp: 1714000000 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.ts.getTime()).toBe(1714000000_000);
  });

  it('falls back to messageTs when payload has no timestamp', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: 67000 },
      messageTs: 1714000004000,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.ts.getTime()).toBe(1714000004000);
    expect(result.tick.latencyMs).toBe(1000);
  });
});

describe('parseRtdsCryptoPrice — graceful degradation (must not crash)', () => {
  it('falls back to receiveTs as ts and null latency when source ts is missing entirely', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: 67000 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.ts).toBe(RECEIVE);
    expect(result.tick.latencyMs).toBeNull();
  });

  it('clamps negative latency to 0 (clock skew)', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: 67000, timestamp: RECEIVE.getTime() + 1000 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.latencyMs).toBe(0);
  });

  it('rejects an unknown topic without throwing', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'totally_not_a_topic',
      symbol: 'btcusdt',
      payload: { value: 1 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('unsupported topic');
  });

  it('rejects a non-object payload', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: 67000 as unknown,
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a payload with no parseable price field', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { ticker: 'btcusdt', timestamp: 1714000000000 },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('parseable price');
  });

  it('handles "p" alias and string-encoded numbers with commas', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { p: '67,500.50' },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.price).toBe(67500.5);
  });

  it('rejects malformed timestamp without crashing', () => {
    const result = parseRtdsCryptoPrice({
      topic: 'crypto_prices',
      symbol: 'btcusdt',
      payload: { value: 67000, timestamp: 'oops' },
      messageTs: null,
      receiveTs: RECEIVE,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tick.ts).toBe(RECEIVE);
    expect(result.tick.latencyMs).toBeNull();
  });
});
