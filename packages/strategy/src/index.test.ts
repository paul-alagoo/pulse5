import { describe, it, expect } from 'vitest';
import {
  STRATEGY_VERSION,
  DEFAULT_STRATEGY_CONFIG,
  buildMarketState,
  generateSignal,
  labelSignalOutcome,
  normalizeFinalOutcome,
  DEFAULT_SIGNAL_ENGINE_VERSION,
  KNOWN_SIGNAL_ENGINE_VERSIONS,
  isSignalEngineVersion,
  generateSignalV022,
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

  // v0.2.2 design-freeze scaffolding: the version type, the known-versions
  // list, the boundary guard, and the fail-closed v0.2.2 stub are all
  // reachable through the package index. v0.2.1 stays the default.
  it('exposes the v0.2.2 versioned-engine scaffolding without switching the default', () => {
    expect(typeof isSignalEngineVersion).toBe('function');
    expect(KNOWN_SIGNAL_ENGINE_VERSIONS).toEqual(['v0.2.1', 'v0.2.2']);
    expect(DEFAULT_SIGNAL_ENGINE_VERSION).toBe('v0.2.1');
  });

  it('exposes the frozen v0.2.2 estimator entrypoint via the package index', () => {
    expect(typeof generateSignalV022).toBe('function');
  });
});
