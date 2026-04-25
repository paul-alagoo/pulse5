import { describe, it, expect } from 'vitest';
import { MODELS_VERSION } from './index.js';

describe('MODELS_VERSION', () => {
  it('is a non-empty string', () => {
    expect(typeof MODELS_VERSION).toBe('string');
    expect(MODELS_VERSION.length).toBeGreaterThan(0);
  });

  it('looks semver-ish', () => {
    expect(MODELS_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });
});
