import { describe, it, expect, vi } from 'vitest';
import {
  buildMarketFromParse,
  createDiscoveryClient,
  DEFAULT_RESOLUTION_SOURCE,
} from './discovery-client.js';
import { FIVE_MIN_S } from './windows.js';

const SLUG = 'btc-updown-5m-1714000000';

function canonicalEventBody() {
  return [
    {
      id: 'evt-001',
      slug: SLUG,
      markets: [
        {
          id: 'mkt-001',
          conditionId: 'cond-001',
          question: 'Will BTC be above $67,250 at 12:35 PM ET?',
          clobTokenIds: ['tok-up', 'tok-down'],
          outcomes: ['Up', 'Down'],
        },
      ],
    },
  ];
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('buildMarketFromParse', () => {
  it('derives start/end from the slug timestamp regardless of body', () => {
    const market = buildMarketFromParse(
      SLUG,
      {
        slug: SLUG,
        eventId: 'evt-001',
        markets: [
          {
            marketId: 'mkt-001',
            conditionId: 'cond-001',
            question: 'q',
            tokens: { up: 'u', down: 'd' },
            priceToBeat: 67250,
          },
        ],
      },
      DEFAULT_RESOLUTION_SOURCE
    );
    expect('error' in market).toBe(false);
    if ('error' in market) return;
    expect(market.startTime.toISOString()).toBe(new Date(1714000000_000).toISOString());
    expect(market.endTime.getTime() - market.startTime.getTime()).toBe(FIVE_MIN_S * 1000);
    expect(market.upTokenId).toBe('u');
    expect(market.downTokenId).toBe('d');
    expect(market.priceToBeat).toBe(67250);
    expect(market.status).toBe('open');
    expect(market.resolutionSource).toBe(DEFAULT_RESOLUTION_SOURCE);
  });

  it('rejects a malformed slug', () => {
    const result = buildMarketFromParse(
      'not-a-slug',
      { slug: 'not-a-slug', eventId: 'e', markets: [] },
      DEFAULT_RESOLUTION_SOURCE
    );
    expect('error' in result).toBe(true);
  });

  it('rejects an event with no markets', () => {
    const result = buildMarketFromParse(
      SLUG,
      { slug: SLUG, eventId: 'e', markets: [] },
      DEFAULT_RESOLUTION_SOURCE
    );
    expect('error' in result).toBe(true);
  });

  it('rejects when eventId is missing', () => {
    const result = buildMarketFromParse(
      SLUG,
      {
        slug: SLUG,
        eventId: null,
        markets: [
          {
            marketId: 'mkt',
            conditionId: null,
            question: 'q',
            tokens: { up: 'u', down: 'd' },
            priceToBeat: null,
          },
        ],
      },
      DEFAULT_RESOLUTION_SOURCE
    );
    expect('error' in result).toBe(true);
  });

  it('prefers the market that exposes a priceToBeat', () => {
    const market = buildMarketFromParse(
      SLUG,
      {
        slug: SLUG,
        eventId: 'e',
        markets: [
          {
            marketId: 'no-price',
            conditionId: null,
            question: '',
            tokens: { up: 'a', down: 'b' },
            priceToBeat: null,
          },
          {
            marketId: 'with-price',
            conditionId: null,
            question: '',
            tokens: { up: 'c', down: 'd' },
            priceToBeat: 50000,
          },
        ],
      },
      DEFAULT_RESOLUTION_SOURCE
    );
    expect('error' in market).toBe(false);
    if ('error' in market) return;
    expect(market.marketId).toBe('with-price');
  });
});

describe('createDiscoveryClient', () => {
  it('fetches by slug and returns ok with a Market', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse(canonicalEventBody()));
    const client = createDiscoveryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('ok');
    if (outcome.kind !== 'ok') return;
    expect(outcome.market.marketId).toBe('mkt-001');
    expect(outcome.market.upTokenId).toBe('tok-up');
    expect(outcome.market.downTokenId).toBe('tok-down');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns not_found on HTTP 404 without retrying', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('not found', { status: 404 }));
    const client = createDiscoveryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      maxAttempts: 3,
    });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('not_found');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns not_found on 200 + empty array', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse([]));
    const client = createDiscoveryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('not_found');
  });

  it('retries with backoff on 5xx and succeeds on attempt 2', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(makeJsonResponse(canonicalEventBody()));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = createDiscoveryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      backoffBaseMs: 100,
      maxAttempts: 3,
    });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(100);
  });

  it('gives up after maxAttempts on persistent 5xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = createDiscoveryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      backoffBaseMs: 50,
      maxAttempts: 2,
    });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('network_error');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('returns parse_failed on shape error without retrying', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeJsonResponse([{ slug: SLUG, markets: [] }]));
    const client = createDiscoveryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('parse_failed');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('returns network_error when fetch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const client = createDiscoveryClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
      maxAttempts: 1,
    });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('network_error');
  });

  it('returns parse_failed on unexpected non-200 status (e.g. 401)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('unauthorized', { status: 401 }));
    const client = createDiscoveryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('parse_failed');
    if (outcome.kind !== 'parse_failed') return;
    expect(outcome.reason).toContain('401');
  });

  it('returns parse_failed on non-JSON body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('<html>down</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })
    );
    const client = createDiscoveryClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const outcome = await client.fetchBySlug(SLUG);
    expect(outcome.kind).toBe('parse_failed');
  });
});
