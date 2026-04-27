#!/usr/bin/env node
// Pulse5 migration runner.
//
// Wraps `node-pg-migrate` so the same connection-resolution rules used by
// the runtime (`packages/storage/src/config.ts`) also apply to `pnpm
// db:migrate`. Resolution order (highest priority first):
//   1. `DATABASE_URL` from env (or the `.env` loaded by node-pg-migrate),
//   2. JSON config at `PULSE5_PG_CONFIG_PATH` (default `C:\\postgres.json`
//      on Windows, `/etc/pulse5/postgres.json` elsewhere) — same shape as
//      the runtime loader.
//
// Why this exists: the runtime collector can boot from `C:\postgres.json`
// when no `.env` is present, but the migration script previously required
// `DATABASE_URL` no matter what. Out-of-band schema setup on a fresh
// machine therefore needed a duplicate `.env` *just* for migrations. This
// wrapper reads the same JSON file the runtime does and synthesises a
// safe `DATABASE_URL` for node-pg-migrate.
//
// SECURITY:
//   - The synthesised DATABASE_URL is passed via `child.env`, never
//     printed and never written to disk.
//   - Any error message we surface uses a redacted DSN
//     (`postgres://user:***@host:port/db`) — the password never touches
//     stdout / stderr / log files.
//   - We do not modify `process.env` of the parent process.

import { spawn } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const ENV_PATH = path.join(REPO_ROOT, '.env');
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations');

const DEFAULT_JSON_PATH =
  process.platform === 'win32' ? 'C:\\postgres.json' : '/etc/pulse5/postgres.json';

/**
 * Locate the node-pg-migrate CLI across both hoisted/symlinked node_modules
 * and pnpm's virtual-store layout. In this workspace, node-pg-migrate is a
 * dependency of @pulse5/storage, so pnpm does not necessarily expose
 * `node_modules/node-pg-migrate` at the repo root.
 */
export function resolveNodePgMigrateBin({
  repoRoot = REPO_ROOT,
  exists = existsSync,
  pnpmDirEntries = (dir) => readdirSync(dir),
} = {}) {
  const rootCandidate = path.join(
    repoRoot,
    'node_modules',
    'node-pg-migrate',
    'bin',
    'node-pg-migrate.js'
  );
  if (exists(rootCandidate)) return rootCandidate;

  const pnpmStore = path.join(repoRoot, 'node_modules', '.pnpm');
  let entries;
  try {
    entries = pnpmDirEntries(pnpmStore);
  } catch {
    entries = [];
  }

  for (const entry of entries) {
    const name = typeof entry === 'string' ? entry : entry?.name;
    if (typeof name !== 'string' || !name.startsWith('node-pg-migrate@')) {
      continue;
    }
    const candidate = path.join(
      pnpmStore,
      name,
      'node_modules',
      'node-pg-migrate',
      'bin',
      'node-pg-migrate.js'
    );
    if (exists(candidate)) return candidate;
  }

  throw new Error(
    'cannot locate node-pg-migrate CLI; run `pnpm install` and verify @pulse5/storage dependencies'
  );
}

/** Strip the password from a postgres URL for log-safe printing. */
export function redactDsn(dsn) {
  if (typeof dsn !== 'string') return '<missing>';
  return dsn.replace(/^(postgres(?:ql)?:\/\/[^:@/]+):[^@]+@/, '$1:***@');
}

function isObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Parse the same JSON shape `packages/storage/src/config.ts` expects. Throws
 * with a non-leaking message on malformed input — the password is NEVER
 * echoed in any error.
 */
export function parsePostgresFile(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`postgres config file is not valid JSON: ${err.message}`);
  }
  if (!isObject(parsed) || !isObject(parsed.postgres)) {
    throw new Error('postgres config file missing top-level "postgres" object');
  }
  const pg = parsed.postgres;
  const host = typeof pg.host === 'string' ? pg.host : null;
  const port = typeof pg.port === 'number' ? pg.port : null;
  const username = typeof pg.username === 'string' ? pg.username : null;
  const password = typeof pg.password === 'string' ? pg.password : null;
  if (!host || !port || !username || password === null) {
    throw new Error(
      'postgres config file is missing required fields (host, port, username, password)'
    );
  }
  const databases = isObject(pg.databases) ? pg.databases : {};
  return { host, port, username, password, databases, sslMode: pg.ssl_mode };
}

/** Pick a database name from the JSON `databases` map, accepting a literal name as a fallback. */
export function selectDatabase(parsed, target) {
  const key = target && target.length > 0 ? target : 'main';
  const dbs = parsed.databases ?? {};
  if (key in dbs && typeof dbs[key] === 'string') return dbs[key];
  if (key !== 'main' && key !== 'test') return key;
  throw new Error(
    `postgres config file has no database for target "${key}" ` +
      `(known keys: ${Object.keys(dbs).join(', ') || 'none'})`
  );
}

/**
 * Pure: build a DATABASE_URL from the JSON config plus an optional target.
 * Returns the URL and a redacted form for diagnostics. Encodes user /
 * password to be URL-safe so special characters do not corrupt the DSN.
 */
export function buildDatabaseUrl(parsed, target) {
  const database = selectDatabase(parsed, target);
  const user = encodeURIComponent(parsed.username);
  const password = encodeURIComponent(parsed.password);
  const dsn = `postgres://${user}:${password}@${parsed.host}:${parsed.port}/${database}`;
  const redacted = `postgres://${user}:***@${parsed.host}:${parsed.port}/${database}`;
  return { dsn, redacted };
}

