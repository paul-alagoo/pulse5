// Pulse5 shared TypeScript domain models.
//
// These types are *transport-shape*: they describe rows as the collector
// hands them to storage repositories. Persistence-only fields (BIGSERIAL
// id, ingest_ts default) are filled in by Postgres.

export const MODELS_VERSION = '0.1.1';

export interface Market {
  marketId: string;
  eventId: string;
  slug: string;
  question: string;
  conditionId: string | null;
  upTokenId: string;
  downTokenId: string;
  startTime: Date;
  endTime: Date;
  priceToBeat: number | null;
  resolutionSource: string;
  status: string;
  finalOutcome: string | null;
}

export type RawEventSource =
  | 'clob'
  | 'gamma'
  | 'rtds.binance'
  | 'rtds.chainlink'
  | (string & { readonly _brand?: 'raw-event-source' });

export interface RawEventRecord {
  source: RawEventSource;
  eventType: string;
  sourceTs: Date | null;
  receiveTs: Date;
  marketId: string | null;
  tokenId: string | null;
  payload: unknown;
}

export interface BookSnapshot {
  ts: Date;
  receiveTs: Date;
  marketId: string;
  tokenId: string;
  bestBid: number | null;
  bestAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  spread: number | null;
  rawEventId: bigint | null;
}

export type BtcTickSource = 'rtds.binance' | 'rtds.chainlink' | (string & {});

export interface BtcTick {
  ts: Date;
  receiveTs: Date;
  source: BtcTickSource;
  symbol: string;
  price: number;
  latencyMs: number | null;
  rawEventId: bigint | null;
}

export type MarketStatus = 'open' | 'resolved' | 'unknown';
