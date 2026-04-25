// Pulse5 storage connection config.
//
// Resolution order (highest priority first):
//   1. `DATABASE_URL` env var (the existing repo convention; what
//      `pnpm db:migrate` already uses).
//   2. A local credentials JSON file at `PULSE5_PG_CONFIG_PATH`
//      (default `C:\postgres.json`). The file is ONLY read when
//      `DATABASE_URL` is unset; it is never written and never logged.
//
// The JSON file shape is:
//   { "postgres": {
//       "host": "127.0.0.1",
//       "port": 5432,
//       "username": "postgres",
//       "password": "...secret...",
//       "ssl_mode": "disable" | "require" | "prefer",
//       "databases": { "main": "<dbname>", "test": "<dbname>" }
//   } }
//
// Pick which database via PULSE5_DB_TARGET ("main" | "test" | a literal
// db name). Defaults to "main".
//
// SECURITY NOTES:
//   - The password is stripped from any redacted-DSN string so it never
//     reaches logs.
//   - This module never throws with the password in the message.
//   - The file path defaults are Windows-friendly but configurable; tests
//     inject a temp path rather than the real file.

import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export interface PostgresFileShape {
  postgres: {
    host: string;
    port: number;
    username: string;
    password: string;
    ssl_mode?: string;
    databases?: Record<string, string>;
  };
}

export interface ResolvedPgConfig {
  poolConfig: PoolConfig;
  /** DSN with password redacted as `***`. Safe to log. */
  redactedDsn: string;
  /** Where the config came from, for diagnostics. */
  source: 'DATABASE_URL' | 'json-file';
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Override fs read for tests. */
  readFile?: (path: string) => string;
}

const DEFAULT_JSON_PATH =
  process.platform === 'win32' ? 'C:\\postgres.json' : '/etc/pulse5/postgres.json';

function redactDsn(dsn: string): string {
  // postgres://user:password@host:port/db
  return dsn.replace(/^(postgres(?:ql)?:\/\/[^:@/]+):[^@]+@/, '$1:***@');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parsePostgresFile(raw: string): PostgresFileShape['postgres'] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // Re-throw without leaking file contents.
    throw new Error(`postgres config file is not valid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(parsed) || !isRecord(parsed['postgres'])) {
    throw new Error('postgres config file missing top-level "postgres" object');
  }
  const pg = parsed['postgres'];

  const host = typeof pg['host'] === 'string' ? pg['host'] : null;
  const port = typeof pg['port'] === 'number' ? pg['port'] : null;
  const username = typeof pg['username'] === 'string' ? pg['username'] : null;
  const password = typeof pg['password'] === 'string' ? pg['password'] : null;
  if (!host || !port || !username || password === null) {
    throw new Error(
      'postgres config file is missing required fields (host, port, username, password)'
    );
  }
  const result: PostgresFileShape['postgres'] = { host, port, username, password };
  if (typeof pg['ssl_mode'] === 'string') {
    result.ssl_mode = pg['ssl_mode'];
  }
  if (isRecord(pg['databases'])) {
    const dbs: Record<string, string> = {};
    for (const [k, v] of Object.entries(pg['databases'])) {
      if (typeof v === 'string') dbs[k] = v;
    }
    result.databases = dbs;
  }
  return result;
}

function selectDatabase(
  fileShape: PostgresFileShape['postgres'],
  envTarget: string | undefined
): string {
  const target = envTarget && envTarget.length > 0 ? envTarget : 'main';
  const dbs = fileShape.databases ?? {};
  if (target in dbs && dbs[target]) return dbs[target] as string;
  // If the user passed a literal db name (not a key), accept it directly.
  if (target !== 'main' && target !== 'test') return target;
  throw new Error(
    `postgres config file has no database for target "${target}" ` +
      `(known keys: ${Object.keys(dbs).join(', ') || 'none'})`
  );
}

export function buildPoolConfigFromFile(
  fileShape: PostgresFileShape['postgres'],
  envTarget: string | undefined
): { poolConfig: PoolConfig; redactedDsn: string } {
  const database = selectDatabase(fileShape, envTarget);
  const poolConfig: PoolConfig = {
    host: fileShape.host,
    port: fileShape.port,
    user: fileShape.username,
    password: fileShape.password,
    database,
    ssl: fileShape.ssl_mode === 'require' || fileShape.ssl_mode === 'verify-full' ? true : false,
  };
  const redactedDsn = `postgres://${fileShape.username}:***@${fileShape.host}:${fileShape.port}/${database}`;
  return { poolConfig, redactedDsn };
}

export function loadPgConfig(options: LoadOptions = {}): ResolvedPgConfig {
  const env = options.env ?? process.env;
  const reader = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));

  const databaseUrl = env['DATABASE_URL'];
  if (databaseUrl && databaseUrl.length > 0) {
    return {
      poolConfig: { connectionString: databaseUrl },
      redactedDsn: redactDsn(databaseUrl),
      source: 'DATABASE_URL',
    };
  }

  const path = env['PULSE5_PG_CONFIG_PATH'] ?? DEFAULT_JSON_PATH;
  let raw: string;
  try {
    raw = reader(path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      `cannot read postgres config (DATABASE_URL unset; path="${path}"; code=${code ?? 'unknown'})`
    );
  }
  const fileShape = parsePostgresFile(raw);
  const target = env['PULSE5_DB_TARGET'];
  const { poolConfig, redactedDsn } = buildPoolConfigFromFile(fileShape, target);
  return { poolConfig, redactedDsn, source: 'json-file' };
}

// Exposed for tests / diagnostics. Never accepts unredacted strings back.
export const __internal = { redactDsn, parsePostgresFile, selectDatabase };
