// Pulse5 RTDS WebSocket client.
//
// Wraps `@polymarket/real-time-data-client` with two responsibilities:
//   1. Subscribe to `crypto_prices` (btcusdt) and
//      `crypto_prices_chainlink` (btc/usd) on connect, and re-subscribe
//      every time the underlying socket reopens (the upstream library
//      does NOT replay subscriptions automatically across reconnects).
//   2. Hand every message to a caller-supplied handler with a normalized
//      tick *and* the raw payload, so the collector can persist both
//      `raw_events` and `btc_ticks` rows without re-parsing.
//
// PING / reconnect: `RealTimeDataClient` handles ping (5 s default) and
// `autoReconnect: true` internally. We trigger our re-subscribe in the
// `onConnect` callback, which fires on every successful (re)connect.

import {
  RealTimeDataClient,
  ConnectionStatus,
  type Message,
  type SubscriptionMessage,
} from '@polymarket/real-time-data-client';
import type { BtcTick, BtcTickSource } from '@pulse5/models';
import { parseRtdsCryptoPrice, type RtdsTopic } from './rtds-parser.js';

export const RTDS_DEFAULT_HOST = 'wss://ws-live-data.polymarket.com';
export const RTDS_DEFAULT_PING_INTERVAL_MS = 5000;
export const RTDS_BINANCE_FILTER = 'btcusdt';
export const RTDS_CHAINLINK_FILTER = 'btc/usd';

export interface RtdsRawEvent {
  topic: string;
  type: string;
  source: BtcTickSource;
  symbol: string;
  payload: unknown;
  sourceTs: Date | null;
  receiveTs: Date;
}

export interface RtdsHandler {
  /**
   * Persist the raw event. Returns the assigned `raw_events.id` (or null on
   * failure) so the caller can stamp the matching `btc_ticks.raw_event_id`.
   */
  onRawEvent(event: RtdsRawEvent): Promise<bigint | null>;
  /**
   * Normalized BTC tick. `rawEventId` is the `raw_events.id` returned by
   * `onRawEvent` for the parent message; null means the raw insert failed
   * and the caller should NOT persist a normalized row that would be
   * orphaned.
   */
  onTick(tick: BtcTick): Promise<void>;
  onConnect?(): void;
  onDisconnect?(): void;
  onStatusChange?(status: ConnectionStatus): void;
  onError?(reason: string): void;
}

export interface RtdsClientOptions {
  handler: RtdsHandler;
  host?: string;
  pingIntervalMs?: number;
  /** Tests substitute the upstream client. */
  clientFactory?: (args: {
    onConnect: (client: { subscribe: (msg: SubscriptionMessage) => void }) => void;
    onMessage: (
      client: { subscribe: (msg: SubscriptionMessage) => void },
      message: Message
    ) => void;
    onStatusChange: (status: ConnectionStatus) => void;
    host: string;
    pingInterval: number;
    autoReconnect: boolean;
  }) => { connect(): void; disconnect(): void };
  /** Topic → symbol filter map. Override for tests / non-default deployments. */
  subscriptions?: Array<{ topic: RtdsTopic; filter: string }>;
  now?: () => number;
}

export interface RtdsClient {
  start(): void;
  stop(): void;
}

const TOPIC_TO_SYMBOL: Record<RtdsTopic, string> = {
  crypto_prices: RTDS_BINANCE_FILTER,
  crypto_prices_chainlink: RTDS_CHAINLINK_FILTER,
};

// RTDS expects the `filters` field to be a JSON-encoded string (see the
// upstream README's `Messages hierarchy` table — `crypto_prices` filters are
// documented as `{"symbol":"btcusdt"}`). Sending a bare symbol like
// "btcusdt" connects but the server delivers no ticks, so we always wrap the
// caller-supplied symbol into `JSON.stringify({ symbol })`. Custom
// `subscriptions` overrides are wrapped the same way for consistency.
function buildSubscriptionMessage(
  subs: ReadonlyArray<{ topic: RtdsTopic; filter: string }>
): SubscriptionMessage {
  return {
    subscriptions: subs.map((s) => ({
      topic: s.topic,
      type: 'update',
      filters: JSON.stringify({ symbol: s.filter }),
    })),
  };
}

