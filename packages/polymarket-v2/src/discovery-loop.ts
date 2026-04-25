// Pulse5 discovery loop.
//
// Polls Polymarket Gamma for the current/upcoming/recent BTC 5m windows on
// a configurable cadence (default 5 s), upserts found markets into storage,
// and emits events the collector listens to so it can subscribe new
// token IDs to the CLOB WS as soon as they appear.
//
// Crash safety:
//   - A single slug failure (404 / network / parse) NEVER cascades. The
//     loop logs and continues to the next slug.
//   - If `tickOnce` itself rejects, the loop swallows the error in start()
//     so a single buggy iteration doesn't kill the collector.

import type { Market } from '@pulse5/models';
import { createDiscoveryClient, type DiscoveryClient, type DiscoveryClientOptions, type DiscoveryOutcome } from './discovery-client.js';
import { planWindowSlugs } from './windows.js';

export interface DiscoveryLoopLogger {
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export interface MarketSink {
  upsert(market: Market): Promise<void>;
}

export interface DiscoveryLoopOptions {
  client?: DiscoveryClient;
  clientOptions?: DiscoveryClientOptions;
  intervalMs?: number;
  lookbackWindows?: number;
  lookaheadWindows?: number;
  logger?: DiscoveryLoopLogger;
  sink: MarketSink;
  /** Notified on every successfully discovered Market. Used by the collector to wire CLOB subscriptions. */
  onMarket?: (market: Market) => void;
  now?: () => number;
}

export interface DiscoveryLoopHandle {
  start(): void;
  stop(): Promise<void>;
  /**
   * Run a single discovery sweep. Exposed for tests and for the collector's
   * "kick on startup" path. Returns the per-slug outcomes.
   */
  tickOnce(): Promise<DiscoveryOutcome[]>;
  isRunning(): boolean;
}

const SILENT_LOGGER: DiscoveryLoopLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

export function createDiscoveryLoop(options: DiscoveryLoopOptions): DiscoveryLoopHandle {
  const client = options.client ?? createDiscoveryClient(options.clientOptions ?? {});
  const intervalMs = options.intervalMs ?? 5000;
  const lookback = options.lookbackWindows ?? 2;
  const lookahead = options.lookaheadWindows ?? 1;
  const logger = options.logger ?? SILENT_LOGGER;
  const sink = options.sink;
  const onMarket = options.onMarket;
  const now = options.now ?? (() => Date.now());

  let timer: ReturnType<typeof setInterval> | null = null;
  let stopping = false;
  // In-flight guard: if a tick is still running when the next interval
  // fires (slow Gamma response, slow sink), we skip rather than overlap.
  // Without this guard a sustained latency spike turns into an unbounded
  // queue of concurrent ticks, each fanning out into multiple Gamma
  // requests and Postgres upserts.
  let tickInFlight = false;
  // Dedup: emit `onMarket` once per market_id per loop lifetime so the
  // collector doesn't redundantly re-subscribe a token on every poll.
  const seen = new Set<string>();

  async function tickOnce(): Promise<DiscoveryOutcome[]> {
    const slugs = planWindowSlugs(now(), {
      lookbackWindows: lookback,
      lookaheadWindows: lookahead,
    });
    const outcomes: DiscoveryOutcome[] = [];
    for (const slug of slugs) {
      const outcome = await client.fetchBySlug(slug);
      outcomes.push(outcome);
      if (outcome.kind === 'ok') {
        try {
          await sink.upsert(outcome.market);
          if (!seen.has(outcome.market.marketId)) {
            seen.add(outcome.market.marketId);
            logger.info(
              {
                component: 'discovery',
                slug,
                marketId: outcome.market.marketId,
                upTokenId: outcome.market.upTokenId,
                downTokenId: outcome.market.downTokenId,
                startTime: outcome.market.startTime.toISOString(),
                endTime: outcome.market.endTime.toISOString(),
              },
              'discovered market'
            );
            onMarket?.(outcome.market);
          }
        } catch (err) {
          logger.error(
            {
              component: 'discovery',
              slug,
              marketId: outcome.market.marketId,
              error: err instanceof Error ? err.message : String(err),
            },
            'sink.upsert failed'
          );
        }
      } else if (outcome.kind === 'parse_failed') {
        logger.warn({ component: 'discovery', slug, reason: outcome.reason }, 'parse failed');
      } else if (outcome.kind === 'network_error') {
        logger.warn({ component: 'discovery', slug, error: outcome.error }, 'network error');
      }
      // not_found: too noisy to log at info; skipped.
    }
    return outcomes;
  }

  async function safeTick(): Promise<void> {
    if (tickInFlight) {
      logger.warn(
        { component: 'discovery' },
        'discovery tick skipped: previous tick still running'
      );
      return;
    }
    tickInFlight = true;
    try {
      await tickOnce();
    } catch (err) {
      logger.error(
        { component: 'discovery', error: err instanceof Error ? err.message : String(err) },
        'discovery tick crashed'
      );
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start(): void {
      if (timer !== null || stopping) return;
      // Kick once immediately, then every intervalMs.
      void safeTick();
      timer = setInterval(() => {
        void safeTick();
      }, intervalMs);
    },
    async stop(): Promise<void> {
      stopping = true;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },
    tickOnce,
    isRunning(): boolean {
      return timer !== null;
    },
  };
}
