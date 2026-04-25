import { describe, it, expect } from 'vitest';
import { parseBtcUpDownEventResponse } from './discovery.js';

const SLUG = 'btc-updown-5m-1714000000';

// Minimal canonical fixture mirroring gamma-api's documented BTC 5m
// Up/Down event shape. Kept inline so the test fully describes what the
// parser is contracted to accept.
function canonicalEventBody() {
  return [
    {
      id: 'evt-001',
      slug: SLUG,
      title: 'BTC Up or Down — 5m window',
      markets: [
        {
          id: 'mkt-001',
          conditionId: 'cond-001',
          question: 'Will BTC be above $67,250 at 12:35 PM ET?',
          clobTokenIds: ['token-up', 'token-down'],
          outcomes: ['Up', 'Down'],
        },
      ],
    },
  ];
}

describe('parseBtcUpDownEventResponse', () => {
  it('accepts a canonical event with up/down outcomes and dollar-strike question', () => {
    const result = parseBtcUpDownEventResponse(canonicalEventBody(), SLUG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.slug).toBe(SLUG);
    expect(result.event.eventId).toBe('evt-001');
    expect(result.event.markets).toHaveLength(1);
    const m = result.event.markets[0]!;
    expect(m.marketId).toBe('mkt-001');
    expect(m.conditionId).toBe('cond-001');
    expect(m.tokens).toEqual({ up: 'token-up', down: 'token-down' });
    expect(m.priceToBeat).toBe(67250);
  });

  it('accepts JSON-string-encoded clobTokenIds and outcomes', () => {
    const body = [
      {
        id: 'evt-002',
        slug: SLUG,
        markets: [
          {
            id: 'mkt-002',
            question: 'Will BTC be above $70000 at 12:40?',
            clobTokenIds: '["t-up","t-down"]',
            outcomes: '["Up","Down"]',
          },
        ],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.markets[0]!.tokens).toEqual({
      up: 't-up',
      down: 't-down',
    });
    expect(result.event.markets[0]!.priceToBeat).toBe(70000);
  });

  it('honours explicit priceToBeat field over dollar-extraction from question', () => {
    const body = [
      {
        slug: SLUG,
        markets: [
          {
            id: 'mkt-003',
            question: 'BTC level — see priceToBeat',
            clobTokenIds: ['a', 'b'],
            outcomes: ['Up', 'Down'],
            priceToBeat: 12345.67,
          },
        ],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.markets[0]!.priceToBeat).toBe(12345.67);
  });

  it('falls back to positional order when outcomes are missing', () => {
    const body = [
      {
        slug: SLUG,
        markets: [
          {
            id: 'mkt-004',
            question: 'Will BTC be above $50000?',
            clobTokenIds: ['pos0', 'pos1'],
          },
        ],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.markets[0]!.tokens).toEqual({ up: 'pos0', down: 'pos1' });
  });

  it('rejects a non-array body', () => {
    const result = parseBtcUpDownEventResponse({ slug: SLUG }, SLUG);
    expect(result).toEqual({ ok: false, reason: 'response body is not an array' });
  });

  it('rejects an empty array', () => {
    const result = parseBtcUpDownEventResponse([], SLUG);
    expect(result).toEqual({ ok: false, reason: 'response array is empty' });
  });

  it('rejects a malformed expected slug', () => {
    const result = parseBtcUpDownEventResponse(canonicalEventBody(), 'not-a-slug');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('malformed');
  });

  it('rejects a body with no event matching the expected slug', () => {
    const body = [{ slug: 'btc-updown-5m-9999999999', markets: [{}] }];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain(SLUG);
  });

  it('rejects an event with no markets array', () => {
    const body = [{ slug: SLUG }];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no markets');
  });

  it('rejects an event whose markets all lack clobTokenIds', () => {
    const body = [
      {
        slug: SLUG,
        markets: [{ id: 'mkt-x', question: '$1' }],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('no parseable markets');
  });

  it('rejects markets with duplicate up/down token ids', () => {
    const body = [
      {
        slug: SLUG,
        markets: [
          {
            id: 'mkt-dup',
            clobTokenIds: ['same', 'same'],
            outcomes: ['Up', 'Down'],
          },
        ],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(false);
  });

  it('returns null priceToBeat in lenient mode when the field and the question carry no number', () => {
    const body = [
      {
        slug: SLUG,
        markets: [
          {
            id: 'mkt-no-price',
            question: 'No dollar amount here',
            clobTokenIds: ['u', 'd'],
            outcomes: ['Up', 'Down'],
          },
        ],
      },
    ];
    const result = parseBtcUpDownEventResponse(body, SLUG);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.event.markets[0]!.priceToBeat).toBeNull();
  });

  describe('requirePriceToBeat (strict mode)', () => {
    it('rejects an event whose only market has no price-to-beat', () => {
      const body = [
        {
          slug: SLUG,
          markets: [
            {
              id: 'mkt-no-price',
              question: 'No dollar amount here',
              clobTokenIds: ['u', 'd'],
              outcomes: ['Up', 'Down'],
            },
          ],
        },
      ];
      const result = parseBtcUpDownEventResponse(body, SLUG, {
        requirePriceToBeat: true,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('strict mode');
      expect(result.reason).toContain('price-to-beat');
    });

    it('accepts when at least one market exposes priceToBeat via question $-extraction', () => {
      const body = [
        {
          slug: SLUG,
          markets: [
            {
              id: 'mkt-good',
              question: 'Will BTC be above $67,250 at 12:35?',
              clobTokenIds: ['u', 'd'],
              outcomes: ['Up', 'Down'],
            },
          ],
        },
      ];
      const result = parseBtcUpDownEventResponse(body, SLUG, {
        requirePriceToBeat: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.markets[0]!.priceToBeat).toBe(67250);
    });

    it('accepts when at least one market exposes an explicit priceToBeat field', () => {
      const body = [
        {
          slug: SLUG,
          markets: [
            {
              id: 'mkt-explicit',
              question: 'No dollar in question',
              clobTokenIds: ['u', 'd'],
              outcomes: ['Up', 'Down'],
              priceToBeat: 99999.5,
            },
          ],
        },
      ];
      const result = parseBtcUpDownEventResponse(body, SLUG, {
        requirePriceToBeat: true,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.event.markets[0]!.priceToBeat).toBe(99999.5);
    });

    it('accepts when only one of multiple markets has a price-to-beat', () => {
      // gamma-api occasionally returns a synthetic / placeholder market
      // alongside the real one. As long as ANY market parses a price the
      // gate should pass.
      const body = [
        {
          slug: SLUG,
          markets: [
            {
              id: 'mkt-empty',
              question: 'no $ here',
              clobTokenIds: ['a', 'b'],
              outcomes: ['Up', 'Down'],
            },
            {
              id: 'mkt-real',
              question: 'Will BTC be above $40000?',
              clobTokenIds: ['c', 'd'],
              outcomes: ['Up', 'Down'],
            },
          ],
        },
      ];
      const result = parseBtcUpDownEventResponse(body, SLUG, {
        requirePriceToBeat: true,
      });
      expect(result.ok).toBe(true);
    });

    it('explicit requirePriceToBeat=false matches the default (lenient) behaviour', () => {
      const body = [
        {
          slug: SLUG,
          markets: [
            {
              id: 'mkt-no-price',
              question: 'no $ here',
              clobTokenIds: ['u', 'd'],
              outcomes: ['Up', 'Down'],
            },
          ],
        },
      ];
      const lenient = parseBtcUpDownEventResponse(body, SLUG, {
        requirePriceToBeat: false,
      });
      const defaultMode = parseBtcUpDownEventResponse(body, SLUG);
      expect(lenient.ok).toBe(true);
      expect(defaultMode.ok).toBe(true);
    });
  });
});
