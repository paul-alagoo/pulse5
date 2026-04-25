// Pulse5 storage layer entrypoint.

export const STORAGE_VERSION = '0.1.1';

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
