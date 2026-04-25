import { describe, it, expect, vi } from 'vitest';
import type { Market } from '@pulse5/models';
import { createDiscoveryLoop } from './discovery-loop.js';
import type { DiscoveryClient, DiscoveryOutcome } from './discovery-client.js';

const NOW_MS = 1714000200_000; // exact 300 s grid (1714000200 % 300 === 0)

function fixtureMarket(overrides: Partial<Market> = {}): Market {
  return {
    marketId: 'mkt-1',
    eventId: 'evt-1',
    slug: 'btc-updown-5m-1714000200',
    question: 'q',
    conditionId: null,
    upTokenId: 'tok-up',
    downTokenId: 'tok-down',
    startTime: new Date(1714000000_000),
    endTime: new Date(1714000300_000),
    priceToBeat: null,
    resolutionSource: 'chainlink-btc-usd',
    status: 'open',
    finalOutcome: null,
    ...overrides,
  };
}

function clientReturning(map: Map<string, DiscoveryOutcome>): DiscoveryClient {
  return {
    async fetchBySlug(slug: string): Promise<DiscoveryOutcome> {
      return map.get(slug) ?? { kind: 'not_found', slug, status: 404 };
    },
  };
}

describe('discovery loop tickOnce', () => {
  it('upserts every successfully fetched market', async () => {
    const market = fixtureMarket();
    const client = clientReturning(
      new Map<string, DiscoveryOutcome>([
        ['btc-updown-5m-1713999900', { kind: 'ok', market: fixtureMarket({ marketId: 'mkt-a', slug: 'btc-updown-5m-1713999900' }) }],
        ['btc-updown-5m-1714000200', { kind: 'ok', market }],
      ])
    );
    const upsert = vi.fn().mockResolvedValue(undefined);
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert },
      now: () => NOW_MS,
      lookbackWindows: 1,
      lookaheadWindows: 1,
    });
    const outcomes = await loop.tickOnce();
    expect(outcomes).toHaveLength(3); // 1 past + current + 1 upcoming
    expect(upsert).toHaveBeenCalledTimes(2);
  });

  it('emits onMarket exactly once per market_id across multiple ticks', async () => {
    const market = fixtureMarket();
    const client = clientReturning(
      new Map<string, DiscoveryOutcome>([['btc-updown-5m-1714000200', { kind: 'ok', market }]])
    );
    const upsert = vi.fn().mockResolvedValue(undefined);
    const onMarket = vi.fn();
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert },
      onMarket,
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    await loop.tickOnce();
    await loop.tickOnce();
    expect(upsert).toHaveBeenCalledTimes(2);
    expect(onMarket).toHaveBeenCalledTimes(1);
  });

  it('continues past a single slug failure without throwing', async () => {
    const client: DiscoveryClient = {
      async fetchBySlug(slug: string): Promise<DiscoveryOutcome> {
        if (slug.endsWith('1714000200')) return { kind: 'ok', market: fixtureMarket() };
        if (slug.endsWith('1713999900'))
          return { kind: 'parse_failed', slug, reason: 'shape mismatch' };
        return { kind: 'network_error', slug, error: 'ECONNRESET' };
      },
    };
    const upsert = vi.fn().mockResolvedValue(undefined);
    const warn = vi.fn();
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert },
      logger: { info: vi.fn(), warn, error: vi.fn() },
      now: () => NOW_MS,
      lookbackWindows: 1,
      lookaheadWindows: 1,
    });
    const outcomes = await loop.tickOnce();
    expect(outcomes.map((o) => o.kind)).toEqual([
      'parse_failed',
      'ok',
      'network_error',
    ]);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('logs and survives an upsert failure', async () => {
    const client = clientReturning(
      new Map<string, DiscoveryOutcome>([
        ['btc-updown-5m-1714000200', { kind: 'ok', market: fixtureMarket() }],
      ])
    );
    const upsert = vi.fn().mockRejectedValue(new Error('boom'));
    const error = vi.fn();
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert },
      logger: { info: vi.fn(), warn: vi.fn(), error },
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    await expect(loop.tickOnce()).resolves.toBeDefined();
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe('discovery loop start/stop', () => {
  it('schedules ticks via setInterval and stops cleanly', async () => {
    vi.useFakeTimers();
    try {
      const client = clientReturning(new Map());
      const upsert = vi.fn().mockResolvedValue(undefined);
      const fetchSpy = vi.spyOn(client, 'fetchBySlug');
      const loop = createDiscoveryLoop({
        client,
        sink: { upsert },
        intervalMs: 100,
        now: () => NOW_MS,
        lookbackWindows: 0,
        lookaheadWindows: 0,
      });
      loop.start();
      expect(loop.isRunning()).toBe(true);
      // Trigger the immediate kick + at least two interval fires so the
      // anonymous interval callback is exercised.
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(120);
      await vi.advanceTimersByTimeAsync(120);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      await loop.stop();
      expect(loop.isRunning()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('start() is idempotent', () => {
    const client = clientReturning(new Map());
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert: vi.fn().mockResolvedValue(undefined) },
      intervalMs: 1000,
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    loop.start();
    loop.start();
    expect(loop.isRunning()).toBe(true);
    void loop.stop();
  });

  it('uses the silent default logger when no logger is supplied (info path)', async () => {
    const market = fixtureMarket();
    const client = clientReturning(
      new Map<string, DiscoveryOutcome>([['btc-updown-5m-1714000200', { kind: 'ok', market }]])
    );
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert: vi.fn().mockResolvedValue(undefined) },
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    // Exercises SILENT_LOGGER.info on success.
    await expect(loop.tickOnce()).resolves.toBeDefined();
  });

  it('uses the silent default logger on parse_failed and network_error too', async () => {
    const calls = [
      { kind: 'parse_failed', slug: 'btc-updown-5m-1714000200', reason: 'shape mismatch' },
      { kind: 'network_error', slug: 'btc-updown-5m-1714000200', error: 'down' },
    ] as const;
    for (const outcome of calls) {
      const client: DiscoveryClient = {
        async fetchBySlug(): Promise<DiscoveryOutcome> {
          return outcome;
        },
      };
      const loop = createDiscoveryLoop({
        client,
        sink: { upsert: vi.fn().mockResolvedValue(undefined) },
        now: () => NOW_MS,
        lookbackWindows: 0,
        lookaheadWindows: 0,
      });
      await expect(loop.tickOnce()).resolves.toBeDefined();
    }
  });

  it('uses silent default logger when sink.upsert throws', async () => {
    const market = fixtureMarket();
    const client = clientReturning(
      new Map<string, DiscoveryOutcome>([['btc-updown-5m-1714000200', { kind: 'ok', market }]])
    );
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert: vi.fn().mockRejectedValue(new Error('db down')) },
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    await expect(loop.tickOnce()).resolves.toBeDefined();
  });

  it('logs network_error outcomes via warn', async () => {
    const client: DiscoveryClient = {
      async fetchBySlug(slug): Promise<DiscoveryOutcome> {
        return { kind: 'network_error', slug, error: 'down' };
      },
    };
    const warn = vi.fn();
    const loop = createDiscoveryLoop({
      client,
      sink: { upsert: vi.fn().mockResolvedValue(undefined) },
      logger: { info: vi.fn(), warn, error: vi.fn() },
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    await loop.tickOnce();
    expect(warn).toHaveBeenCalled();
  });

  it('falls back to a default real fetch client when no client is supplied', () => {
    const loop = createDiscoveryLoop({
      sink: { upsert: vi.fn().mockResolvedValue(undefined) },
      now: () => NOW_MS,
      lookbackWindows: 0,
      lookaheadWindows: 0,
    });
    // Don't actually call tickOnce — that would hit the network. Just
    // exercise the construction branch where `client` defaults.
    expect(loop.isRunning()).toBe(false);
  });

  it('skips overlapping ticks via the in-flight guard (slow tick does not stack)', async () => {
    vi.useFakeTimers();
    try {
      let resolveFetch: (() => void) | null = null;
      const slowClient: DiscoveryClient = {
        async fetchBySlug(): Promise<DiscoveryOutcome> {
          await new Promise<void>((resolve) => {
            resolveFetch = resolve;
          });
          return { kind: 'not_found', slug: 'btc-updown-5m-1714000200', status: 404 };
        },
      };
      const fetchSpy = vi.spyOn(slowClient, 'fetchBySlug');
      const warn = vi.fn();
      const loop = createDiscoveryLoop({
        client: slowClient,
        sink: { upsert: vi.fn().mockResolvedValue(undefined) },
        logger: { info: vi.fn(), warn, error: vi.fn() },
        intervalMs: 50,
        now: () => NOW_MS,
        lookbackWindows: 0,
        lookaheadWindows: 0,
      });
      loop.start();
      // Immediate kick begins the slow tick. While it hangs, advance the
      // timers past several interval boundaries — none should issue another
      // fetchBySlug.
      await vi.advanceTimersByTimeAsync(1);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      // Each skipped fire emitted a warn line.
      expect(warn).toHaveBeenCalledWith(
        expect.objectContaining({ component: 'discovery' }),
        expect.stringContaining('still running')
      );
      // Release the in-flight tick so the next interval can proceed.
      resolveFetch!();
      await vi.advanceTimersByTimeAsync(60);
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('safeTick swallows tickOnce throws so the interval keeps running', async () => {
    vi.useFakeTimers();
    try {
      const failingClient: DiscoveryClient = {
        async fetchBySlug(): Promise<DiscoveryOutcome> {
          throw new Error('client crashed');
        },
      };
      const error = vi.fn();
      const loop = createDiscoveryLoop({
        client: failingClient,
        sink: { upsert: vi.fn().mockResolvedValue(undefined) },
        logger: { info: vi.fn(), warn: vi.fn(), error },
        intervalMs: 50,
        now: () => NOW_MS,
        lookbackWindows: 0,
        lookaheadWindows: 0,
      });
      loop.start();
      // Allow the immediate kick + the first interval to run.
      await vi.advanceTimersByTimeAsync(60);
      expect(error).toHaveBeenCalled();
      await loop.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
