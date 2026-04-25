// Polymarket Gamma REST client for BTC Up/Down 5-minute market discovery.
//
// One window = one slug = at most one event with one market (Up + Down
// tokens). Per the parsed payload the canonical extraction is:
//   - eventId        ← gamma event's `id`
//   - marketId       ← gamma market's `id`
//   - condition_id   ← gamma market's `conditionId` (sometimes null)
//   - up/down tokens ← gamma market's `clobTokenIds` aligned by `outcomes`
//   - question       ← gamma market's `question`
//   - priceToBeat    ← gamma market's `priceToBeat` / `strike` / question $
// And the start/end time is derived from the SLUG, not the body, because
// the slug timestamp is the authoritative 300 s boundary; deployments
// occasionally lag the body's `startDate` by seconds.
//
// The client returns a discriminated union (`DiscoveryOutcome`) so the
// collector can react to 404 / parse-failure / network failure WITHOUT a
// throw — the collector loop must NEVER crash on a single slug miss.

import type { Market } from '@pulse5/models';
import {
  parseBtcUpDownEventResponse,
  type ParseResult,
  type ParsedBtcUpDownMarket,
} from './discovery.js';
import { FIVE_MIN_S } from './windows.js';

export const DEFAULT_GAMMA_BASE = 'https://gamma-api.polymarket.com';
export const DEFAULT_RESOLUTION_SOURCE = 'chainlink-btc-usd';

export type DiscoveryOutcome =
  | { kind: 'ok'; market: Market }
  | { kind: 'not_found'; slug: string; status: number }
  | { kind: 'parse_failed'; slug: string; reason: string }
  | { kind: 'network_error'; slug: string; error: string };

export interface DiscoveryClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  resolutionSource?: string;
  /**
   * Max attempts per slug on transient network/5xx failures. Default 3.
   * 404 is *not* retried — the window genuinely doesn't exist yet.
   */
  maxAttempts?: number;
  /** Backoff base in ms for retries. Default 250 ms (250, 500, 1000…). */
  backoffBaseMs?: number;
  /** Sleep override for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Per-request timeout in ms. Default 5000 ms. */
  timeoutMs?: number;
}

export interface DiscoveryClient {
  fetchBySlug(slug: string): Promise<DiscoveryOutcome>;
}

function slugTimestamp(slug: string): number | null {
  const m = slug.match(/^btc-updown-5m-(\d+)$/);
  if (!m || !m[1]) return null;
  const ts = Number.parseInt(m[1], 10);
  return Number.isFinite(ts) ? ts : null;
}

function pickPrimaryMarket(markets: ParsedBtcUpDownMarket[]): ParsedBtcUpDownMarket | null {
  // Prefer a market that already exposes a price-to-beat; otherwise the
  // first that has both up/down tokens (the parser already guarantees
  // tokens are distinct).
  return markets.find((m) => m.priceToBeat !== null) ?? markets[0] ?? null;
}

export function buildMarketFromParse(
  slug: string,
  parsed: Extract<ParseResult, { ok: true }>['event'],
  resolutionSource: string
): Market | { error: string } {
  const ts = slugTimestamp(slug);
  if (ts === null) {
    return { error: `slug "${slug}" does not match btc-updown-5m-{ts}` };
  }
  const market = pickPrimaryMarket(parsed.markets);
  if (!market) {
    return { error: `event "${slug}" has no usable markets` };
  }
  if (!parsed.eventId) {
    // Phase 2 acceptance requires an event id so downstream linkages
    // (raw_events.market_id ↔ markets.market_id) stay consistent.
    return { error: `event "${slug}" has no id field` };
  }
  return {
    marketId: market.marketId,
    eventId: parsed.eventId,
    slug,
    question: market.question,
    conditionId: market.conditionId,
    upTokenId: market.tokens.up,
    downTokenId: market.tokens.down,
    startTime: new Date(ts * 1000),
    endTime: new Date((ts + FIVE_MIN_S) * 1000),
    priceToBeat: market.priceToBeat,
    resolutionSource,
    status: 'open',
    finalOutcome: null,
  };
}

async function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function createDiscoveryClient(
  options: DiscoveryClientOptions = {}
): DiscoveryClient {
  const baseUrl = options.baseUrl ?? DEFAULT_GAMMA_BASE;
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolutionSource = options.resolutionSource ?? DEFAULT_RESOLUTION_SOURCE;
  const maxAttempts = options.maxAttempts ?? 3;
  const backoffBaseMs = options.backoffBaseMs ?? 250;
  const sleep = options.sleep ?? defaultSleep;
  const timeoutMs = options.timeoutMs ?? 5000;

  async function fetchOnce(slug: string): Promise<DiscoveryOutcome> {
    const url = `${baseUrl}/events?slug=${slug}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await fetchImpl(url, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });
    } catch (err) {
      return {
        kind: 'network_error',
        slug,
        error: err instanceof Error ? err.message : String(err),
      };
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404) {
      return { kind: 'not_found', slug, status: 404 };
    }
    if (response.status >= 500) {
      return {
        kind: 'network_error',
        slug,
        error: `gamma-api ${response.status} (transient)`,
      };
    }
    if (response.status !== 200) {
      return {
        kind: 'parse_failed',
        slug,
        reason: `unexpected HTTP status ${response.status}`,
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      return {
        kind: 'parse_failed',
        slug,
        reason: `non-JSON body: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    // gamma-api returns 200 + [] when the slug is not yet created. Treat
    // as not_found for backoff purposes.
    if (Array.isArray(body) && body.length === 0) {
      return { kind: 'not_found', slug, status: 200 };
    }

    const parse = parseBtcUpDownEventResponse(body, slug);
    if (!parse.ok) {
      return { kind: 'parse_failed', slug, reason: parse.reason };
    }
    const built = buildMarketFromParse(slug, parse.event, resolutionSource);
    if ('error' in built) {
      return { kind: 'parse_failed', slug, reason: built.error };
    }
    return { kind: 'ok', market: built };
  }

  return {
    async fetchBySlug(slug: string): Promise<DiscoveryOutcome> {
      let last: DiscoveryOutcome | null = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        const outcome = await fetchOnce(slug);
        last = outcome;
        if (outcome.kind === 'ok' || outcome.kind === 'not_found') {
          return outcome;
        }
        if (outcome.kind === 'parse_failed') {
          return outcome; // shape errors are not transient
        }
        // network_error → backoff and retry.
        if (attempt < maxAttempts) {
          await sleep(backoffBaseMs * 2 ** (attempt - 1));
        }
      }
      // last is non-null here because the loop ran at least once.
      return last ?? { kind: 'network_error', slug, error: 'unknown' };
    },
  };
}
