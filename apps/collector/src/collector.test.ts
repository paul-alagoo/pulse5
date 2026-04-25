import { describe, it, expect, vi } from 'vitest';
import type { Market } from '@pulse5/models';
import { createCollector, type CollectorRepos } from './collector.js';
import type {
  DiscoveryLoopHandle,
  MarketWebSocket,
  ClobMessageHandler,
} from '@pulse5/polymarket-v2';
import type { RtdsClient, RtdsHandler } from '@pulse5/feeds';
import { RtdsConnectionStatus } from '@pulse5/feeds';

function reposMock(): CollectorRepos {
  return {
    markets: {
      upsert: vi.fn().mockResolvedValue(undefined),
      findById: vi.fn().mockResolvedValue(null),
      markResolved: vi.fn().mockResolvedValue(undefined),
    },
    rawEvents: {
      insert: vi.fn().mockResolvedValue(1n),
      countBySource: vi.fn().mockResolvedValue(0),
    },
    bookSnapshots: {
      insert: vi.fn().mockResolvedValue(undefined),
      countByMarket: vi.fn().mockResolvedValue(0),
    },
    btcTicks: {
      insert: vi.fn().mockResolvedValue(undefined),
      countBySource: vi.fn().mockResolvedValue(0),
    },
  };
}

function fakeDiscoveryLoop(): DiscoveryLoopHandle {
  return {
    start: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
    tickOnce: vi.fn().mockResolvedValue([]),
    isRunning: vi.fn().mockReturnValue(true),
  };
}

function fakeWs(): MarketWebSocket & { subscribed: string[] } {
  const subscribed: string[] = [];
  return {
    subscribed,
    async subscribe(tokenIds): Promise<void> {
      subscribed.push(...tokenIds);
    },
    async unsubscribe(tokenIds): Promise<void> {
      for (const t of tokenIds) {
        const i = subscribed.indexOf(t);
        if (i !== -1) subscribed.splice(i, 1);
      }
    },
    getAssetIds(): string[] {
      return [...subscribed];
    },
    async close(): Promise<void> {
      subscribed.length = 0;
    },
  };
}

function fakeRtds(): RtdsClient {
  return { start: vi.fn(), stop: vi.fn() };
}

function logger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const FIXED_NOW = 1714000000_000;

function fixtureMarket(overrides: Partial<Market> = {}): Market {
  return {
    marketId: 'mkt-1',
    eventId: 'evt-1',
    slug: 'btc-updown-5m-1714000200',
    question: 'q',
    conditionId: null,
    upTokenId: 'tok-up',
    downTokenId: 'tok-down',
    startTime: new Date(1714000200_000),
    endTime: new Date(1714000500_000),
    priceToBeat: null,
    resolutionSource: 'chainlink-btc-usd',
    status: 'open',
    finalOutcome: null,
    ...overrides,
  };
}