/**
 * Pure: decide which connection string to use from the inputs we are given.
 * Returns either { dsn, source: 'env' } when DATABASE_URL is present in env
 * OR in the .env file, or { dsn, source: 'json-file', path } when the JSON
 * fallback was used. Throws (with redacted message) when neither source
 * yields a usable URL.
 *
 * @param {object} input
 * @param {NodeJS.ProcessEnv} input.processEnv
 * @param {string | null} input.envFileContent — root `.env` body or null
 * @param {(p: string) => string} input.readJson — file reader for the JSON fallback
 */
export function resolveConnection(input) {
  // 1. Process env.
  const fromEnv = input.processEnv.DATABASE_URL;
  if (fromEnv && fromEnv.length > 0) {
    return { dsn: fromEnv, source: 'env', redacted: redactDsn(fromEnv) };
  }
  // 2. .env file (matches what node-pg-migrate would otherwise read).
  if (input.envFileContent) {
    for (const rawLine of input.envFileContent.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      if (key !== 'DATABASE_URL') continue;
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (val.length > 0) {
        return { dsn: val, source: 'env-file', redacted: redactDsn(val) };
      }
    }
  }
  // 3. JSON fallback.
  const jsonPath = input.processEnv.PULSE5_PG_CONFIG_PATH ?? DEFAULT_JSON_PATH;
  let raw;
  try {
    raw = input.readJson(jsonPath);
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : 'unknown';
    throw new Error(
      `cannot resolve DATABASE_URL: env unset, .env has no DATABASE_URL, ` +
        `and JSON fallback "${jsonPath}" is unreadable (code=${code ?? 'unknown'})`
    );
  }
  const parsed = parsePostgresFile(raw);
  const target = input.processEnv.PULSE5_DB_TARGET;
  const { dsn, redacted } = buildDatabaseUrl(parsed, target);
  return { dsn, source: 'json-file', path: jsonPath, redacted };
}

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return null;
  try {
    return readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
}

function readJsonFile(p) {
  return readFileSync(p, 'utf8');
}

function pickCommand(argv) {
  // The package.json invokes us with the migration command as argv[0].
  // Fail closed if it is missing — we don't want to default to "up" silently.
  const command = argv[0];
  if (command !== 'up' && command !== 'down' && command !== 'create') {
    throw new Error(
      `run-migrate: missing or invalid command; expected "up", "down", or "create", got "${command ?? '<none>'}"`
    );
  }
  return command;
}

export function buildNodePgMigrateArgs({
  migrateBin,
  command,
  migrationsDir,
  extraArgs = [],
}) {
  const base = [migrateBin, command, ...extraArgs, '--migrations-dir', migrationsDir];
  if (command === 'create') {
    return [...base, '--migration-file-language', 'ts'];
  }
  return [...base, '--tsx'];
}

async function main() {
  const argv = process.argv.slice(2);
  const command = pickCommand(argv);
  const extraArgs = argv.slice(1);
  const migrateBin = resolveNodePgMigrateBin({ repoRoot: REPO_ROOT });

  if (command === 'create') {
    const args = buildNodePgMigrateArgs({
      migrateBin,
      command,
      migrationsDir: MIGRATIONS_DIR,
      extraArgs,
    });
    const child = spawn(process.execPath, args, {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });
    child.on('error', (err) => {
      process.stderr.write(`[db:migrate] node-pg-migrate failed to start: ${err.message}\n`);
      process.exit(21);
    });
    return;
  }

  const envFileContent = loadEnvFile(ENV_PATH);
  let resolved;
  try {
    resolved = resolveConnection({
      processEnv: process.env,
      envFileContent,
      readJson: readJsonFile,
    });
  } catch (err) {
    process.stderr.write(`[db:migrate] ${err.message}\n`);
    process.exit(20);
  }

  process.stdout.write(
    `[db:migrate] using DATABASE_URL from ${resolved.source}` +
      (resolved.path ? ` (path=${resolved.path})` : '') +
      ` (${resolved.redacted})\n`
  );

  const args = buildNodePgMigrateArgs({
    migrateBin,
    command,
    migrationsDir: MIGRATIONS_DIR,
    extraArgs,
  });

  // Pass DATABASE_URL via the child env ONLY — it never lands on disk and
  // is not visible in the parent shell's environment.
  const child = spawn(process.execPath, args, {
    cwd: REPO_ROOT,
    env: { ...process.env, DATABASE_URL: resolved.dsn },
    stdio: 'inherit',
  });

  child.on('exit', (code) => {
    process.exit(code ?? 0);
  });
  child.on('error', (err) => {
    // The redacted DSN is already in the success line; do NOT include the
    // raw value in the failure message either.
    process.stderr.write(`[db:migrate] node-pg-migrate failed to start: ${err.message}\n`);
    process.exit(21);
  });
}

// Same Windows-safe entrypoint check as `apps/collector/src/index.ts`:
// `argv[1]` may use back- or forward-slash, and the drive-letter case can
// disagree with what `import.meta.url` resolves to.
function invokedAsScript() {
  if (!process.argv[1]) return false;
  let modulePath;
  try {
    modulePath = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
  const a = path.resolve(modulePath);
  const b = path.resolve(process.argv[1]);
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

if (invokedAsScript()) {
  main().catch((err) => {
    process.stderr.write(`[db:migrate] unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
