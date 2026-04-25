import { describe, it, expect, vi } from 'vitest';
import {
  createMarketWebSocket,
  normalizeBookEvent,
  normalizePriceChangeEvent,
  normalizeBestBidAskEvent,
  type ClobBookEvent,
  type ClobPriceChangeEvent,
  type ClobBestBidAskEvent,
  type ClobMessageHandler,
  type ClobRawEvent,
  type WebSocketLike,
} from './market-ws.js';

// ---------------------------------------------------------------------------
// Fixture helpers.
// ---------------------------------------------------------------------------

function bookEvent(overrides: Partial<ClobBookEvent> = {}): ClobBookEvent {
  return {
    event_type: 'book',
    market: '0xmarket',
    asset_id: 'tok-up',
    timestamp: '1714000000000',
    hash: 'h',
    bids: [
      { price: '0.50', size: '100' },
      { price: '0.49', size: '50' },
    ],
    asks: [
      { price: '0.55', size: '200' },
      { price: '0.56', size: '40' },
    ],
    ...overrides,
  };
}

function priceChangeEvent(overrides: Partial<ClobPriceChangeEvent> = {}): ClobPriceChangeEvent {
  return {
    event_type: 'price_change',
    market: '0xmarket',
    timestamp: '1714000001000',
    price_changes: [
      {
        asset_id: 'tok-up',
        price: '0.51',
        size: '10',
        side: 'BUY',
        hash: 'a',
        best_bid: '0.50',
        best_ask: '0.55',
      },
    ],
    ...overrides,
  };
}

function bestBidAskEvent(overrides: Partial<ClobBestBidAskEvent> = {}): ClobBestBidAskEvent {
  return {
    event_type: 'best_bid_ask',
    market: '0xmarket',
    asset_id: 'tok-up',
    timestamp: '1714000002000',
    best_bid: '0.50',
    best_ask: '0.55',
    best_bid_size: '100',
    best_ask_size: '200',
    ...overrides,
  };
}

// In-memory WebSocket double. Captures sends, exposes lifecycle triggers.
interface FakeWs extends WebSocketLike {
  sent: string[];
  fireOpen(): void;
  fireMessage(data: string | Buffer): void;
  fireClose(code?: number, reason?: string): void;
  fireError(err: Error): void;
}

function createFakeWs(): FakeWs {
  const listeners: Record<string, Array<(...args: unknown[]) => void>> = {};
  const sent: string[] = [];
  let readyState = 0; // CONNECTING

  const ws: FakeWs = {
    sent,
    readyState,
    send(data: string): void {
      sent.push(data);
    },
    close(): void {
      readyState = 3;
      ws.readyState = 3;
    },
    on(event: string, listener: (...args: unknown[]) => void): FakeWs {
      (listeners[event] ??= []).push(listener);
      return ws;
    },
    removeAllListeners(): void {
      for (const k of Object.keys(listeners)) listeners[k] = [];
    },
    ping(): void {
      sent.push('__ping__');
    },
    fireOpen(): void {
      readyState = 1;
      ws.readyState = 1;
      for (const l of listeners['open'] ?? []) l();
    },
    fireMessage(data: string | Buffer): void {
      for (const l of listeners['message'] ?? []) l(data);
    },
    fireClose(code = 1000, reason = ''): void {
      readyState = 3;
      ws.readyState = 3;
      for (const l of listeners['close'] ?? []) l(code, reason);
    },
    fireError(err: Error): void {
      for (const l of listeners['error'] ?? []) l(err);
    },
  };
  return ws;
}

function recordingHandler(): {
  handler: ClobMessageHandler;
  onRawEvent: ReturnType<typeof vi.fn>;
  onNormalizedBookSnapshot: ReturnType<typeof vi.fn>;
  onConnect: ReturnType<typeof vi.fn>;
  onDisconnect: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
  rawEvents: ClobRawEvent[];
} {
  const rawEvents: ClobRawEvent[] = [];
  let nextId = 1n;
  const onRawEvent = vi.fn(async (ev: ClobRawEvent): Promise<bigint | null> => {
    rawEvents.push(ev);
    const id = nextId;
    nextId += 1n;
    return id;
  });
  const onNormalizedBookSnapshot = vi.fn(async () => undefined);
  const onConnect = vi.fn();
  const onDisconnect = vi.fn();
  const onError = vi.fn();
  return {
    handler: { onRawEvent, onNormalizedBookSnapshot, onConnect, onDisconnect, onError },
    onRawEvent,
    onNormalizedBookSnapshot,
    onConnect,
    onDisconnect,
    onError,
    rawEvents,
  };
}

