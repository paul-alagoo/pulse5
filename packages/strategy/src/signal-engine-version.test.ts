import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SIGNAL_ENGINE_VERSION,
  KNOWN_SIGNAL_ENGINE_VERSIONS,
  isSignalEngineVersion,
} from './signal-engine-version.js';

describe('SignalEngineVersion — type / interface contract', () => {
  it('default engine version is v0.2.1 (v0.2.2 design-freeze must NOT switch the default)', () => {
    expect(DEFAULT_SIGNAL_ENGINE_VERSION).toBe('v0.2.1');
  });

  it('lists v0.2.1 and v0.2.2 as the only known versions, in stable order', () => {
    expect(KNOWN_SIGNAL_ENGINE_VERSIONS).toEqual(['v0.2.1', 'v0.2.2']);
    expect(KNOWN_SIGNAL_ENGINE_VERSIONS.length).toBe(2);
  });

  it('the default version is one of the known versions', () => {
    expect(KNOWN_SIGNAL_ENGINE_VERSIONS).toContain(DEFAULT_SIGNAL_ENGINE_VERSION);
  });
});

describe('isSignalEngineVersion — boundary guard', () => {
  it('accepts every version listed in KNOWN_SIGNAL_ENGINE_VERSIONS', () => {
    for (const v of KNOWN_SIGNAL_ENGINE_VERSIONS) {
      expect(isSignalEngineVersion(v)).toBe(true);
    }
  });

  it('rejects unknown version strings', () => {
    expect(isSignalEngineVersion('v0.2.0')).toBe(false);
    expect(isSignalEngineVersion('v0.2.3')).toBe(false);
    expect(isSignalEngineVersion('v0.3')).toBe(false);
    expect(isSignalEngineVersion('')).toBe(false);
    expect(isSignalEngineVersion('V0.2.1')).toBe(false);
  });

  it('rejects non-string inputs without throwing', () => {
    expect(isSignalEngineVersion(undefined)).toBe(false);
    expect(isSignalEngineVersion(null)).toBe(false);
    expect(isSignalEngineVersion(0.21)).toBe(false);
    expect(isSignalEngineVersion({})).toBe(false);
    expect(isSignalEngineVersion([])).toBe(false);
    expect(isSignalEngineVersion(false)).toBe(false);
  });
});
