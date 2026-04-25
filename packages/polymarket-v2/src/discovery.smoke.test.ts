// Smoke test: live Polymarket gamma-api discovery probe.
//
// DEFAULT (`pnpm test:smoke`): runs the real network call and fails unless
// at least one recent 5-minute window slug returns HTTP 200 with a body
// that *parses* into a BTC Up/Down event matching the probed slug, with
// at least one market that has up/down token IDs. This is the authoritative
// release gate — neither a 404 nor a non-empty-but-shape-wrong body is
// accepted.
//
// OFFLINE (`pnpm test:smoke:offline`): sets PULSE5_SKIP_SMOKE_NETWORK=1 via
// the vitest config, skipping the live check. Use only when network access
// is intentionally unavailable (e.g. air-gapped build environments).
// This variant is NOT a release gate.

import { describe, it, expect } from 'vitest';
import { parseBtcUpDownEventResponse, type ParseResult } from './discovery.js';

const SKIP_NETWORK = process.env.PULSE5_SKIP_SMOKE_NETWORK === '1';

const GAMMA_API_BASE =
  process.env.POLYMARKET_GAMMA_API_URL ?? 'https://gamma-api.polymarket.com';

// Polymarket creates btc-updown-5m-{ts} markets on a 300 s cadence. The
// "current" 5-minute window may not be live yet, so we walk back through
// the most recent windows and assert that AT LEAST ONE returns a non-empty
// array WITH a parseable BTC Up/Down event matching the slug.
const WINDOWS_TO_PROBE = 6; // ~30 minutes of recent windows.
const FIVE_MIN_S = 300;

interface ProbeResult {
  slug: string;
  status: number;
  bodyKind: 'array' | 'object' | 'other';
  count: number;
  parse: ParseResult | null;
}

async function probeWindow(ts: number): Promise<ProbeResult> {
  const slug = `btc-updown-5m-${ts}`;
  const url = `${GAMMA_API_BASE}/events?slug=${slug}`;
  const response = await fetch(url, { headers: { accept: 'application/json' } });

  let bodyKind: ProbeResult['bodyKind'] = 'other';
  let count = 0;
  let parse: ParseResult | null = null;
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // Non-JSON body: leave parse=null.
  }

  if (Array.isArray(body)) {
    bodyKind = 'array';
    count = body.length;
  } else if (typeof body === 'object' && body !== null) {
    bodyKind = 'object';
  }

  if (response.status === 200 && body !== null) {
    // Lenient mode for `priceToBeat`. Empirically, Polymarket's gamma-api
    // does NOT expose a numeric resolution price for BTC 5m Up/Down events:
    // resolution is "Up if end-of-window BTC >= start-of-window BTC", so
    // the "price to beat" is the *Chainlink BTC/USD reading at the market's
    // startDate*, captured by the collector via RTDS — not by REST.
    //
    // Therefore the smoke gate validates discovery shape (slug, event id,
    // token IDs, outcomes) but does NOT require a price field in the
    // response. Strict mode is still exercised by unit tests and will
    // be useful if Polymarket starts emitting an explicit field, or for
    // other event families.
    parse = parseBtcUpDownEventResponse(body, slug);
  }

  return { slug, status: response.status, bodyKind, count, parse };
}

function isPassing(r: ProbeResult): boolean {
  return r.status === 200 && r.parse !== null && r.parse.ok;
}

describe.skipIf(SKIP_NETWORK)('gamma-api btc-updown-5m discovery (live)', () => {
  it(
    'returns HTTP 200 with a parseable BTC Up/Down event for at least one recent window slug',
    async () => {
      const nowFloor = Math.floor(Date.now() / (FIVE_MIN_S * 1000)) * FIVE_MIN_S;

      const results: ProbeResult[] = [];
      for (let i = 0; i < WINDOWS_TO_PROBE; i += 1) {
        const ts = nowFloor - i * FIVE_MIN_S;
        // Sequential probes — gamma-api is rate-friendly and we want
        // deterministic ordering for the failure message.
        const result = await probeWindow(ts);
        results.push(result);
        if (isPassing(result)) {
          break;
        }
      }

      const passing = results.find(isPassing);

      // Build a structured failure message so an oncall reading the smoke
      // failure can immediately see what every probe returned, including
      // which shape check (if any) failed.
      const trace = results
        .map((r) => {
          const parseSummary =
            r.parse === null
              ? 'parse=skipped'
              : r.parse.ok
                ? `parse=ok markets=${r.parse.event.markets.length}`
                : `parse=fail(${r.parse.reason})`;
          return `  - ${r.slug}: status=${r.status}, body=${r.bodyKind}, count=${r.count}, ${parseSummary}`;
        })
        .join('\n');

      expect(
        passing,
        `gamma-api smoke gate did not find any parseable BTC 5m market within the ` +
          `last ${WINDOWS_TO_PROBE} windows (~${(WINDOWS_TO_PROBE * FIVE_MIN_S) / 60} min). ` +
          `Probe trace:\n${trace}`
      ).toBeDefined();

      // Sanity-check the passing payload — these assertions duplicate
      // shape checks that the parser already enforced, but failing here
      // means a future parser regression cannot silently let the gate
      // through.
      if (passing && passing.parse?.ok) {
        const event = passing.parse.event;
        expect(event.slug).toBe(passing.slug);
        expect(event.markets.length).toBeGreaterThan(0);
        const market = event.markets[0]!;
        expect(market.tokens.up).toBeTruthy();
        expect(market.tokens.down).toBeTruthy();
        expect(market.tokens.up).not.toBe(market.tokens.down);
        // priceToBeat is intentionally NOT asserted here — see the comment
        // on the parse() call site for the reasoning. A future regression
        // in token-shape parsing would still fail the .toBeDefined() above.
      }
    },
    20_000
  );
});
