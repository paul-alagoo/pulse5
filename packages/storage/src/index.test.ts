import { describe, it, expect } from 'vitest';
import { STORAGE_VERSION } from './index.js';

describe('STORAGE_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof STORAGE_VERSION).toBe('string');
    expect(STORAGE_VERSION.length).toBeGreaterThan(0);
  });

  it('looks semver-ish', () => {
    expect(STORAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
