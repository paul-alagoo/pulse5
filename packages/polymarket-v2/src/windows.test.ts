import { describe, it, expect } from 'vitest';
import { floorToWindow, slugForWindow, planWindows, planWindowSlugs } from './windows.js';

describe('floorToWindow', () => {
  it('rounds down to the nearest 300 s grid', () => {
    // 1714000123 → floor(1714000123/300)*300 = 5713333*300 = 1713999900
    expect(floorToWindow(1714000123_000)).toBe(1713999900);
    expect(floorToWindow(0)).toBe(0);
    expect(floorToWindow(299_999)).toBe(0);
    expect(floorToWindow(300_000)).toBe(300);
  });
});

describe('slugForWindow', () => {
  it('emits the canonical btc-updown-5m-{ts} format', () => {
    expect(slugForWindow(1714000000)).toBe('btc-updown-5m-1714000000');
  });
});

describe('planWindows', () => {
  // 1714000200 % 300 === 0 — exactly on the 300-second grid.
  const nowMs = 1714000200_000;
  it('returns the current window plus configurable past/future', () => {
    const plan = planWindows(nowMs, { lookbackWindows: 2, lookaheadWindows: 1 });
    expect(plan.current).toBe(1714000200);
    expect(plan.past).toEqual([1714000200 - 600, 1714000200 - 300]);
    expect(plan.upcoming).toEqual([1714000200 + 300]);
  });

  it('defaults to lookback=2, lookahead=1', () => {
    const plan = planWindows(nowMs);
    expect(plan.past).toHaveLength(2);
    expect(plan.upcoming).toHaveLength(1);
  });

  it('planWindowSlugs returns slugs in chronological order', () => {
    const slugs = planWindowSlugs(nowMs, { lookbackWindows: 1, lookaheadWindows: 1 });
    expect(slugs).toEqual([
      'btc-updown-5m-1713999900',
      'btc-updown-5m-1714000200',
      'btc-updown-5m-1714000500',
    ]);
  });
});
