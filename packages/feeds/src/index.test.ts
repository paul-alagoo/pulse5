import { describe, it, expect } from 'vitest';
import { FEEDS_VERSION } from './index.js';

describe('FEEDS_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof FEEDS_VERSION).toBe('string');
    expect(FEEDS_VERSION.length).toBeGreaterThan(0);
  });

  it('looks semver-ish', () => {
    expect(FEEDS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
