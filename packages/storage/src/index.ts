// Pulse5 storage layer entrypoint.

export const STORAGE_VERSION = '0.2.0';

export type { Db, QueryResult, CreateDbOptions } from './client.js';
export { createDb } from './client.js';

export type { ResolvedPgConfig, LoadOptions, PostgresFileShape } from './config.js';
export { loadPgConfig, buildPoolConfigFromFile } from './config.js';

export type { MarketsRepository } from './markets.repo.js';
export { createMarketsRepository } from './markets.repo.js';

export type { RawEventsRepository } from './raw-events.repo.js';
export { createRawEventsRepository } from './raw-events.repo.js';

export type { BookSnapshotsRepository } from './book-snapshots.repo.js';
export { createBookSnapshotsRepository } from './book-snapshots.repo.js';

export type { BtcTicksRepository } from './btc-ticks.repo.js';
export { createBtcTicksRepository } from './btc-ticks.repo.js';

// v0.2 — Shadow Signal Engine repos. These are pure persistence; the
// rejection / acceptance logic itself lives in `packages/strategy`.
export type { MarketStatesRepository } from './market-states.repo.js';
export { createMarketStatesRepository } from './market-states.repo.js';

export type { SignalsRepository } from './signals.repo.js';
export { createSignalsRepository } from './signals.repo.js';
