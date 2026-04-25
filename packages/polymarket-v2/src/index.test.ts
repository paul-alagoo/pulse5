import { describe, it, expect } from 'vitest';
import { POLYMARKET_V2_VERSION } from './index.js';

describe('POLYMARKET_V2_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof POLYMARKET_V2_VERSION).toBe('string');
    expect(POLYMARKET_V2_VERSION.length).toBeGreaterThan(0);
  });

  it('looks semver-ish', () => {
    expect(POLYMARKET_V2_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
