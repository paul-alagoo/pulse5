// Pulse5 Polymarket CLOB market WebSocket client.
//
// We connect directly to `wss://ws-subscriptions-clob.polymarket.com/ws/market`
// rather than wrapping `@nevuamarkets/poly-websockets`. The upstream library
// does not plumb the `custom_feature_enabled: true` flag through, which the
// v0.1 spec explicitly requires so the server emits `best_bid_ask`,
// `new_market`, and `market_resolved` events. Owning the wire client also
// lets us:
//   - persist EVERY event (including unknown types) to `raw_events` losslessly,
//   - emit normalized snapshots for `book`, `price_change`, and `best_bid_ask`,
//   - reconnect with exponential backoff and re-subscribe the active token set,
//   - keep a small, focused surface that is easy to test.
//
// Wire protocol (verified against the public Polymarket CLOB v2 endpoint and
// the upstream `@nevuamarkets/poly-websockets@1.0.2` source):
//   - Initial handshake after connect:
//       { type: 'market', assets_ids: [...], custom_feature_enabled: true }
//   - Add / remove subscriptions:
//       { operation: 'subscribe',   assets_ids: [...] }
//       { operation: 'unsubscribe', assets_ids: [...] }
//   - Server pushes a JSON array of events; each event has an `event_type`
//     discriminator (`book`, `price_change`, `last_trade_price`,
//     `tick_size_change`, `best_bid_ask`, `new_market`, `market_resolved`,
//     plus future / unknown variants).
// The server does NOT send subscribe acknowledgements; we optimistically
// assume success after the send.

import WebSocket, { type RawData } from 'ws';

export const POLYMARKET_CLOB_WS_URL =
  'wss://ws-subscriptions-clob.polymarket.com/ws/market';

export type ClobEventType =
  | 'book'
  | 'price_change'
  | 'best_bid_ask'
  | 'last_trade_price'
  | 'tick_size_change'
  | 'new_market'
  | 'market_resolved'
  | 'unknown';

export interface ClobBookLevel {
  price: string;
  size: string;
}

export interface ClobBookEvent {
  event_type: 'book';
  market: string;
  asset_id: string;
  timestamp?: string;
  hash?: string;
  bids: ReadonlyArray<ClobBookLevel>;
  asks: ReadonlyArray<ClobBookLevel>;
}

export interface ClobPriceChangeItem {
  asset_id: string;
  price: string;
  size: string;
  side: 'BUY' | 'SELL' | string;
  hash?: string;
  best_bid?: string;
  best_ask?: string;
}

export interface ClobPriceChangeEvent {
  event_type: 'price_change';
  market: string;
  timestamp?: string;
  price_changes: ReadonlyArray<ClobPriceChangeItem>;
}

export interface ClobBestBidAskEvent {
  event_type: 'best_bid_ask';
  market: string;
  asset_id: string;
  timestamp?: string;
  best_bid?: string;
  best_ask?: string;
  best_bid_size?: string;
  best_ask_size?: string;
}

export interface ClobLastTradePriceEvent {
  event_type: 'last_trade_price';
  asset_id: string;
  market: string;
  timestamp?: string;
  price?: string;
  size?: string;
  side?: string;
  fee_rate_bps?: string;
  transaction_hash?: string;
}

export interface ClobTickSizeChangeEvent {
  event_type: 'tick_size_change';
  asset_id: string;
  market: string;
  timestamp?: string;
  old_tick_size?: string;
  new_tick_size?: string;
}

export interface ClobNewMarketEvent {
  event_type: 'new_market';
  market: string;
  asset_id?: string;
  timestamp?: string;
  // The wire shape includes additional fields (slug, condition_id, ...),
  // but we keep the typed surface minimal — the full payload is preserved
  // verbatim in `raw_events` so replay never loses information.
  [key: string]: unknown;
}

export interface ClobMarketResolvedEvent {
  event_type: 'market_resolved';
  market: string;
  asset_id?: string;
  timestamp?: string;
  outcome?: string;
  [key: string]: unknown;
}

export interface ClobUnknownEvent {
  event_type: string;
  market?: string;
  asset_id?: string;
  timestamp?: string;
  [key: string]: unknown;
}

export type ClobAnyEvent =
  | ClobBookEvent
  | ClobPriceChangeEvent
  | ClobBestBidAskEvent
  | ClobLastTradePriceEvent
  | ClobTickSizeChangeEvent
  | ClobNewMarketEvent
  | ClobMarketResolvedEvent
  | ClobUnknownEvent;

// ---------------------------------------------------------------------------
// Normalized book snapshot — what the collector persists to `book_snapshots`.
// ---------------------------------------------------------------------------

