import { describe, it, expect } from 'vitest';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import {
  COLLECTOR_VERSION,
  createCollector,
  createHealthMetrics,
  createClobSubscriptionRegistry,
  isEntrypoint,
  isShadowSignalsEnabled,
  validatePositiveIntervalMs,
} from './index.js';

describe('collector public surface', () => {
  it('exposes a versioned identity', () => {
    expect(COLLECTOR_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exposes factories', () => {
    expect(typeof createCollector).toBe('function');
    expect(typeof createHealthMetrics).toBe('function');
    expect(typeof createClobSubscriptionRegistry).toBe('function');
  });
});

describe('isEntrypoint', () => {
  // Choose a fake absolute path that is valid on both platforms.
  const fakePath =
    process.platform === 'win32' ? 'C:\\repo\\apps\\collector\\src\\index.ts' : '/repo/apps/collector/src/index.ts';
  const fakeUrl = pathToFileURL(fakePath).href;

  it('returns true when import.meta.url and argv[1] resolve to the same file', () => {
    expect(isEntrypoint(fakeUrl, fakePath)).toBe(true);
  });

  it('treats a forward-slash argv[1] equivalent to back-slash on Windows', () => {
    if (process.platform !== 'win32') return;
    const forward = fakePath.replace(/\\/g, '/');
    expect(isEntrypoint(fakeUrl, forward)).toBe(true);
  });

  it('treats drive-letter case as equivalent on Windows', () => {
    if (process.platform !== 'win32') return;
    const lowerDrive = fakePath.replace(/^C:/, 'c:');
    expect(isEntrypoint(fakeUrl, lowerDrive)).toBe(true);
  });

  it('returns false when argv[1] is undefined (e.g. REPL import)', () => {
    expect(isEntrypoint(fakeUrl, undefined)).toBe(false);
  });

  it('returns false when paths differ', () => {
    const otherPath =
      process.platform === 'win32' ? 'C:\\other\\index.ts' : '/other/index.ts';
    expect(isEntrypoint(fakeUrl, otherPath)).toBe(false);
  });

  it('returns false on a malformed import.meta.url instead of throwing', () => {
    expect(isEntrypoint('not-a-file-url', fakePath)).toBe(false);
  });

  it('handles relative argv[1] by resolving against cwd', () => {
    const abs = path.resolve('cli.js');
    const url = pathToFileURL(abs).href;
    expect(isEntrypoint(url, 'cli.js')).toBe(true);
  });
});

describe('validatePositiveIntervalMs', () => {
  it('returns the parsed integer when valid', () => {
    expect(validatePositiveIntervalMs('1500', 30_000)).toBe(1500);
    expect(validatePositiveIntervalMs(2500, 30_000)).toBe(2500);
  });

  it('falls back on undefined / empty / null', () => {
    expect(validatePositiveIntervalMs(undefined, 5000)).toBe(5000);
    expect(validatePositiveIntervalMs('', 5000)).toBe(5000);
  });

  it('falls back on NaN, zero, and negative input', () => {
    expect(validatePositiveIntervalMs('NaN', 5000)).toBe(5000);
    expect(validatePositiveIntervalMs('not-a-number', 5000)).toBe(5000);
    expect(validatePositiveIntervalMs('0', 5000)).toBe(5000);
    expect(validatePositiveIntervalMs(0, 5000)).toBe(5000);
    expect(validatePositiveIntervalMs('-100', 5000)).toBe(5000);
    expect(validatePositiveIntervalMs(-100, 5000)).toBe(5000);
  });

  it('falls back on non-integer input to avoid sub-millisecond chatter', () => {
    expect(validatePositiveIntervalMs('1.5', 5000)).toBe(5000);
    expect(validatePositiveIntervalMs(1.5, 5000)).toBe(5000);
  });
});

describe('isShadowSignalsEnabled (v0.2 env flag)', () => {
  it('returns false when the env var is unset / null / empty', () => {
    expect(isShadowSignalsEnabled(undefined)).toBe(false);
    expect(isShadowSignalsEnabled('')).toBe(false);
    expect(isShadowSignalsEnabled('   ')).toBe(false);
  });

  it('returns false for explicit-disable values (0, false, no)', () => {
    expect(isShadowSignalsEnabled('0')).toBe(false);
    expect(isShadowSignalsEnabled('false')).toBe(false);
    expect(isShadowSignalsEnabled('FALSE')).toBe(false);
    expect(isShadowSignalsEnabled('no')).toBe(false);
  });

  it('returns true on the documented enable token "1"', () => {
    expect(isShadowSignalsEnabled('1')).toBe(true);
  });

  it('treats any other truthy-looking string as enabled', () => {
    expect(isShadowSignalsEnabled('true')).toBe(true);
    expect(isShadowSignalsEnabled('yes')).toBe(true);
    expect(isShadowSignalsEnabled('on')).toBe(true);
  });
});