export function createRtdsClient(options: RtdsClientOptions): RtdsClient {
  const handler = options.handler;
  const host = options.host ?? RTDS_DEFAULT_HOST;
  const pingInterval = options.pingIntervalMs ?? RTDS_DEFAULT_PING_INTERVAL_MS;
  const subscriptions =
    options.subscriptions ??
    ([
      { topic: 'crypto_prices', filter: TOPIC_TO_SYMBOL.crypto_prices },
      { topic: 'crypto_prices_chainlink', filter: TOPIC_TO_SYMBOL.crypto_prices_chainlink },
    ] as const);
  const now = options.now ?? (() => Date.now());

  let client: { connect(): void; disconnect(): void } | null = null;

  function handleMessage(
    upstream: { subscribe: (m: SubscriptionMessage) => void },
    message: Message
  ): void {
    void upstream;
    const receiveTs = new Date(now());
    const topic = message.topic;
    if (topic !== 'crypto_prices' && topic !== 'crypto_prices_chainlink') {
      // Unknown topic — still emit raw event so the audit log is complete.
      // Discard the returned id; there is no normalized tick to link.
      void handler
        .onRawEvent({
          topic,
          type: message.type,
          source: 'rtds.unknown' as BtcTickSource,
          symbol: '',
          payload: message.payload,
          sourceTs: typeof message.timestamp === 'number' ? new Date(message.timestamp) : null,
          receiveTs,
        })
        .catch((err: unknown) => {
          handler.onError?.(`onRawEvent (unknown topic) failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }

    const symbol = TOPIC_TO_SYMBOL[topic];
    const parsed = parseRtdsCryptoPrice({
      topic,
      symbol,
      payload: message.payload,
      messageTs:
        typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
          ? message.timestamp
          : null,
      receiveTs,
    });

    if (!parsed.ok) {
      handler.onError?.(`rtds parse failed: ${parsed.reason}`);
      // Still record the raw event for replay/debug. Discard the returned
      // id — there is no normalized tick to link it to.
      void handler
        .onRawEvent({
          topic,
          type: message.type,
          source: topic === 'crypto_prices' ? 'rtds.binance' : 'rtds.chainlink',
          symbol,
          payload: message.payload,
          sourceTs: null,
          receiveTs,
        })
        .catch((err: unknown) => {
          handler.onError?.(`onRawEvent (parse-failed) failed: ${err instanceof Error ? err.message : String(err)}`);
        });
      return;
    }

    void (async () => {
      try {
        const rawEventId = await handler.onRawEvent({
          topic,
          type: message.type,
          source: parsed.sourceLabel,
          symbol,
          payload: message.payload,
          sourceTs: parsed.tick.ts,
          receiveTs,
        });
        await handler.onTick({ ...parsed.tick, rawEventId });
      } catch (err) {
        handler.onError?.(
          `rtds persist failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    })();
  }

  function handleConnect(upstream: { subscribe: (m: SubscriptionMessage) => void }): void {
    handler.onConnect?.();
    upstream.subscribe(buildSubscriptionMessage(subscriptions));
  }

  function handleStatus(status: ConnectionStatus): void {
    handler.onStatusChange?.(status);
    if (status === ConnectionStatus.DISCONNECTED) {
      handler.onDisconnect?.();
    }
  }

  return {
    start(): void {
      if (client !== null) return;
      const factory =
        options.clientFactory ??
        /* c8 ignore start -- production-only wiring; covered by manual smoke */
        ((args) =>
          new RealTimeDataClient({
            host: args.host,
            pingInterval: args.pingInterval,
            autoReconnect: args.autoReconnect,
            onConnect: (c) => args.onConnect(c),
            onMessage: (c, m) => args.onMessage(c, m),
            onStatusChange: (s) => args.onStatusChange(s),
          }));
      /* c8 ignore stop */
      client = factory({
        onConnect: handleConnect,
        onMessage: handleMessage,
        onStatusChange: handleStatus,
        host,
        pingInterval,
        autoReconnect: true,
      });
      client.connect();
    },
    stop(): void {
      if (client !== null) {
        client.disconnect();
        client = null;
      }
    },
  };
}
