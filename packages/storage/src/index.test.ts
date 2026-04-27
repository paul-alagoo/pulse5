import { describe, it, expect } from 'vitest';
import {
  STORAGE_VERSION,
  createMarketsRepository,
  createRawEventsRepository,
  createBookSnapshotsRepository,
  createBtcTicksRepository,
  createMarketStatesRepository,
  createSignalsRepository,
  loadPgConfig,
  buildPoolConfigFromFile,
} from './index.js';

describe('storage package public surface', () => {
  it('exposes a versioned identity', () => {
    expect(STORAGE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('exposes repository factory functions', () => {
    expect(typeof createMarketsRepository).toBe('function');
    expect(typeof createRawEventsRepository).toBe('function');
    expect(typeof createBookSnapshotsRepository).toBe('function');
    expect(typeof createBtcTicksRepository).toBe('function');
    expect(typeof createMarketStatesRepository).toBe('function');
    expect(typeof createSignalsRepository).toBe('function');
  });

  it('exposes config helpers', () => {
    expect(typeof loadPgConfig).toBe('function');
    expect(typeof buildPoolConfigFromFile).toBe('function');
  });
});
