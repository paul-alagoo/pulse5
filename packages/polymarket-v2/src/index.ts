// Pulse5 Polymarket V2 boundary.

export const POLYMARKET_V2_VERSION = '0.1.1';

export {
  parseBtcUpDownEventResponse,
  type ParseResult,
  type ParseSuccess,
  type ParseFailure,
  type ParsedBtcUpDownEvent,
  type ParsedBtcUpDownMarket,
  type UpDownTokens,
  type ParseOptions,
} from './discovery.js';

export {
  FIVE_MIN_S,
  floorToWindow,
  slugForWindow,
  planWindows,
  planWindowSlugs,
  type WindowPlan,
} from './windows.js';

export {
  DEFAULT_GAMMA_BASE,
  DEFAULT_RESOLUTION_SOURCE,
  buildMarketFromParse,
  createDiscoveryClient,
  type DiscoveryClient,
  type DiscoveryClientOptions,
  type DiscoveryOutcome,
} from './discovery-client.js';

export {
  createDiscoveryLoop,
  type DiscoveryLoopHandle,
  type DiscoveryLoopOptions,
  type DiscoveryLoopLogger,
  type MarketSink,
} from './discovery-loop.js';

export {
  createMarketWebSocket,
  POLYMARKET_CLOB_WS_URL,
  normalizeBookEvent,
  normalizePriceChangeEvent,
  normalizeBestBidAskEvent,
  type MarketWebSocket,
  type MarketWsOptions,
  type ClobMessageHandler,
  type ClobRawEvent,
  type ClobEventType,
  type ClobNormalizedBookEvent,
  type ClobNormalizedBookSide,
  type ClobAnyEvent,
  type ClobBookEvent,
  type ClobPriceChangeEvent,
  type ClobBestBidAskEvent,
  type ClobLastTradePriceEvent,
  type ClobTickSizeChangeEvent,
  type ClobNewMarketEvent,
  type ClobMarketResolvedEvent,
  type WebSocketLike,
  type WebSocketFactory,
} from './market-ws.js';