export interface ClobNormalizedBookSide {
  bestPrice: number | null;
  bestSize: number | null;
}

export interface ClobNormalizedBookEvent {
  /** Token id from the underlying event. */
  tokenId: string;
  /** Polymarket market hash from the event (NOT our market_id). */
  marketHash: string;
  /** Source timestamp from payload. */
  sourceTs: Date | null;
  bid: ClobNormalizedBookSide;
  ask: ClobNormalizedBookSide;
  spread: number | null;
}

function asNumber(value: string | undefined): number | null {
  if (value === undefined || value === '') return null;
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

function asTimestamp(value: string | undefined): Date | null {
  if (!value) return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return null;
  return new Date(n);
}

/**
 * Pick best bid (highest price) and best ask (lowest price) from a `book`
 * payload. Polymarket returns levels in no guaranteed order.
 */
export function normalizeBookEvent(event: ClobBookEvent): ClobNormalizedBookEvent {
  let bidPrice: number | null = null;
  let bidSize: number | null = null;
  for (const level of event.bids) {
    const price = asNumber(level.price);
    const size = asNumber(level.size);
    if (price === null) continue;
    if (bidPrice === null || price > bidPrice) {
      bidPrice = price;
      bidSize = size;
    }
  }
  let askPrice: number | null = null;
  let askSize: number | null = null;
  for (const level of event.asks) {
    const price = asNumber(level.price);
    const size = asNumber(level.size);
    if (price === null) continue;
    if (askPrice === null || price < askPrice) {
      askPrice = price;
      askSize = size;
    }
  }
  const spread = bidPrice !== null && askPrice !== null ? askPrice - bidPrice : null;
  return {
    tokenId: event.asset_id,
    marketHash: event.market,
    sourceTs: asTimestamp(event.timestamp),
    bid: { bestPrice: bidPrice, bestSize: bidSize },
    ask: { bestPrice: askPrice, bestSize: askSize },
    spread,
  };
}

/**
 * `price_change` carries best_bid / best_ask per change item — emit one
 * normalized snapshot per change.
 */
export function normalizePriceChangeEvent(
  event: ClobPriceChangeEvent
): ClobNormalizedBookEvent[] {
  const sourceTs = asTimestamp(event.timestamp);
  return event.price_changes.map((change) => {
    const bid = asNumber(change.best_bid);
    const ask = asNumber(change.best_ask);
    return {
      tokenId: change.asset_id,
      marketHash: event.market,
      sourceTs,
      bid: { bestPrice: bid, bestSize: null },
      ask: { bestPrice: ask, bestSize: null },
      spread: bid !== null && ask !== null ? ask - bid : null,
    };
  });
}

/**
 * `best_bid_ask` is the dedicated event the spec calls for. Unlike
 * `price_change`, the payload does include best-level sizes.
 */
export function normalizeBestBidAskEvent(
  event: ClobBestBidAskEvent
): ClobNormalizedBookEvent {
  const bid = asNumber(event.best_bid);
  const ask = asNumber(event.best_ask);
  return {
    tokenId: event.asset_id,
    marketHash: event.market,
    sourceTs: asTimestamp(event.timestamp),
    bid: { bestPrice: bid, bestSize: asNumber(event.best_bid_size) },
    ask: { bestPrice: ask, bestSize: asNumber(event.best_ask_size) },
    spread: bid !== null && ask !== null ? ask - bid : null,
  };
}

// ---------------------------------------------------------------------------
// Handler interface — the collector implements this.
// ---------------------------------------------------------------------------

export interface ClobRawEvent {
  eventType: ClobEventType;
  /** Original payload, preserved verbatim for `raw_events.raw`. */
  payload: ClobAnyEvent;
  /** Token id when the event is asset-scoped (`book`, `price_change` items, etc.). */
  tokenId: string | null;
  /** Polymarket market hash — NOT our `market_id` PK. */
  marketHash: string | null;
  sourceTs: Date | null;
  receiveTs: Date;
}

export interface ClobMessageHandler {
  /**
   * Persist the raw event. MUST resolve before the collector emits any
   * normalized snapshots derived from this event so callers can link the
   * two via `raw_events.id`. Returning the inserted `raw_events.id` (as
   * bigint) lets the WS client thread it through to `onNormalizedBookSnapshot`.
   */
  onRawEvent(event: ClobRawEvent): Promise<bigint | null>;
  /**
   * Normalized snapshot derived from a CLOB event. `rawEventId` is the
   * `raw_events.id` returned by `onRawEvent` for the parent message; null
   * means the raw insert failed (and the caller should NOT persist a
   * normalized row that would be orphaned).
   */
  onNormalizedBookSnapshot(
    snapshot: ClobNormalizedBookEvent & { receiveTs: Date; rawEventId: bigint | null }
  ): Promise<void>;
  onConnect?(managerId: string, pendingAssetIds: string[]): void;
  onDisconnect?(managerId: string, code: number, reason: string): void;
  onError?(error: Error): void;
}

// ---------------------------------------------------------------------------
// WebSocket abstraction — keeps the production `ws` import behind a factory
// so tests inject an in-memory fake.
// ---------------------------------------------------------------------------

export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
  on(event: 'open', listener: () => void): this;
  on(event: 'close', listener: (code: number, reason: Buffer | string) => void): this;
  on(event: 'error', listener: (err: Error) => void): this;
  on(event: 'message', listener: (data: RawData | string) => void): this;
  on(event: 'pong', listener: () => void): this;
  ping?(data?: unknown, mask?: boolean, cb?: (err?: Error) => void): void;
  removeAllListeners(): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

const READY_STATE_OPEN = 1;

export interface MarketWsOptions {
  handler: ClobMessageHandler;
  url?: string;
  /** Ping cadence; the server expects keepalive traffic on idle channels. */
  pingIntervalMs?: number;
  /** Initial reconnect backoff. Doubles per attempt up to `reconnectMaxMs`. */
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  /** Set to false in tests to avoid scheduling timers. */
  autoReconnect?: boolean;
  webSocketFactory?: WebSocketFactory;
  now?: () => number;
  /** Stable id used in lifecycle callbacks; defaults to a random short id. */
  managerId?: string;
}

export interface MarketWebSocket {
  /** Add tokens to the active subscription set; idempotent. */
  subscribe(tokenIds: ReadonlyArray<string>): Promise<void>;
  /** Remove tokens from the active subscription set; idempotent. */
  unsubscribe(tokenIds: ReadonlyArray<string>): Promise<void>;
  /** Snapshot of currently-subscribed token ids. */
  getAssetIds(): string[];
  close(): Promise<void>;
}

interface InternalState {
  ws: WebSocketLike | null;
  /** Tokens we want subscribed once the socket is open. */
  desired: Set<string>;
  /** Tokens the server has been told about (subset of desired during connect). */
  subscribed: Set<string>;
  closed: boolean;
  pingTimer: ReturnType<typeof setInterval> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  reconnectAttempt: number;
}

function defaultWebSocketFactory(url: string): WebSocketLike {
  return new WebSocket(url) as unknown as WebSocketLike;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function classifyEvent(raw: unknown): {
  eventType: ClobEventType;
  tokenId: string | null;
  marketHash: string | null;
  sourceTs: Date | null;
  payload: ClobAnyEvent;
} | null {
  if (!isObject(raw)) return null;
  const eventTypeRaw = raw['event_type'];
  if (typeof eventTypeRaw !== 'string' || eventTypeRaw.length === 0) return null;
  const market = typeof raw['market'] === 'string' ? (raw['market'] as string) : null;
  const assetId = typeof raw['asset_id'] === 'string' ? (raw['asset_id'] as string) : null;
  const sourceTs = asTimestamp(typeof raw['timestamp'] === 'string' ? (raw['timestamp'] as string) : undefined);

  const known: ReadonlyArray<ClobEventType> = [
    'book',
    'price_change',
    'best_bid_ask',
    'last_trade_price',
    'tick_size_change',
    'new_market',
    'market_resolved',
  ];
  const eventType: ClobEventType = (known as ReadonlyArray<string>).includes(eventTypeRaw)
    ? (eventTypeRaw as ClobEventType)
    : 'unknown';

  // For price_change, asset_id lives inside each change item; surface the
  // first one for raw_events.token_id (full payload preserved verbatim).
  let resolvedToken = assetId;
  if (eventType === 'price_change' && resolvedToken === null) {
    const items = raw['price_changes'];
    if (Array.isArray(items) && items.length > 0 && isObject(items[0])) {
      const firstId = (items[0] as Record<string, unknown>)['asset_id'];
      if (typeof firstId === 'string') resolvedToken = firstId;
    }
  }

  return {
    eventType,
    tokenId: resolvedToken,
    marketHash: market,
    sourceTs,
    payload: raw as ClobAnyEvent,
  };
}

export function createMarketWebSocket(options: MarketWsOptions): MarketWebSocket {
  const handler = options.handler;
  const url = options.url ?? POLYMARKET_CLOB_WS_URL;
  const pingIntervalMs = options.pingIntervalMs ?? 30_000;
  const reconnectMinMs = options.reconnectMinMs ?? 1_000;
  const reconnectMaxMs = options.reconnectMaxMs ?? 30_000;
  const autoReconnect = options.autoReconnect ?? true;
  const factory = options.webSocketFactory ?? defaultWebSocketFactory;
  const now = options.now ?? (() => Date.now());
  const managerId = options.managerId ?? `clob-${Math.random().toString(36).slice(2, 8)}`;

  const state: InternalState = {
    ws: null,
    desired: new Set(),
    subscribed: new Set(),
    closed: false,
    pingTimer: null,
    reconnectTimer: null,
    reconnectAttempt: 0,
  };

  function clearTimers(): void {
    if (state.pingTimer !== null) {
      clearInterval(state.pingTimer);
      state.pingTimer = null;
    }
    if (state.reconnectTimer !== null) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  }

  function scheduleReconnect(): void {
    if (state.closed || !autoReconnect) return;
    const attempt = state.reconnectAttempt;
    state.reconnectAttempt += 1;
    const delay = Math.min(reconnectMaxMs, reconnectMinMs * Math.pow(2, attempt));
    if (state.reconnectTimer !== null) clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      try {
        connect();
      } catch (err) {
        handler.onError?.(err instanceof Error ? err : new Error(String(err)));
        scheduleReconnect();
      }
    }, delay);
  }

  function trySendInit(ws: WebSocketLike): void {
    // The handshake MUST include `custom_feature_enabled: true` so the
    // server emits best_bid_ask / new_market / market_resolved events.
    const initPayload = {
      type: 'market' as const,
      assets_ids: Array.from(state.desired),
      custom_feature_enabled: true as const,
    };
    ws.send(JSON.stringify(initPayload));
    for (const id of state.desired) state.subscribed.add(id);
  }

  function trySendOperation(operation: 'subscribe' | 'unsubscribe', tokenIds: string[]): void {
    if (tokenIds.length === 0) return;
    const ws = state.ws;
    if (!ws || ws.readyState !== READY_STATE_OPEN) return;
    // Carry `custom_feature_enabled: true` on every client→server message
    // (init, subscribe, unsubscribe). The upstream protocol typing
    // (`MarketSubscriptionMessage` / `SubscribeMessage` / `UnsubscribeMessage`
    // in `@nevuamarkets/poly-websockets/dist/types/PolymarketWebSocket.d.ts`)
    // allows the flag on all three. Sending it on delta ops too removes any
    // ambiguity for the server about which feature set this connection
    // wants — e.g. a delta `subscribe` that lacks the flag could otherwise
    // be interpreted as "default features only" and silently drop
    // `best_bid_ask` / `new_market` / `market_resolved` for the new tokens.
    // Unsubscribe carries the flag for symmetry; the server has no
    // sensible interpretation of a per-asset feature change on teardown.
    ws.send(JSON.stringify({ operation, assets_ids: tokenIds, custom_feature_enabled: true }));
    if (operation === 'subscribe') {
      for (const id of tokenIds) state.subscribed.add(id);
    } else {
      for (const id of tokenIds) state.subscribed.delete(id);
    }
  }

  async function dispatchEvent(rawEvent: unknown): Promise<void> {
    const classified = classifyEvent(rawEvent);
    if (!classified) {
      handler.onError?.(new Error(`malformed CLOB event: ${JSON.stringify(rawEvent)}`));
      return;
    }
    const receiveTs = new Date(now());
    let rawId: bigint | null = null;
    try {
      rawId = await handler.onRawEvent({
        eventType: classified.eventType,
        payload: classified.payload,
        tokenId: classified.tokenId,
        marketHash: classified.marketHash,
        sourceTs: classified.sourceTs,
        receiveTs,
      });
    } catch (err) {
      handler.onError?.(err instanceof Error ? err : new Error(String(err)));
      // Do not emit normalized snapshots — they would be orphaned without
      // the raw_events row.
      return;
    }

    // Only `book`, `price_change`, and `best_bid_ask` produce normalized
    // snapshots. `new_market` / `market_resolved` / `last_trade_price` /
    // `tick_size_change` / unknown are raw-only.
    if (classified.eventType === 'book') {
      const norm = normalizeBookEvent(classified.payload as ClobBookEvent);
      await handler.onNormalizedBookSnapshot({ ...norm, receiveTs, rawEventId: rawId });
    } else if (classified.eventType === 'price_change') {
      for (const norm of normalizePriceChangeEvent(classified.payload as ClobPriceChangeEvent)) {
        await handler.onNormalizedBookSnapshot({ ...norm, receiveTs, rawEventId: rawId });
      }
    } else if (classified.eventType === 'best_bid_ask') {
      const norm = normalizeBestBidAskEvent(classified.payload as ClobBestBidAskEvent);
      await handler.onNormalizedBookSnapshot({ ...norm, receiveTs, rawEventId: rawId });
    }
  }

  async function handleMessage(data: RawData | string): Promise<void> {
    let parsed: unknown;
    try {
      // `ws`'s RawData widens to `Buffer | ArrayBuffer | Buffer[]`. Naively
      // calling `.toString('utf8')` on a `Buffer[]` invokes
      // Array.prototype.toString — which comma-joins string forms instead
      // of concatenating bytes — and corrupts fragmented messages. Handle
      // each shape explicitly.
      let text: string;
      if (typeof data === 'string') {
        text = data;
      } else if (Array.isArray(data)) {
        text = Buffer.concat(data).toString('utf8');
      } else if (Buffer.isBuffer(data)) {
        text = data.toString('utf8');
      } else {
        text = Buffer.from(data).toString('utf8');
      }
      // Polymarket occasionally sends keepalive `PONG` frames as plain text.
      if (text === 'PONG' || text === 'pong') return;
      parsed = JSON.parse(text);
    } catch (err) {
      handler.onError?.(
        new Error(`failed to parse CLOB WS message: ${err instanceof Error ? err.message : String(err)}`)
      );
      return;
    }
    const events = Array.isArray(parsed) ? parsed : [parsed];
    for (const ev of events) {
      try {
        await dispatchEvent(ev);
      } catch (err) {
        handler.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  function connect(): void {
    if (state.closed) return;
    if (state.ws) {
      try {
        state.ws.removeAllListeners();
        state.ws.close();
      } catch {
        // ignore — we are replacing it
      }
    }
    const ws = factory(url);
    state.ws = ws;
    state.subscribed.clear();

    ws.on('open', () => {
      state.reconnectAttempt = 0;
      try {
        trySendInit(ws);
      } catch (err) {
        handler.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      handler.onConnect?.(managerId, Array.from(state.desired));
      if (state.pingTimer !== null) clearInterval(state.pingTimer);
      state.pingTimer = setInterval(() => {
        if (ws.readyState !== READY_STATE_OPEN) return;
        try {
          if (typeof ws.ping === 'function') ws.ping();
          else ws.send('PING');
        } catch {
          // ignore — close handler will fire and trigger reconnect
        }
      }, pingIntervalMs);
    });

    ws.on('message', (data) => {
      void handleMessage(data);
    });

    ws.on('error', (err) => {
      handler.onError?.(err instanceof Error ? err : new Error(String(err)));
    });

    ws.on('close', (code, reason) => {
      if (state.pingTimer !== null) {
        clearInterval(state.pingTimer);
        state.pingTimer = null;
      }
      const reasonText = typeof reason === 'string' ? reason : reason.toString('utf8');
      handler.onDisconnect?.(managerId, code, reasonText);
      state.ws = null;
      if (!state.closed) scheduleReconnect();
    });
  }

  function ensureConnected(): void {
    if (state.closed) return;
    if (state.ws !== null) return;
    connect();
  }

  return {
    async subscribe(tokenIds: ReadonlyArray<string>): Promise<void> {
      if (tokenIds.length === 0) return;
      const fresh: string[] = [];
      for (const id of tokenIds) {
        if (!state.desired.has(id)) {
          state.desired.add(id);
          fresh.push(id);
        }
      }
      ensureConnected();
      // If the socket is open, push the delta immediately. Otherwise the
      // open handler will (re)send the full desired set as part of the init
      // payload — no fresh subscribe op needed.
      if (state.ws && state.ws.readyState === READY_STATE_OPEN) {
        trySendOperation('subscribe', fresh);
      }
    },
    async unsubscribe(tokenIds: ReadonlyArray<string>): Promise<void> {
      if (tokenIds.length === 0) return;
      const removed: string[] = [];
      for (const id of tokenIds) {
        if (state.desired.delete(id)) removed.push(id);
      }
      if (state.ws && state.ws.readyState === READY_STATE_OPEN) {
        trySendOperation('unsubscribe', removed);
      }
    },
    getAssetIds(): string[] {
      return Array.from(state.desired);
    },
    async close(): Promise<void> {
      state.closed = true;
      clearTimers();
      const ws = state.ws;
      if (ws) {
        try {
          ws.removeAllListeners();
          ws.close(1000, 'client closed');
        } catch (err) {
          handler.onError?.(err instanceof Error ? err : new Error(String(err)));
        }
      }
      state.ws = null;
    },
  };
}
