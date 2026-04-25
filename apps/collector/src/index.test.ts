import { describe, it, expect } from 'vitest';
import { COLLECTOR_VERSION } from './index.js';

describe('COLLECTOR_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof COLLECTOR_VERSION).toBe('string');
    expect(COLLECTOR_VERSION.length).toBeGreaterThan(0);
  });

  it('looks semver-ish', () => {
    expect(COLLECTOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
