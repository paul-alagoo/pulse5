// Pulse5 price feeds.

export const FEEDS_VERSION = '0.1.1';

export {
  parseRtdsCryptoPrice,
  type RtdsParseInput,
  type RtdsParseResult,
  type RtdsTopic,
} from './rtds-parser.js';

export {
  createRtdsClient,
  RTDS_DEFAULT_HOST,
  RTDS_DEFAULT_PING_INTERVAL_MS,
  RTDS_BINANCE_FILTER,
  RTDS_CHAINLINK_FILTER,
  type RtdsClient,
  type RtdsClientOptions,
  type RtdsHandler,
  type RtdsRawEvent,
} from './rtds-client.js';

// Re-export upstream connection status enum so collector callers
// don't need to add @polymarket/real-time-data-client as a direct dep.
export { ConnectionStatus as RtdsConnectionStatus } from '@polymarket/real-time-data-client';
