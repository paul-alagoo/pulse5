import { describe, it, expect } from 'vitest';
import type { Signal } from '@pulse5/models';
import { labelSignalOutcome, normalizeFinalOutcome } from './outcome-labeler.js';

const TS = new Date('2026-04-25T12:32:30Z');
const RESOLVED_AT = new Date('2026-04-25T12:35:30Z');

function fixtureSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 7n,
    ts: TS,
    marketId: 'mkt-1',
    marketStateId: 101n,
    decision: 'BUY_UP',
    side: 'UP',
    price: 0.6,
    estimatedProbability: 0.7,
    estimatedEv: 0.1,
    accepted: true,
    rejectionReasons: [],
    features: { distanceBps: 50 },
    outcome: null,
    finalOutcome: null,
    resolvedAt: null,
    ...overrides,
  };
}

describe('normalizeFinalOutcome', () => {
  it('maps "Up" / "yes" (CLOB YES label) → UP', () => {
    expect(normalizeFinalOutcome('Up')).toBe('UP');
    expect(normalizeFinalOutcome('yes')).toBe('UP');
  });

  it('maps "Down" / "No" (CLOB NO label) → DOWN', () => {
    expect(normalizeFinalOutcome('Down')).toBe('DOWN');
    expect(normalizeFinalOutcome('No')).toBe('DOWN');
  });

  it('returns null for unknown / null / undefined / unanticipated outcomes', () => {
    expect(normalizeFinalOutcome(null)).toBeNull();
    expect(normalizeFinalOutcome(undefined)).toBeNull();
    expect(normalizeFinalOutcome('cancelled')).toBeNull();
    expect(normalizeFinalOutcome('')).toBeNull();
    // "WIN"/"LOSS" are signal-scoring labels (SignalOutcome) and must
    // NOT be treated as market settlement strings — they live in a
    // different vocabulary and accepting them would mask data drift.
    expect(normalizeFinalOutcome('WIN')).toBeNull();
    expect(normalizeFinalOutcome('LOSS')).toBeNull();
  });
});

describe('labelSignalOutcome — accepted signals', () => {
  it('BUY_UP wins when finalOutcome=UP', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal(),
      rawFinalOutcome: 'Up',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('WIN');
    expect(label.finalOutcome).toBe('UP');
    expect(label.resolvedAt).toBe(RESOLVED_AT);
  });

  it('BUY_DOWN wins when finalOutcome=DOWN', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal({ decision: 'BUY_DOWN', side: 'DOWN', price: 0.45 }),
      rawFinalOutcome: 'Down',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('WIN');
    expect(label.finalOutcome).toBe('DOWN');
  });

  it('BUY_UP loses when finalOutcome=DOWN', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal(),
      rawFinalOutcome: 'Down',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('LOSS');
    expect(label.finalOutcome).toBe('DOWN');
  });

  it('BUY_DOWN loses when finalOutcome=UP', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal({ decision: 'BUY_DOWN', side: 'DOWN', price: 0.45 }),
      rawFinalOutcome: 'Up',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('LOSS');
    expect(label.finalOutcome).toBe('UP');
  });

  it('returns NOT_APPLICABLE with finalOutcome=null when settlement is unknown', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal(),
      rawFinalOutcome: 'cancelled',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('NOT_APPLICABLE');
    expect(label.finalOutcome).toBeNull();
  });
});

describe('labelSignalOutcome — rejected signals', () => {
  it('rejected signals get NOT_APPLICABLE regardless of market settlement', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal({
        decision: 'REJECT',
        side: null,
        price: null,
        accepted: false,
        rejectionReasons: ['NO_EDGE'],
      }),
      rawFinalOutcome: 'Up',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('NOT_APPLICABLE');
    expect(label.finalOutcome).toBe('UP');
    expect(label.resolvedAt).toBe(RESOLVED_AT);
  });

  it('records finalOutcome even for rejected signals (for analytics)', () => {
    const label = labelSignalOutcome({
      signal: fixtureSignal({
        decision: 'REJECT',
        side: null,
        accepted: false,
        rejectionReasons: ['STALE_BTC_TICK'],
      }),
      rawFinalOutcome: 'Down',
      resolvedAt: RESOLVED_AT,
    });
    expect(label.outcome).toBe('NOT_APPLICABLE');
    expect(label.finalOutcome).toBe('DOWN');
  });
});

describe('labelSignalOutcome — purity', () => {
  it('does not mutate the input signal', () => {
    const sig = fixtureSignal();
    const before = JSON.stringify({
      ...sig,
      id: sig.id?.toString() ?? null,
      marketStateId: sig.marketStateId?.toString() ?? null,
    });
    labelSignalOutcome({
      signal: sig,
      rawFinalOutcome: 'Up',
      resolvedAt: RESOLVED_AT,
    });
    const after = JSON.stringify({
      ...sig,
      id: sig.id?.toString() ?? null,
      marketStateId: sig.marketStateId?.toString() ?? null,
    });
    expect(after).toBe(before);
  });
});
