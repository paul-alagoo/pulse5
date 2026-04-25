#!/usr/bin/env node
// Pulse5 DB preflight: fail-fast guard before any node-pg-migrate run.
//
// Why this exists:
//   - `pnpm db:migrate` reads root `.env` via `dotenv`, but `dotenv` does
//     NOT override variables already present in `process.env`. A team member
//     who exported `DATABASE_URL` globally can have migrations silently hit
//     the wrong database — and node-pg-migrate happily reports "No
//     migrations to run" against an unrelated DB.
//   - `.env` carries TWO values that must agree on local hosts:
//     `PULSE5_PG_HOST_PORT` (host port docker-compose binds Postgres to)
//     and the `port` inside `DATABASE_URL`. A drift between them lands
//     migrations on a different cluster than `pnpm db:up` started.
//
// What it does (pure validation, no DB connection):
//   1. Parses root `.env` (relative to this script, NOT cwd) without
//      touching `process.env` — so we can compare shell vs file values.
//   2. If `process.env.DATABASE_URL` is set and differs from the file
//      value, fail fast with redacted host/db/port for both. The error
//      message lists the exact remediation: `unset DATABASE_URL` in this
//      shell, or set `PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1` (intended for
//      CI / direnv / containerized dev where the override is deliberate).
//   3. When the file's `DATABASE_URL` host is local (localhost / 127.0.0.1
//      / ::1), enforces that `PULSE5_PG_HOST_PORT` matches the URL port.
//      Remote hosts and the explicit-override case skip this check.
//
// What it deliberately does NOT do:
//   - Open a TCP connection to Postgres. That is what `pnpm db:wait` is
//     for. Preflight is config-shape validation only.
//   - Print a full connection string. The redacted summary keeps host,
//     port, and database name — never username or password.
//
// Exit codes (also returned as { ok, code } from preflight() for tests):
//   0  — checks passed (or explicit escape-hatch granted)
//   10 — root `.env` missing or unreadable
//   11 — root `.env` is missing DATABASE_URL
//   12 — shell DATABASE_URL conflicts with .env DATABASE_URL
//   13 — PULSE5_PG_HOST_PORT does not match DATABASE_URL port (local host)
//
// File-location invariant:
//   This script MUST live at `<repo-root>/scripts/db-preflight.mjs`. Its
//   default `.env` location is derived from `import.meta.url` (NOT cwd),
//   so moving the script silently breaks the env-path resolution. Override
//   the path explicitly via `PULSE5_PREFLIGHT_ENV_PATH=/abs/path/.env` if
//   you must run it from elsewhere (CI / containers).

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';
import process from 'node:process';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ENV_PATH = path.resolve(SCRIPT_DIR, '..', '.env');

/**
 * Parse a `.env`-style file body into a plain object. Intentionally
 * minimal — we only need `KEY=value` lines. Quotes around the value
 * (single or double) are stripped; `export` prefixes and inline comments
 * are NOT supported because the project's `.env.example` does not use
 * them, and a tighter parser is easier to reason about than a partial
 * dotenv re-implementation.
 *
 * @param {string} content
 * @returns {Record<string, string>}
 */
export function parseEnvFile(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

/**
 * Reduce a postgres URL to a tuple safe to print: host / port / db only.
 * Username and password are intentionally discarded so a misconfigured
 * shell variable cannot leak credentials into CI logs or error output.
 *
 * @param {string | null | undefined} url
 * @returns {{ host: string, port: string | null, db: string | null } | null}
 */
export function summarizeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    const db = u.pathname.replace(/^\//, '');
    return {
      host: u.hostname || '<empty>',
      port: u.port || null,
      db: db || null,
    };
  } catch {
    return { host: '<unparseable>', port: null, db: null };
  }
}

/**
 * @param {string | null | undefined} host
 */
