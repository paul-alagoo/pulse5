// gamma-api response shape parsing for BTC 5-minute Up/Down markets.
//
// The full v0.1 discovery pipeline lands in Phase 2; this module currently
// exposes only the *robust shape parser* used by the live smoke gate. The
// gamma-api response is permissive (fields can be strings, JSON-encoded
// strings, or full objects depending on the deployment / sample), so the
// parser tries multiple shapes before giving up — and surfaces a structured
// failure reason that the smoke trace can include.
//
// Keep this file framework-free (no zod, no logger). It is pure parsing so
// the smoke test stays fast and so a future Phase 2 zod schema can wrap it
// without a circular dependency.

export interface UpDownTokens {
  up: string;
  down: string;
}

export interface ParsedBtcUpDownMarket {
  marketId: string;
  conditionId: string | null;
  question: string;
  tokens: UpDownTokens;
  priceToBeat: number | null;
}

export interface ParsedBtcUpDownEvent {
  slug: string;
  eventId: string | null;
  markets: ParsedBtcUpDownMarket[];
}

export type ParseFailure = {
  ok: false;
  reason: string;
};

export type ParseSuccess = {
  ok: true;
  event: ParsedBtcUpDownEvent;
};

export type ParseResult = ParseFailure | ParseSuccess;

const SLUG_PATTERN = /^btc-updown-5m-\d+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Tolerate dollar signs / commas in question-extracted prices.
    const cleaned = value.replace(/[\s,$]/g, '');
    const n = Number.parseFloat(cleaned);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

// gamma-api occasionally serializes array-valued fields (clobTokenIds,
// outcomes) as JSON strings instead of arrays. Accept either.
function asArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

// Extract the up/down token IDs from a market record. The canonical shape
// is `clobTokenIds: ["<up>", "<down>"]` paired with `outcomes: ["Up", "Down"]`,
// but we tolerate either ordering and a few alternate field names.
function parseTokens(market: Record<string, unknown>): UpDownTokens | null {
  const tokenIds = asArray(market['clobTokenIds']);
  if (!tokenIds || tokenIds.length < 2) return null;
  const tokenStrings = tokenIds
    .map((t) => asString(t))
    .filter((t): t is string => t !== null);
  if (tokenStrings.length < 2) return null;

  const outcomesRaw = asArray(market['outcomes']);
  const outcomes = outcomesRaw
    ? outcomesRaw.map((o) => (typeof o === 'string' ? o.toLowerCase() : ''))
    : [];

  const upIndex = outcomes.findIndex((o) => o === 'up' || o === 'yes');
  const downIndex = outcomes.findIndex((o) => o === 'down' || o === 'no');

  // gamma-api convention: index 0 = Up, index 1 = Down. Use outcome
  // labels when present; otherwise fall back to positional order.
  const up = upIndex >= 0 ? tokenStrings[upIndex] : tokenStrings[0];
  const down = downIndex >= 0 ? tokenStrings[downIndex] : tokenStrings[1];

  if (!up || !down || up === down) return null;
  return { up, down };
}

// "Price to beat" is the BTC price level the market resolves against. The
// gamma-api exposes it under several names depending on deployment, and on
// older markets it is only present in the question text. We try, in order:
//   1. explicit numeric/string fields on the market (priceToBeat, price_to_beat,
//      strike, strikePrice)
//   2. parsing a `$X,XXX(.XX)?` literal out of the market question.
function parsePriceToBeat(market: Record<string, unknown>): number | null {
  const candidates = [
    market['priceToBeat'],
    market['price_to_beat'],
    market['strike'],
    market['strikePrice'],
  ];
  for (const candidate of candidates) {
    const n = asNumber(candidate);
    if (n !== null) return n;
  }

  const question = asString(market['question']);
  if (question) {
    // Match e.g. "$67,250" or "$67250.5" — pick the first dollar-prefixed
    // number, which by Polymarket convention is the resolution level.
    const match = question.match(/\$\s?([\d,]+(?:\.\d+)?)/);
    if (match && match[1]) {
      const n = asNumber(match[1]);
      if (n !== null) return n;
    }
  }

  return null;
}

function parseMarket(raw: unknown): ParsedBtcUpDownMarket | null {
  if (!isRecord(raw)) return null;
  const tokens = parseTokens(raw);
  if (!tokens) return null;
  const marketId = asString(raw['id']) ?? asString(raw['marketId']);
  if (!marketId) return null;
  const question = asString(raw['question']) ?? '';
  const conditionId = asString(raw['conditionId']) ?? asString(raw['condition_id']);
  return {
    marketId,
    conditionId,
    question,
    tokens,
    priceToBeat: parsePriceToBeat(raw),
  };
}

export interface ParseOptions {
  /**
   * When true, the parser rejects an event whose markets all return
   * `priceToBeat === null`. The release smoke gate runs in strict mode
   * because v0.1's `markets` table requires `price_to_beat` for downstream
   * discovery acceptance — a parser that silently accepts a market without
   * that field would let a real upstream regression slip past the gate.
   *
   * Lenient mode (the default) is exposed for unit tests and for callers
   * that only care about token-shape validity.
   */
  requirePriceToBeat?: boolean;
}

// Top-level parser. `body` is whatever gamma-api returned (already JSON-
// decoded); `expectedSlug` is the slug the smoke test was probing.
//
// Returns a discriminated union so the smoke test can include `reason` in
// the probe trace when shape validation fails.
export function parseBtcUpDownEventResponse(
  body: unknown,
  expectedSlug: string,
  options: ParseOptions = {}
): ParseResult {
  const requirePriceToBeat = options.requirePriceToBeat === true;
  if (!Array.isArray(body)) {
    return { ok: false, reason: 'response body is not an array' };
  }
  if (body.length === 0) {
    return { ok: false, reason: 'response array is empty' };
  }

  if (!SLUG_PATTERN.test(expectedSlug)) {
    // Defensive: caller mis-derived the slug.
    return { ok: false, reason: `expected slug "${expectedSlug}" is malformed` };
  }

  const matchingEvent = body.find(
    (entry): entry is Record<string, unknown> =>
      isRecord(entry) && asString(entry['slug']) === expectedSlug
  );

  // gamma-api sometimes returns the event with no slug match when the query
  // is loose; require an exact match so we don't let unrelated payloads
  // green the smoke gate.
  if (!matchingEvent) {
    return {
      ok: false,
      reason: `no event with slug="${expectedSlug}" in response`,
    };
  }

  const rawMarkets = asArray(matchingEvent['markets']);
  if (!rawMarkets || rawMarkets.length === 0) {
    return {
      ok: false,
      reason: `event "${expectedSlug}" has no markets`,
    };
  }

  const markets: ParsedBtcUpDownMarket[] = [];
  for (const m of rawMarkets) {
    const parsed = parseMarket(m);
    if (parsed) markets.push(parsed);
  }

  if (markets.length === 0) {
    return {
      ok: false,
      reason: `event "${expectedSlug}" has no parseable markets (missing clobTokenIds or id)`,
    };
  }

  if (requirePriceToBeat && !markets.some((m) => m.priceToBeat !== null)) {
    return {
      ok: false,
      reason:
        `event "${expectedSlug}" has no market with a parseable price-to-beat ` +
        `(strict mode); checked priceToBeat / price_to_beat / strike / strikePrice / question $-extraction`,
    };
  }

  return {
    ok: true,
    event: {
      slug: expectedSlug,
      eventId: asString(matchingEvent['id']),
      markets,
    },
  };
}