describe('collector wiring', () => {
  it('subscribes new tokens to the CLOB WS when discovery emits a market', async () => {
    const repos = reposMock();
    const ws = fakeWs();
    const rtds = fakeRtds();
    let capturedOnMarket: ((m: Market) => void) | undefined;
    const discovery = fakeDiscoveryLoop();
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createDiscoveryLoop: (opts) => {
          capturedOnMarket = opts.onMarket;
          return discovery;
        },
        now: () => FIXED_NOW,
      },
      {
        clobWebSocket: ws,
        rtdsClient: rtds,
        healthLogIntervalMs: 60_000,
      }
    );
    await collector.start();
    expect(rtds.start).toHaveBeenCalled();
    expect(discovery.start).toHaveBeenCalled();
    expect(capturedOnMarket).toBeDefined();

    capturedOnMarket!(fixtureMarket());
    // give the void subscribe a microtask
    await Promise.resolve();
    await Promise.resolve();
    expect(ws.subscribed).toEqual(['tok-up', 'tok-down']);
    const snap = collector.snapshot();
    expect(snap.marketsDiscovered).toBe(1);
    expect(snap.activeSubscriptions).toBe(2);

    // Re-emitting the same market should not double-subscribe.
    capturedOnMarket!(fixtureMarket());
    await Promise.resolve();
    expect(ws.subscribed).toEqual(['tok-up', 'tok-down']);

    await collector.stop();
    expect(discovery.stop).toHaveBeenCalled();
    expect(rtds.stop).toHaveBeenCalled();
  });

  it('records health metrics from CLOB events via the registry', async () => {
    const repos = reposMock();
    const ws = fakeWs();
    let capturedOnMarket: ((m: Market) => void) | undefined;
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createDiscoveryLoop: (opts) => {
          capturedOnMarket = opts.onMarket;
          return fakeDiscoveryLoop();
        },
        now: () => FIXED_NOW,
      },
      { clobWebSocket: ws, rtdsClient: fakeRtds(), skipNetwork: true }
    );
    await collector.start();
    capturedOnMarket!(fixtureMarket());
    expect(collector.registry().marketIdForToken('tok-up')).toBe('mkt-1');
    expect(collector.registry().marketIdForToken('tok-down')).toBe('mkt-1');
    await collector.stop();
  });

  it('rejects start() after stop()', async () => {
    const repos = reposMock();
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createDiscoveryLoop: () => fakeDiscoveryLoop(),
        now: () => FIXED_NOW,
      },
      { clobWebSocket: fakeWs(), rtdsClient: fakeRtds(), skipNetwork: true }
    );
    await collector.start();
    await collector.stop();
    await expect(collector.start()).rejects.toThrow(/cannot be restarted/);
  });

  it('routes CLOB raw + normalized events into the repos with correct market_id mapping', async () => {
    const repos = reposMock();
    let clobHandler: ClobMessageHandler | null = null;
    let capturedOnMarket: ((m: Market) => void) | undefined;
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createClobWebSocket: ({ handler }) => {
          clobHandler = handler;
          return fakeWs();
        },
        createDiscoveryLoop: (opts) => {
          capturedOnMarket = opts.onMarket;
          return fakeDiscoveryLoop();
        },
        now: () => FIXED_NOW,
      },
      { rtdsClient: fakeRtds() }
    );
    await collector.start();
    capturedOnMarket!(fixtureMarket());
    expect(clobHandler).not.toBeNull();

    // Raw event for a known token: should map to mkt-1.
    await clobHandler!.onRawEvent({
      eventType: 'book',
      payload: { sample: true },
      tokenId: 'tok-up',
      marketHash: '0xmarket',
      sourceTs: new Date(FIXED_NOW - 100),
      receiveTs: new Date(FIXED_NOW),
    });
    expect(repos.rawEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'clob', marketId: 'mkt-1', tokenId: 'tok-up' })
    );

    // Normalized snapshot: should write to book_snapshots and carry the
    // raw_event_id so replay can join the rows.
    await clobHandler!.onNormalizedBookSnapshot({
      tokenId: 'tok-up',
      marketHash: '0xmarket',
      sourceTs: new Date(FIXED_NOW - 50),
      bid: { bestPrice: 0.5, bestSize: 100 },
      ask: { bestPrice: 0.55, bestSize: 200 },
      spread: 0.05,
      receiveTs: new Date(FIXED_NOW),
      rawEventId: 99n,
    });
    expect(repos.bookSnapshots.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        marketId: 'mkt-1',
        tokenId: 'tok-up',
        bestBid: 0.5,
        rawEventId: 99n,
      })
    );

    // Snapshot for an UNKNOWN token: skip normalization (no market_id).
    await clobHandler!.onNormalizedBookSnapshot({
      tokenId: 'tok-other',
      marketHash: '0xmarket',
      sourceTs: null,
      bid: { bestPrice: null, bestSize: null },
      ask: { bestPrice: null, bestSize: null },
      spread: null,
      receiveTs: new Date(FIXED_NOW),
      rawEventId: 100n,
    });
    expect(repos.bookSnapshots.insert).toHaveBeenCalledTimes(1);

    // Snapshot whose raw insert failed (rawEventId=null): MUST NOT write a
    // normalized row — that would orphan it from raw_events.
    await clobHandler!.onNormalizedBookSnapshot({
      tokenId: 'tok-up',
      marketHash: '0xmarket',
      sourceTs: null,
      bid: { bestPrice: 0.6, bestSize: null },
      ask: { bestPrice: 0.65, bestSize: null },
      spread: 0.05,
      receiveTs: new Date(FIXED_NOW),
      rawEventId: null,
    });
    expect(repos.bookSnapshots.insert).toHaveBeenCalledTimes(1);

    // Lifecycle callbacks update health flags.
    clobHandler!.onConnect!('mgr-1', ['tok-up']);
    expect(collector.snapshot().clobConnected).toBe(true);
    clobHandler!.onDisconnect!('mgr-1', 1006, 'lost');
    expect(collector.snapshot().clobConnected).toBe(false);
    clobHandler!.onError!(new Error('boom'));

    await collector.stop();
  });

  it('routes RTDS raw events + ticks into the repos and tracks status changes', async () => {
    const repos = reposMock();
    let rtdsHandler: RtdsHandler | null = null;
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createRtdsClient: ({ handler }) => {
          rtdsHandler = handler;
          return fakeRtds();
        },
        createDiscoveryLoop: () => fakeDiscoveryLoop(),
        now: () => FIXED_NOW,
      },
      { clobWebSocket: fakeWs() }
    );
    await collector.start();
    expect(rtdsHandler).not.toBeNull();

    await rtdsHandler!.onRawEvent({
      topic: 'crypto_prices',
      type: 'update',
      source: 'rtds.binance',
      symbol: 'btcusdt',
      payload: { value: 67000 },
      sourceTs: new Date(FIXED_NOW - 100),
      receiveTs: new Date(FIXED_NOW),
    });
    expect(repos.rawEvents.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'rtds.binance' })
    );

    await rtdsHandler!.onTick({
      ts: new Date(FIXED_NOW),
      receiveTs: new Date(FIXED_NOW),
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67000,
      latencyMs: 50,
      rawEventId: 7n,
    });
    expect(repos.btcTicks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'rtds.binance', price: 67000, rawEventId: 7n })
    );

    // rawEventId === null means the raw insert failed — skip the tick to
    // keep btc_ticks.raw_event_id meaningful.
    await rtdsHandler!.onTick({
      ts: new Date(FIXED_NOW),
      receiveTs: new Date(FIXED_NOW),
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67000,
      latencyMs: null,
      rawEventId: null,
    });
    expect(repos.btcTicks.insert).toHaveBeenCalledTimes(1);

    rtdsHandler!.onConnect!();
    rtdsHandler!.onStatusChange!(RtdsConnectionStatus.CONNECTED);
    expect(collector.snapshot().rtdsStatus).toBe('connected');
    rtdsHandler!.onStatusChange!(RtdsConnectionStatus.CONNECTING);
    expect(collector.snapshot().rtdsStatus).toBe('connecting');
    rtdsHandler!.onStatusChange!(RtdsConnectionStatus.DISCONNECTED);
    expect(collector.snapshot().rtdsStatus).toBe('disconnected');
    rtdsHandler!.onDisconnect!();
    rtdsHandler!.onError!('rtds parse failed: x');

    await collector.stop();
  });

  it('logs and continues when a repo write throws', async () => {
    const repos = reposMock();
    (repos.rawEvents.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db down')
    );
    let clobHandler: ClobMessageHandler | null = null;
    const log = logger();
    const collector = createCollector(
      {
        repos,
        logger: log,
        createClobWebSocket: ({ handler }) => {
          clobHandler = handler;
          return fakeWs();
        },
        createDiscoveryLoop: () => fakeDiscoveryLoop(),
        now: () => FIXED_NOW,
      },
      { rtdsClient: fakeRtds() }
    );
    await collector.start();
    await clobHandler!.onRawEvent({
      eventType: 'book',
      payload: {},
      tokenId: 'tok-x',
      marketHash: '0x',
      sourceTs: null,
      receiveTs: new Date(FIXED_NOW),
    });
    expect(log.error).toHaveBeenCalled();
    await collector.stop();
  });

  it('logs an error when book_snapshots insert fails on a known token', async () => {
    const repos = reposMock();
    (repos.bookSnapshots.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    let clobHandler: ClobMessageHandler | null = null;
    let capturedOnMarket: ((m: Market) => void) | undefined;
    const log = logger();
    const collector = createCollector(
      {
        repos,
        logger: log,
        createClobWebSocket: ({ handler }) => {
          clobHandler = handler;
          return fakeWs();
        },
        createDiscoveryLoop: (opts) => {
          capturedOnMarket = opts.onMarket;
          return fakeDiscoveryLoop();
        },
        now: () => FIXED_NOW,
      },
      { rtdsClient: fakeRtds() }
    );
    await collector.start();
    capturedOnMarket!(fixtureMarket());
    await clobHandler!.onNormalizedBookSnapshot({
      tokenId: 'tok-up',
      marketHash: '0x',
      sourceTs: null,
      bid: { bestPrice: null, bestSize: null },
      ask: { bestPrice: null, bestSize: null },
      spread: null,
      receiveTs: new Date(FIXED_NOW),
      rawEventId: 1n,
    });
    expect(log.error).toHaveBeenCalled();
    await collector.stop();
  });

  it('logs an error when btc_ticks insert fails', async () => {
    const repos = reposMock();
    (repos.btcTicks.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('boom')
    );
    let rtdsHandler: RtdsHandler | null = null;
    const log = logger();
    const collector = createCollector(
      {
        repos,
        logger: log,
        createRtdsClient: ({ handler }) => {
          rtdsHandler = handler;
          return fakeRtds();
        },
        createDiscoveryLoop: () => fakeDiscoveryLoop(),
        now: () => FIXED_NOW,
      },
      { clobWebSocket: fakeWs() }
    );
    await collector.start();
    await rtdsHandler!.onTick({
      ts: new Date(FIXED_NOW),
      receiveTs: new Date(FIXED_NOW),
      source: 'rtds.binance',
      symbol: 'btcusdt',
      price: 67000,
      latencyMs: null,
      rawEventId: 1n,
    });
    expect(log.error).toHaveBeenCalled();

    (repos.rawEvents.insert as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('db down')
    );
    await rtdsHandler!.onRawEvent({
      topic: 'crypto_prices',
      type: 'update',
      source: 'rtds.binance',
      symbol: 'btcusdt',
      payload: {},
      sourceTs: null,
      receiveTs: new Date(FIXED_NOW),
    });
    expect(log.error).toHaveBeenCalledTimes(2);
    await collector.stop();
  });

  it('logs warns when subsystem stop methods throw', async () => {
    const repos = reposMock();
    const log = logger();
    const failingDiscovery: DiscoveryLoopHandle = {
      start: vi.fn(),
      stop: vi.fn().mockRejectedValue(new Error('disco stop')),
      tickOnce: vi.fn().mockResolvedValue([]),
      isRunning: vi.fn().mockReturnValue(true),
    };
    const failingRtds: RtdsClient = {
      start: vi.fn(),
      stop: vi.fn().mockImplementation(() => {
        throw new Error('rtds stop');
      }),
    };
    const failingWs: MarketWebSocket = {
      subscribe: vi.fn().mockResolvedValue(undefined),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      getAssetIds: () => [],
      close: vi.fn().mockRejectedValue(new Error('ws close')),
    };
    const collector = createCollector(
      {
        repos,
        logger: log,
        createDiscoveryLoop: () => failingDiscovery,
        now: () => FIXED_NOW,
      },
      { clobWebSocket: failingWs, rtdsClient: failingRtds }
    );
    await collector.start();
    await collector.stop();
    expect(log.warn).toHaveBeenCalledTimes(3);
  });

  it('skipNetwork: true skips CLOB and RTDS construction; stop is graceful', async () => {
    const repos = reposMock();
    const log = logger();
    const collector = createCollector(
      {
        repos,
        logger: log,
        createDiscoveryLoop: () => fakeDiscoveryLoop(),
        now: () => FIXED_NOW,
      },
      { skipNetwork: true }
    );
    await collector.start();
    expect(collector.snapshot().clobConnected).toBe(false);
    await collector.stop();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('emits a periodic health log via the health timer', async () => {
    vi.useFakeTimers();
    try {
      const repos = reposMock();
      const log = logger();
      const collector = createCollector(
        {
          repos,
          logger: log,
          createDiscoveryLoop: () => fakeDiscoveryLoop(),
          now: () => FIXED_NOW,
        },
        {
          clobWebSocket: fakeWs(),
          rtdsClient: fakeRtds(),
          healthLogIntervalMs: 50,
        }
      );
      await collector.start();
      await vi.advanceTimersByTimeAsync(60);
      // Expect at least one info call with component=collector.health.
      const healthCalls = log.info.mock.calls.filter(
        (c: unknown[]) => (c[0] as { component?: string }).component === 'collector.health'
      );
      expect(healthCalls.length).toBeGreaterThan(0);
      await collector.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('default discovery sink upserts via repos.markets', async () => {
    const repos = reposMock();
    let capturedSink: { upsert: (m: Market) => Promise<void> } | undefined;
    const collector = createCollector(
      {
        repos,
        logger: logger(),
        createDiscoveryLoop: (opts) => {
          capturedSink = opts.sink;
          return fakeDiscoveryLoop();
        },
        now: () => FIXED_NOW,
      },
      { clobWebSocket: fakeWs(), rtdsClient: fakeRtds() }
    );
    await collector.start();
    await capturedSink!.upsert(fixtureMarket());
    expect(repos.markets.upsert).toHaveBeenCalledTimes(1);
    await collector.stop();
  });

  it('subscribe error from CLOB WS is logged but does not throw', async () => {
    const repos = reposMock();
    const log = logger();
    const ws: MarketWebSocket = {
      subscribe: vi.fn().mockRejectedValue(new Error('subscribe boom')),
      unsubscribe: vi.fn().mockResolvedValue(undefined),
      getAssetIds: () => [],
      close: vi.fn().mockResolvedValue(undefined),
    };
    let capturedOnMarket: ((m: Market) => void) | undefined;
    const collector = createCollector(
      {
        repos,
        logger: log,
        createDiscoveryLoop: (opts) => {
          capturedOnMarket = opts.onMarket;
          return fakeDiscoveryLoop();
        },
        now: () => FIXED_NOW,
      },
      { clobWebSocket: ws, rtdsClient: fakeRtds() }
    );
    await collector.start();
    capturedOnMarket!(fixtureMarket());
    // Wait for the subscribe-rejection to flush.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(log.error).toHaveBeenCalledWith(
      expect.objectContaining({ component: 'collector.discovery' }),
      expect.any(String)
    );
    await collector.stop();
  });
});