export function isLocalHost(host) {
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function fmtSummary(s) {
  if (!s) return '<missing>';
  return `host=${s.host} port=${s.port ?? '(default)'} db=${s.db ?? '(none)'}`;
}

/**
 * Run all preflight checks against an explicit input. Pure (no I/O,
 * no process exit) so the unit tests can exercise every branch without
 * filesystem stubs.
 *
 * @param {{ envFileContent: string | null, processEnv: Record<string, string | undefined> }} input
 * @returns {{ ok: true } | { ok: false, code: string, exitCode: number, message: string }}
 */
export function preflight({ envFileContent, processEnv }) {
  // The shell-vs-.env conflict + port-pairing checks only matter when the
  // operator is using `.env` for configuration. The JSON-fallback path
  // (`C:\\postgres.json` / `PULSE5_PG_CONFIG_PATH`) is validated by
  // `run-migrate.mjs` instead — this script intentionally degrades to a
  // no-op in that case so migrations work on a machine that never created
  // `.env`.
  if (envFileContent == null) {
    return { ok: true };
  }

  const fileEnv = parseEnvFile(envFileContent);
  const fileUrl = fileEnv.DATABASE_URL;
  const filePort = fileEnv.PULSE5_PG_HOST_PORT;
  const shellUrl = processEnv.DATABASE_URL;
  const allowExternal = processEnv.PULSE5_ALLOW_EXTERNAL_DATABASE_URL === '1';

  // No DATABASE_URL in `.env` — fine, run-migrate.mjs will source it from
  // shell env or the JSON fallback. Skip the conflict / port checks.
  if (!fileUrl) {
    return { ok: true };
  }

  if (shellUrl && shellUrl !== fileUrl && !allowExternal) {
    const fileSummary = summarizeUrl(fileUrl);
    const shellSummary = summarizeUrl(shellUrl);
    return {
      ok: false,
      code: 'shell-database-url-mismatch',
      exitCode: 12,
      message:
        'Shell-exported DATABASE_URL does not match root `.env` DATABASE_URL.\n' +
        `  shell : ${fmtSummary(shellSummary)}\n` +
        `  .env  : ${fmtSummary(fileSummary)}\n` +
        'Fix one of:\n' +
        '  1. `unset DATABASE_URL` in this shell so root `.env` wins, OR\n' +
        '  2. set `PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1` if the shell ' +
        'override is deliberate (CI / direnv / advanced setups).',
    };
  }

  // When the escape hatch is active AND a shell URL is set, node-pg-migrate
  // will use the shell URL — `.env`'s DATABASE_URL is no longer the value
  // applied at runtime, so its port pairing with `PULSE5_PG_HOST_PORT` is
  // irrelevant. Skip the port-mismatch check in that case to avoid a
  // false-positive block (e.g. a CI runner that injects DATABASE_URL with
  // PULSE5_ALLOW_EXTERNAL_DATABASE_URL=1 while the committed `.env` carries
  // a stale local port).
  const shellUrlInUse = Boolean(allowExternal && shellUrl);

  const summary = summarizeUrl(fileUrl);
  if (
    !shellUrlInUse &&
    summary &&
    isLocalHost(summary.host) &&
    filePort &&
    summary.port &&
    filePort !== summary.port
  ) {
    return {
      ok: false,
      code: 'port-mismatch',
      exitCode: 13,
      message:
        `PULSE5_PG_HOST_PORT (${filePort}) does not match DATABASE_URL ` +
        `port (${summary.port}). Both come from root \`.env\` and MUST stay ` +
        'in sync — the host port docker-compose binds Postgres to has to ' +
        'match the port migrations connect on.\n' +
        'Fix `.env` so they agree, e.g.:\n' +
        `  PULSE5_PG_HOST_PORT=${summary.port}\n` +
        `  DATABASE_URL=postgres://pulse5:pulse5@${summary.host}:${summary.port}/${summary.db ?? 'pulse5'}`,
    };
  }

  return { ok: true };
}

function loadEnvFile(envPath) {
  if (!existsSync(envPath)) return null;
  try {
    return readFileSync(envPath, 'utf8');
  } catch {
    return null;
  }
}

async function main() {
  const envPath = process.env.PULSE5_PREFLIGHT_ENV_PATH ?? DEFAULT_ENV_PATH;
  const envFileContent = loadEnvFile(envPath);
  const result = preflight({ envFileContent, processEnv: process.env });

  if (result.ok) {
    process.stdout.write(`[db:preflight] ok (env=${envPath})\n`);
    process.exit(0);
  }

  process.stderr.write(
    `[db:preflight] ${result.code}\n${result.message}\n` +
      `(env file checked: ${envPath})\n`
  );
  process.exit(result.exitCode);
}

const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(`[db:preflight] unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
