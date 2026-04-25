// Pulse5 storage pg client.
//
// We expose a thin `Db` interface on top of `pg.Pool` so the repositories
// can be unit-tested with an in-memory mock without needing a live cluster.

import { Pool, type PoolConfig, type QueryResultRow } from 'pg';
import { loadPgConfig, type ResolvedPgConfig } from './config.js';

export interface QueryResult<R extends QueryResultRow = QueryResultRow> {
  rows: R[];
  rowCount: number;
}

export interface Db {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<QueryResult<R>>;
  end(): Promise<void>;
}

class PoolDb implements Db {
  private readonly pool: Pool;

  constructor(poolConfig: PoolConfig) {
    this.pool = new Pool(poolConfig);
  }

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params: ReadonlyArray<unknown> = []
  ): Promise<QueryResult<R>> {
    const result = await this.pool.query<R>(text, params as unknown[]);
    return { rows: result.rows, rowCount: result.rowCount ?? 0 };
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

export interface CreateDbOptions {
  /** Override config loader for tests. */
  configOverride?: ResolvedPgConfig;
}

export function createDb(options: CreateDbOptions = {}): { db: Db; redactedDsn: string } {
  const config = options.configOverride ?? loadPgConfig();
  return { db: new PoolDb(config.poolConfig), redactedDsn: config.redactedDsn };
}