// ---------------------------------------------------------------------------
// Pure normalizer tests.
// ---------------------------------------------------------------------------

describe('normalizeBookEvent', () => {
  it('picks the highest bid and lowest ask regardless of input order', () => {
    const result = normalizeBookEvent(bookEvent());
    expect(result.bid.bestPrice).toBe(0.5);
    expect(result.bid.bestSize).toBe(100);
    expect(result.ask.bestPrice).toBe(0.55);
    expect(result.ask.bestSize).toBe(200);
    expect(result.spread).toBeCloseTo(0.05, 5);
    expect(result.sourceTs?.getTime()).toBe(1714000000000);
    expect(result.tokenId).toBe('tok-up');
  });

  it('handles empty book sides as nulls', () => {
    const result = normalizeBookEvent(bookEvent({ bids: [], asks: [] }));
    expect(result.bid.bestPrice).toBeNull();
    expect(result.ask.bestPrice).toBeNull();
    expect(result.spread).toBeNull();
  });

  it('returns null sourceTs on malformed timestamp', () => {
    const result = normalizeBookEvent(bookEvent({ timestamp: 'not-a-number' }));
    expect(result.sourceTs).toBeNull();
  });

  it('skips levels with non-numeric prices', () => {
    const result = normalizeBookEvent(
      bookEvent({
        bids: [
          { price: 'oops', size: '1' },
          { price: '0.40', size: '5' },
        ],
      })
    );
    expect(result.bid.bestPrice).toBe(0.4);
  });
});

describe('normalizePriceChangeEvent', () => {
  it('emits one snapshot per change item with sizes left null', () => {
    const result = normalizePriceChangeEvent(priceChangeEvent());
    expect(result).toHaveLength(1);
    expect(result[0]!.bid.bestPrice).toBe(0.5);
    expect(result[0]!.bid.bestSize).toBeNull();
    expect(result[0]!.ask.bestPrice).toBe(0.55);
    expect(result[0]!.spread).toBeCloseTo(0.05, 5);
  });

  it('returns null bid/ask when payload is missing fields', () => {
    const result = normalizePriceChangeEvent(
      priceChangeEvent({
        price_changes: [
          {
            asset_id: 'tok-down',
            price: '0.5',
            size: '1',
            side: 'SELL',
            hash: 'h',
            best_bid: '',
            best_ask: '',
          },
        ],
      })
    );
    expect(result[0]!.bid.bestPrice).toBeNull();
    expect(result[0]!.spread).toBeNull();
  });
});

