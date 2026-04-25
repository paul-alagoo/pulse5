// Pulse5 RTDS payload parser.
//
// The Polymarket RTDS publishes two payload families that Pulse5 cares
// about:
//   1. `crypto_prices`  filter `btcusdt`     (Binance spot)
//   2. `crypto_prices_chainlink` filter `btc/usd` (Chainlink BTC/USD)
//
// In both cases the wire payload is a JSON object whose price field has
// shifted between deployments (`value`, `price`, `p`, ...). We accept the
// canonical shapes and surface a structured failure for the rest. Crucially
// the parser MUST tolerate a missing source timestamp without crashing —
// "compute latency only when both timestamps are present" is the v0.1
// requirement.

import type { BtcTick, BtcTickSource } from '@pulse5/models';

export type RtdsTopic = 'crypto_prices' | 'crypto_prices_chainlink';

export interface RtdsParseInput {
  topic: string;
  /** Symbol filter, e.g. "btcusdt" or "btc/usd". */
  symbol: string;
  /** Decoded payload (object) from the WS message. */
  payload: unknown;
  /** Top-level message timestamp (ms epoch) if the wrapper provided one. */
  messageTs: number | null;
  /** Local receive timestamp. */
  receiveTs: Date;
}

export type RtdsParseResult =
  | { ok: true; tick: Omit<BtcTick, 'rawEventId'>; sourceLabel: BtcTickSource }
  | { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\s,$]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asEpochMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // RTDS sometimes emits seconds — auto-detect by magnitude. 1e12 covers
    // dates from 2001-09 onwards as ms; smaller values are treated as s.
    return value < 1e12 ? Math.round(value * 1000) : Math.round(value);
  }
  if (typeof value === 'string') {
    const n = Number.parseInt(value, 10);
    if (!Number.isFinite(n)) return null;
    return n < 1e12 ? n * 1000 : n;
  }
  return null;
}

function extractPrice(payload: Record<string, unknown>): number | null {
  // Try common field names in priority order.
  return (
    asNumber(payload['value']) ??
    asNumber(payload['price']) ??
    asNumber(payload['p']) ??
    asNumber(payload['last_price']) ??
    asNumber(payload['close'])
  );
}

function extractSourceTs(
  payload: Record<string, unknown>,
  messageTs: number | null
): number | null {
  return (
    asEpochMs(payload['timestamp']) ??
    asEpochMs(payload['ts']) ??
    asEpochMs(payload['time']) ??
    asEpochMs(payload['t']) ??
    messageTs
  );
}

const SOURCE_LABELS: Record<RtdsTopic, BtcTickSource> = {
  crypto_prices: 'rtds.binance',
  crypto_prices_chainlink: 'rtds.chainlink',
};

export function parseRtdsCryptoPrice(input: RtdsParseInput): RtdsParseResult {
  const topic = input.topic;
  if (topic !== 'crypto_prices' && topic !== 'crypto_prices_chainlink') {
    return { ok: false, reason: `unsupported topic "${topic}"` };
  }
  if (!isRecord(input.payload)) {
    return { ok: false, reason: 'payload is not an object' };
  }
  const price = extractPrice(input.payload);
  if (price === null) {
    return { ok: false, reason: 'payload has no parseable price field' };
  }
  const sourceMs = extractSourceTs(input.payload, input.messageTs);
  const sourceTs = sourceMs === null ? null : new Date(sourceMs);
  const latencyMs =
    sourceMs === null ? null : Math.max(0, input.receiveTs.getTime() - sourceMs);
  // ts in the DB schema (PRIMARY KEY component) MUST be present. When the
  // payload omits a timestamp we fall back to receiveTs so the row is still
  // insertable; that is acceptable because raw_events still preserves the
  // unmutated payload for replay.
  const tsForDb = sourceTs ?? input.receiveTs;

  const sourceLabel = SOURCE_LABELS[topic as RtdsTopic];

  return {
    ok: true,
    tick: {
      ts: tsForDb,
      receiveTs: input.receiveTs,
      source: sourceLabel,
      symbol: input.symbol.toLowerCase(),
      price,
      latencyMs,
    },
    sourceLabel,
  };
}
