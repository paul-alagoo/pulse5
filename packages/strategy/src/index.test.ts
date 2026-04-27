import { describe, it, expect } from 'vitest';
import {
  STRATEGY_VERSION,
  DEFAULT_STRATEGY_CONFIG,
  buildMarketState,
  generateSignal,
  labelSignalOutcome,
  normalizeFinalOutcome,
} from './index.js';

describe('strategy package public surface', () => {
  it('exposes a versioned identity', () => {
    expect(STRATEGY_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exposes pure functions and the default config', () => {
    expect(typeof buildMarketState).toBe('function');
    expect(typeof generateSignal).toBe('function');
    expect(typeof labelSignalOutcome).toBe('function');
    expect(typeof normalizeFinalOutcome).toBe('function');
    expect(DEFAULT_STRATEGY_CONFIG.maxBtcTickAgeMs).toBe(10_000);
  });
});