describe('normalizeBestBidAskEvent', () => {
  it('extracts best bid / ask plus best-level sizes', () => {
    const result = normalizeBestBidAskEvent(bestBidAskEvent());
    expect(result.bid.bestPrice).toBe(0.5);
    expect(result.bid.bestSize).toBe(100);
    expect(result.ask.bestPrice).toBe(0.55);
    expect(result.ask.bestSize).toBe(200);
    expect(result.spread).toBeCloseTo(0.05, 5);
  });

  it('returns null bid/ask/spread when fields missing', () => {
    const result = normalizeBestBidAskEvent(
      bestBidAskEvent({ best_bid: undefined, best_ask: undefined })
    );
    expect(result.bid.bestPrice).toBeNull();
    expect(result.ask.bestPrice).toBeNull();
    expect(result.spread).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WebSocket client behavioural tests.
// ---------------------------------------------------------------------------

describe('createMarketWebSocket — handshake', () => {
  it('sends an init message with custom_feature_enabled=true and the desired token set on open', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up', 'tok-down']);
    fake.fireOpen();

    expect(fake.sent.length).toBeGreaterThanOrEqual(1);
    const init = JSON.parse(fake.sent[0]!) as Record<string, unknown>;
    expect(init['type']).toBe('market');
    expect(init['custom_feature_enabled']).toBe(true);
    expect(init['assets_ids']).toEqual(['tok-up', 'tok-down']);
    expect(rec.onConnect).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it('subscribe before open buffers the tokens into the init payload (no separate op)', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    // Only the init message should have been sent, no follow-up subscribe op.
    expect(fake.sent).toHaveLength(1);
    await ws.close();
  });

  it('subscribe after open sends a subscribe operation with custom_feature_enabled=true', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.sent.length = 0;

    await ws.subscribe(['tok-down']);
    expect(fake.sent).toHaveLength(1);
    // The flag MUST appear on delta subscribes too — without it the server
    // can interpret the new tokens as default-feature-set and silently
    // stop emitting best_bid_ask / new_market / market_resolved for them.
    expect(JSON.parse(fake.sent[0]!)).toEqual({
      operation: 'subscribe',
      assets_ids: ['tok-down'],
      custom_feature_enabled: true,
    });
    await ws.close();
  });

  it('unsubscribe after open sends an unsubscribe operation with custom_feature_enabled=true', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up', 'tok-down']);
    fake.fireOpen();
    fake.sent.length = 0;

    await ws.unsubscribe(['tok-down']);
    // Symmetry with subscribe: the upstream typing
    // (`UnsubscribeMessage.custom_feature_enabled?: boolean`) accepts the
    // flag here. We send it for connection-wide consistency rather than
    // for any per-asset effect at teardown.
    expect(JSON.parse(fake.sent[0]!)).toEqual({
      operation: 'unsubscribe',
      assets_ids: ['tok-down'],
      custom_feature_enabled: true,
    });
    expect(ws.getAssetIds()).toEqual(['tok-up']);
    await ws.close();
  });

  it('subscribe / unsubscribe with empty arrays is a no-op', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe([]);
    await ws.unsubscribe([]);
    expect(fake.sent).toHaveLength(0);
  });
});

describe('createMarketWebSocket — event dispatch', () => {
  function setupOpen(): {
    fake: FakeWs;
    rec: ReturnType<typeof recordingHandler>;
    ws: ReturnType<typeof createMarketWebSocket>;
  } {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
      now: () => 1714000099999,
    });
    return { fake, rec, ws };
  }

  it('routes book events to onRawEvent + onNormalizedBookSnapshot with rawEventId threaded', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify([bookEvent()]));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    expect(rec.onNormalizedBookSnapshot).toHaveBeenCalledTimes(1);
    const snap = rec.onNormalizedBookSnapshot.mock.calls[0]![0] as { rawEventId: bigint | null };
    expect(snap.rawEventId).toBe(1n);
    await ws.close();
  });

  it('emits one raw event per price_change message and N normalized snapshots, all with the same rawEventId', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(
      JSON.stringify([
        priceChangeEvent({
          price_changes: [
            { asset_id: 'tok-up', price: '0.51', size: '1', side: 'BUY', hash: 'a', best_bid: '0.50', best_ask: '0.55' },
            { asset_id: 'tok-up', price: '0.52', size: '2', side: 'BUY', hash: 'b', best_bid: '0.51', best_ask: '0.56' },
          ],
        }),
      ])
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    expect(rec.onNormalizedBookSnapshot).toHaveBeenCalledTimes(2);
    const calls = rec.onNormalizedBookSnapshot.mock.calls.map((c) => c[0] as { rawEventId: bigint | null });
    expect(calls[0]!.rawEventId).toBe(1n);
    expect(calls[1]!.rawEventId).toBe(1n);
    await ws.close();
  });

  it('routes best_bid_ask to raw + one normalized snapshot', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify([bestBidAskEvent()]));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    const raw = rec.onRawEvent.mock.calls[0]![0] as ClobRawEvent;
    expect(raw.eventType).toBe('best_bid_ask');
    expect(rec.onNormalizedBookSnapshot).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it('persists new_market raw-only', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(
      JSON.stringify([
        { event_type: 'new_market', market: '0xnew', asset_id: 'tok-new', timestamp: '1714000003000', slug: 'btc-updown-5m-1714000200' },
      ])
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    expect(rec.onRawEvent.mock.calls[0]![0].eventType).toBe('new_market');
    expect(rec.onNormalizedBookSnapshot).not.toHaveBeenCalled();
    await ws.close();
  });

  it('persists market_resolved raw-only', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(
      JSON.stringify([
        { event_type: 'market_resolved', market: '0xres', asset_id: 'tok-up', outcome: 'YES' },
      ])
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent.mock.calls[0]![0].eventType).toBe('market_resolved');
    expect(rec.onNormalizedBookSnapshot).not.toHaveBeenCalled();
    await ws.close();
  });

  it('persists unknown event types raw-only without throwing', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify([{ event_type: 'mystery_event', market: '0x', foo: 1 }]));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    expect(rec.onRawEvent.mock.calls[0]![0].eventType).toBe('unknown');
    expect(rec.onError).not.toHaveBeenCalled();
    await ws.close();
  });

  it('does not emit a normalized snapshot when raw insert fails (no orphan)', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    rec.onRawEvent.mockImplementationOnce(async () => {
      throw new Error('db down');
    });
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify([bookEvent()]));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onError).toHaveBeenCalled();
    expect(rec.onNormalizedBookSnapshot).not.toHaveBeenCalled();
    await ws.close();
  });

  it('handles fragmented Buffer[] payloads by concatenating bytes (not Array.toString)', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    const json = JSON.stringify([bookEvent()]);
    const half = Math.floor(json.length / 2);
    fake.fireMessage([Buffer.from(json.slice(0, half)), Buffer.from(json.slice(half))]);
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onError).not.toHaveBeenCalled();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it('handles ArrayBuffer payloads', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    const buf = Buffer.from(JSON.stringify([bookEvent()]));
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    fake.fireMessage(ab as unknown as Buffer);
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onError).not.toHaveBeenCalled();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it('handles single-object payloads (not wrapped in array)', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify(bookEvent()));
    await Promise.resolve();
    await Promise.resolve();
    expect(rec.onRawEvent).toHaveBeenCalledTimes(1);
    await ws.close();
  });

  it('ignores PONG keepalive frames', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage('PONG');
    fake.fireMessage('pong');
    await Promise.resolve();
    expect(rec.onRawEvent).not.toHaveBeenCalled();
    expect(rec.onError).not.toHaveBeenCalled();
    await ws.close();
  });

  it('reports a parse error on garbage payloads', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage('not-json');
    await Promise.resolve();
    expect(rec.onError).toHaveBeenCalled();
    await ws.close();
  });

  it('reports an error and skips events missing event_type', async () => {
    const { fake, rec, ws } = setupOpen();
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    fake.fireMessage(JSON.stringify([{ market: '0x', no_event_type: true }]));
    await Promise.resolve();
    expect(rec.onError).toHaveBeenCalled();
    expect(rec.onRawEvent).not.toHaveBeenCalled();
    await ws.close();
  });
});

