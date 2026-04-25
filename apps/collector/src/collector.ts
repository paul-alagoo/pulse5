// Pulse5 collector top-level wiring.
//
// Pure object orchestration — no module-level side effects, so tests can
// instantiate the collector with mocks. The CLI entrypoint in `index.ts`
// calls `runCollector()` with the production wiring.

import type { Market } from '@pulse5/models';
import type {
  MarketsRepository,
  RawEventsRepository,
  BookSnapshotsRepository,
  BtcTicksRepository,
} from '@pulse5/storage';
import {
  createDiscoveryLoop,
  createMarketWebSocket,
  type DiscoveryLoopHandle,
  type MarketWebSocket,
  type ClobMessageHandler,
  type ClobNormalizedBookEvent,
} from '@pulse5/polymarket-v2';
import {
  createRtdsClient,
  RtdsConnectionStatus,
  type RtdsClient,
  type RtdsHandler,
} from '@pulse5/feeds';
import { createHealthMetrics, type HealthMetrics } from './health.js';
import { createClobSubscriptionRegistry, type ClobSubscriptionRegistry } from './subscription-manager.js';

export interface CollectorLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface CollectorRepos {
  markets: MarketsRepository;
  rawEvents: RawEventsRepository;
  bookSnapshots: BookSnapshotsRepository;
  btcTicks: BtcTicksRepository;
}

export interface CollectorDependencies {
  repos: CollectorRepos;
  logger: CollectorLogger;
  /**
   * Factory for the CLOB WS. Tests inject a fake; production wiring
   * passes `createMarketWebSocket` from @pulse5/polymarket-v2.
   */
  createClobWebSocket?: typeof createMarketWebSocket;
  /** Factory for the RTDS client. */
  createRtdsClient?: typeof createRtdsClient;
  /** Factory for the discovery loop. */
  createDiscoveryLoop?: typeof createDiscoveryLoop;
  now?: () => number;
}

export interface CollectorOptions {
  discoveryIntervalMs?: number;
  healthLogIntervalMs?: number;
  rtdsHost?: string;
  /** Skip RTDS / CLOB live connections (used by tests + offline runs). */
  skipNetwork?: boolean;
  /** Override CLOB WS — used by tests. */
  clobWebSocket?: MarketWebSocket;
  /** Override RTDS client — used by tests. */
  rtdsClient?: RtdsClient;
  /** Override discovery loop — used by tests. */
  discoveryLoop?: DiscoveryLoopHandle;
}

export interface CollectorHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Snapshot of health metrics — for tests + the periodic health log. */
  snapshot(): ReturnType<HealthMetrics['snapshot']>;
  /** Observable test seam: which tokens are currently subscribed. */
  registry(): ClobSubscriptionRegistry;
}

interface CollectorState {
  metrics: HealthMetrics;
  registry: ClobSubscriptionRegistry;
  healthTimer: ReturnType<typeof setInterval> | null;
  ws: MarketWebSocket | null;
  rtds: RtdsClient | null;
  discovery: DiscoveryLoopHandle | null;
  stopped: boolean;
}

