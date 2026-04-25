// Pulse5 collector entrypoint.

export const COLLECTOR_VERSION = '0.1.1';

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pino from 'pino';
import {
  createDb,
  createMarketsRepository,
  createRawEventsRepository,
  createBookSnapshotsRepository,
  createBtcTicksRepository,
} from '@pulse5/storage';
import { createCollector } from './collector.js';

export { createCollector } from './collector.js';
export { createHealthMetrics } from './health.js';
export { createClobSubscriptionRegistry } from './subscription-manager.js';

export interface RunOptions {
  discoveryIntervalMs?: number;
  healthLogIntervalMs?: number;
}

const POSITIVE_INT_FAILSAFE: Record<'discovery' | 'health', number> = {
  discovery: 5000,
  health: 30000,
};

/**
 * Validate a millisecond interval that comes from env / CLI input. NaN, 0,
 * and negatives would otherwise turn `setInterval` into a hot loop or a
 * silent no-op, so we coerce non-positive integers back to a safe default.
 */
export function validatePositiveIntervalMs(
  raw: string | number | undefined,
  fallback: number
): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return fallback;
  return n;
}

/**
 * Returns true when this module is being executed as the entrypoint. The
 * naive `import.meta.url === \`file://${argv[1]}\`` comparison breaks on
 * Windows because:
 *   - `argv[1]` is a backslash path (`C:\\pulse5\\...`) but `import.meta.url`
 *     uses forward slashes,
 *   - drive letter casing can differ (`C:` vs `c:`),
 *   - a trailing `.ts` from `tsx watch src/index.ts` does not match the
 *     compiled `.js` URL.
 *
 * `fileURLToPath` + `path.resolve` normalizes both sides so the comparison
 * works on Windows, macOS, and Linux.
 */
export function isEntrypoint(
  importMetaUrl: string,
  argv1: string | undefined
): boolean {
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(importMetaUrl);
  } catch {
    return false;
  }
  const normalizedModule = path.resolve(modulePath);
  const normalizedArgv = path.resolve(argv1);
  if (process.platform === 'win32') {
    return normalizedModule.toLowerCase() === normalizedArgv.toLowerCase();
  }
  return normalizedModule === normalizedArgv;
}

/**
 * Production wiring. Connects to Postgres, brings up the discovery /
 * CLOB / RTDS subsystems, and registers a SIGINT/SIGTERM handler for
 * graceful shutdown. Returns once the collector has started; the caller
 * keeps the process alive (the entrypoint below `await`s the shutdown).
 */
export async function runCollector(options: RunOptions = {}): Promise<void> {
  const logger = pino({
    level: process.env['LOG_LEVEL'] ?? 'info',
    base: { app: 'pulse5-collector' },
  });

  const { db, redactedDsn } = createDb();
  logger.info({ component: 'collector', dsn: redactedDsn }, 'connected to postgres (config loaded)');

  const repos = {
    markets: createMarketsRepository(db),
    rawEvents: createRawEventsRepository(db),
    bookSnapshots: createBookSnapshotsRepository(db),
    btcTicks: createBtcTicksRepository(db),
  };

  const discoveryIntervalMs =
    options.discoveryIntervalMs ??
    validatePositiveIntervalMs(
      process.env['DISCOVERY_INTERVAL_MS'],
      POSITIVE_INT_FAILSAFE.discovery
    );
  const healthLogIntervalMs =
    options.healthLogIntervalMs ??
    validatePositiveIntervalMs(
      process.env['HEALTH_LOG_INTERVAL_MS'],
      POSITIVE_INT_FAILSAFE.health
    );

  const collector = createCollector(
    { repos, logger },
    { discoveryIntervalMs, healthLogIntervalMs }
  );

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info({ component: 'collector', signal }, 'shutdown signal received');
    try {
      await collector.stop();
    } finally {
      try {
        await db.end();
      } catch (err) {
        logger.warn(
          { component: 'collector', error: err instanceof Error ? err.message : String(err) },
          'db.end() failed'
        );
      }
    }
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  await collector.start();

  // Keep the process alive until a shutdown signal arrives.
  await new Promise<void>((resolve) => {
    const check = setInterval(() => {
      if (stopping) {
        clearInterval(check);
        resolve();
      }
    }, 250);
  });
}

// Allow `tsx watch src/index.ts` to invoke runCollector directly. The
// Windows-safe entrypoint check is encapsulated in `isEntrypoint` so it can
// be unit-tested across both forward- and back-slash paths.
if (isEntrypoint(import.meta.url, process.argv[1])) {
  runCollector().catch((err: unknown) => {
    // Print only the message — pg / network errors can carry the full DSN
    // (with password) on `err.stack` / `err.toString()`.
    const msg = err instanceof Error ? err.message : String(err);
    console.error('collector crashed:', msg);
    process.exit(1);
  });
}