describe('createMarketWebSocket — reconnect', () => {
  it('schedules a reconnect on close and re-sends the init payload with the desired token set', async () => {
    vi.useFakeTimers();
    try {
      const fakes: FakeWs[] = [];
      const rec = recordingHandler();
      const ws = createMarketWebSocket({
        handler: rec.handler,
        webSocketFactory: () => {
          const f = createFakeWs();
          fakes.push(f);
          return f;
        },
        autoReconnect: true,
        reconnectMinMs: 10,
        reconnectMaxMs: 100,
      });
      await ws.subscribe(['tok-up', 'tok-down']);
      fakes[0]!.fireOpen();
      fakes[0]!.fireClose(1006, 'lost');

      // First reconnect timer fires after `reconnectMinMs * 2^0` = 10ms.
      await vi.advanceTimersByTimeAsync(15);
      expect(fakes.length).toBe(2);
      fakes[1]!.fireOpen();

      const init = JSON.parse(fakes[1]!.sent[0]!) as Record<string, unknown>;
      expect(init['custom_feature_enabled']).toBe(true);
      expect(init['assets_ids']).toEqual(['tok-up', 'tok-down']);
      await ws.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() prevents further reconnects', async () => {
    vi.useFakeTimers();
    try {
      const fakes: FakeWs[] = [];
      const rec = recordingHandler();
      const ws = createMarketWebSocket({
        handler: rec.handler,
        webSocketFactory: () => {
          const f = createFakeWs();
          fakes.push(f);
          return f;
        },
        autoReconnect: true,
        reconnectMinMs: 10,
        reconnectMaxMs: 100,
      });
      await ws.subscribe(['tok-up']);
      fakes[0]!.fireOpen();
      await ws.close();
      fakes[0]!.fireClose(1006, 'lost');
      await vi.advanceTimersByTimeAsync(200);
      expect(fakes.length).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards lifecycle callbacks (connect / disconnect / error)', async () => {
    const fake = createFakeWs();
    const rec = recordingHandler();
    const ws = createMarketWebSocket({
      handler: rec.handler,
      webSocketFactory: () => fake,
      autoReconnect: false,
    });
    await ws.subscribe(['tok-up']);
    fake.fireOpen();
    expect(rec.onConnect).toHaveBeenCalled();
    fake.fireError(new Error('boom'));
    expect(rec.onError).toHaveBeenCalledWith(expect.any(Error));
    fake.fireClose(1006, 'lost');
    expect(rec.onDisconnect).toHaveBeenCalled();
    await ws.close();
  });
});