export function createCollector(
  deps: CollectorDependencies,
  options: CollectorOptions = {}
): CollectorHandle {
  const logger = deps.logger;
  const now = deps.now ?? (() => Date.now());
  const repos = deps.repos;
  const healthLogIntervalMs = options.healthLogIntervalMs ?? 30_000;
  const discoveryIntervalMs = options.discoveryIntervalMs ?? 5000;

  const state: CollectorState = {
    metrics: createHealthMetrics(now()),
    registry: createClobSubscriptionRegistry(),
    healthTimer: null,
    ws: null,
    rtds: null,
    discovery: null,
    stopped: false,
  };

  const clobHandler: ClobMessageHandler = {
    // Returns the raw_events.id (or null on failure) so the WS client can
    // thread it into the matching normalized snapshots — keeps replay /
    // audit linkage intact at the storage layer (raw_events.id ↔
    // book_snapshots.raw_event_id).
    async onRawEvent(event): Promise<bigint | null> {
      const marketId = event.tokenId ? state.registry.marketIdForToken(event.tokenId) : null;
      try {
        const id = await repos.rawEvents.insert({
          source: 'clob',
          eventType: event.eventType,
          sourceTs: event.sourceTs,
          receiveTs: event.receiveTs,
          marketId,
          tokenId: event.tokenId,
          payload: event.payload,
        });
        state.metrics.recordRawEvent('clob', event.receiveTs.getTime());
        return id;
      } catch (err) {
        logger.error(
          {
            component: 'collector.clob',
            eventType: event.eventType,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to persist raw clob event'
        );
        return null;
      }
    },
    async onNormalizedBookSnapshot(
      snapshot: ClobNormalizedBookEvent & { receiveTs: Date; rawEventId: bigint | null }
    ): Promise<void> {
      const marketId = state.registry.marketIdForToken(snapshot.tokenId);
      if (!marketId) {
        // No mapping yet — skip. Raw event still lands.
        return;
      }
      // Drop normalized rows that lost their raw row — keeps the
      // book_snapshots.raw_event_id FK-style invariant intact and avoids
      // dangling normalized data.
      if (snapshot.rawEventId === null) {
        return;
      }
      try {
        await repos.bookSnapshots.insert({
          ts: snapshot.sourceTs ?? snapshot.receiveTs,
          receiveTs: snapshot.receiveTs,
          marketId,
          tokenId: snapshot.tokenId,
          bestBid: snapshot.bid.bestPrice,
          bestAsk: snapshot.ask.bestPrice,
          bidSize: snapshot.bid.bestSize,
          askSize: snapshot.ask.bestSize,
          spread: snapshot.spread,
          rawEventId: snapshot.rawEventId,
        });
        state.metrics.recordNormalized('clob');
      } catch (err) {
        logger.error(
          {
            component: 'collector.clob',
            tokenId: snapshot.tokenId,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to persist book snapshot'
        );
      }
    },
    onConnect(managerId, pendingAssetIds): void {
      state.metrics.setClobConnected(true);
      logger.info(
        { component: 'collector.clob', managerId, pending: pendingAssetIds.length },
        'CLOB WebSocket connected'
      );
    },
    onDisconnect(managerId, code, reason): void {
      state.metrics.setClobConnected(false);
      logger.warn(
        { component: 'collector.clob', managerId, code, reason },
        'CLOB WebSocket disconnected'
      );
    },
    onError(error): void {
      logger.error(
        { component: 'collector.clob', error: error.message },
        'CLOB WebSocket error'
      );
    },
  };

  const rtdsHandler: RtdsHandler = {
    async onRawEvent(event): Promise<bigint | null> {
      try {
        const id = await repos.rawEvents.insert({
          source: event.source,
          eventType: event.type,
          sourceTs: event.sourceTs,
          receiveTs: event.receiveTs,
          marketId: null,
          tokenId: null,
          payload: event.payload,
        });
        state.metrics.recordRawEvent(event.source, event.receiveTs.getTime());
        return id;
      } catch (err) {
        logger.error(
          {
            component: 'collector.rtds',
            source: event.source,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to persist raw rtds event'
        );
        return null;
      }
    },
    async onTick(tick): Promise<void> {
      // Linkage rule mirrors CLOB: skip the normalized row when the raw
      // insert lost its id. This keeps btc_ticks.raw_event_id meaningful
      // for replay and avoids dangling normalized rows.
      if (tick.rawEventId === null) {
        return;
      }
      try {
        await repos.btcTicks.insert(tick);
        state.metrics.recordNormalized(tick.source);
      } catch (err) {
        logger.error(
          {
            component: 'collector.rtds',
            source: tick.source,
            error: err instanceof Error ? err.message : String(err),
          },
          'failed to persist btc tick'
        );
      }
    },
    onConnect(): void {
      logger.info({ component: 'collector.rtds' }, 'RTDS connected');
    },
    onDisconnect(): void {
      logger.warn({ component: 'collector.rtds' }, 'RTDS disconnected');
    },
    onStatusChange(status): void {
      const mapped =
        status === RtdsConnectionStatus.CONNECTED
          ? 'connected'
          : status === RtdsConnectionStatus.CONNECTING
            ? 'connecting'
            : 'disconnected';
      state.metrics.setRtdsStatus(mapped);
    },
    onError(reason): void {
      logger.error({ component: 'collector.rtds', reason }, 'RTDS error');
    },
  };

  function logHealth(): void {
    const snap = state.metrics.snapshot(now());
    logger.info({ component: 'collector.health', ...snap }, 'health');
  }

  return {
    async start(): Promise<void> {
      if (state.stopped) throw new Error('collector cannot be restarted after stop()');

      // CLOB WS.
      if (options.clobWebSocket) {
        state.ws = options.clobWebSocket;
      } else if (!options.skipNetwork) {
        const factory = deps.createClobWebSocket ?? createMarketWebSocket;
        state.ws = factory({ handler: clobHandler });
      }

      // RTDS.
      if (options.rtdsClient) {
        state.rtds = options.rtdsClient;
      } else if (!options.skipNetwork) {
        const factory = deps.createRtdsClient ?? createRtdsClient;
        /* c8 ignore start -- production-only wiring; covered by manual smoke */
        const baseOptions = { handler: rtdsHandler };
        state.rtds = factory(
          options.rtdsHost
            ? { ...baseOptions, host: options.rtdsHost }
            : baseOptions
        );
        /* c8 ignore stop */
      }
      state.rtds?.start();

      // Discovery.
      const discovery =
        options.discoveryLoop ??
        (deps.createDiscoveryLoop ?? createDiscoveryLoop)({
          intervalMs: discoveryIntervalMs,
          sink: {
            async upsert(market: Market): Promise<void> {
              await repos.markets.upsert(market);
            },
          },
          onMarket: (market: Market) => {
            const newTokens = state.registry.add(
              market.marketId,
              market.upTokenId,
              market.downTokenId
            );
            state.metrics.setMarketsDiscovered(state.registry.size());
            state.metrics.setActiveSubscriptions(state.registry.list().length);
            if (state.ws && newTokens.length > 0) {
              void state.ws.subscribe(newTokens).catch((err: unknown) => {
                logger.error(
                  {
                    component: 'collector.discovery',
                    marketId: market.marketId,
                    error: err instanceof Error ? err.message : String(err),
                  },
                  'CLOB subscribe failed'
                );
              });
            }
          },
          logger,
        });
      state.discovery = discovery;
      discovery.start();

      // Periodic health log.
      state.healthTimer = setInterval(logHealth, healthLogIntervalMs);
      logger.info(
        { component: 'collector', healthLogIntervalMs, discoveryIntervalMs },
        'collector started'
      );
    },
    async stop(): Promise<void> {
      state.stopped = true;
      if (state.healthTimer !== null) {
        clearInterval(state.healthTimer);
        state.healthTimer = null;
      }
      try {
        await state.discovery?.stop();
      } catch (err) {
        logger.warn(
          { component: 'collector', error: err instanceof Error ? err.message : String(err) },
          'discovery stop failed'
        );
      }
      try {
        state.rtds?.stop();
      } catch (err) {
        logger.warn(
          { component: 'collector', error: err instanceof Error ? err.message : String(err) },
          'rtds stop failed'
        );
      }
      try {
        await state.ws?.close();
      } catch (err) {
        logger.warn(
          { component: 'collector', error: err instanceof Error ? err.message : String(err) },
          'clob close failed'
        );
      }
      logger.info({ component: 'collector' }, 'collector stopped');
    },
    snapshot() {
      return state.metrics.snapshot(now());
    },
    registry(): ClobSubscriptionRegistry {
      return state.registry;
    },
  };
}
