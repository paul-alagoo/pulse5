#!/usr/bin/env node
// Cross-platform Postgres readiness gate for `pnpm db:wait`.
//
// Polls the docker-compose `postgres` service's healthcheck status using
// `docker inspect`, which is available identically on Windows/PowerShell,
// macOS, and Linux. Exits 0 once the container reports `healthy`, or
// non-zero on timeout / unrecoverable error so CI / scripts fail closed.
//
// Why not `pg_isready` or `docker compose exec`? Both would force a Bash-
// or Linux-shell-specific invocation; `docker inspect` is plain JSON over
// the Docker daemon and works the same way on every host shell.
//
// Exit codes:
//   0 — container reported healthy
//   1 — timed out OR unexpected runtime error
//   2 — container reported unhealthy
//   3 — container exists but has no healthcheck attached
//   4 — Docker daemon unavailable (not running / wrong socket / permission denied)

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const CONTAINER = process.env.PULSE5_PG_CONTAINER ?? 'pulse5-postgres';
const TIMEOUT_MS = Number.parseInt(process.env.PULSE5_PG_WAIT_TIMEOUT_MS ?? '60000', 10);
const POLL_INTERVAL_MS = Number.parseInt(process.env.PULSE5_PG_POLL_INTERVAL_MS ?? '1000', 10);

// Patterns observed across Docker Desktop on Windows (named pipe), macOS,
// and Linux (unix socket) when the daemon is not reachable. Kept regex-
// based so we match the substring even when Docker prepends/appends
// version / wrapping text.
const DAEMON_UNAVAILABLE_PATTERNS = [
  /Cannot connect to the Docker daemon/i,
  /Is the docker daemon running/i,
  /docker daemon[^.]*not running/i,
  // Windows Docker Desktop (Linux engine) named-pipe failure:
  // 'open //./pipe/dockerDesktopLinuxEngine: The system cannot find the file specified.'
  /open \/\/\.\/pipe\/[^:]*:/i,
  /the system cannot find the file specified/i,
  // Linux unix socket:
  /\/var\/run\/docker\.sock/i,
  // CLI itself missing on PATH (treated as daemon-unavailable for our purposes):
  /command not found/i,
  /ENOENT/i,
];

const PERMISSION_DENIED_PATTERNS = [
  /permission denied/i,
  /access is denied/i,
];

const CONTAINER_MISSING_PATTERNS = [
  /No such (object|container)/i,
  /Error: No such/i,
];

/**
 * Classify a `docker inspect` failure so the caller can decide whether to
 * keep polling (recoverable) or fail fast (unrecoverable). Pure function —
 * exported for unit testing.
 *
 * @param {{ stderr?: string | null, errorMessage?: string | null }} input
 * @returns {'daemon-unavailable' | 'permission-denied' | 'container-missing' | 'unknown'}
 */
export function classifyDockerInspectFailure({ stderr, errorMessage } = {}) {
  const corpus = `${stderr ?? ''}\n${errorMessage ?? ''}`;
  if (PERMISSION_DENIED_PATTERNS.some((p) => p.test(corpus))) {
    return 'permission-denied';
  }
  if (DAEMON_UNAVAILABLE_PATTERNS.some((p) => p.test(corpus))) {
    return 'daemon-unavailable';
  }
  if (CONTAINER_MISSING_PATTERNS.some((p) => p.test(corpus))) {
    return 'container-missing';
  }
  return 'unknown';
}

function runDockerInspect() {
  return new Promise((resolve) => {
    const proc = spawn(
      'docker',
      ['inspect', '--format', '{{.State.Health.Status}}', CONTAINER],
      { shell: false }
    );

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    proc.on('error', (err) => {
      // spawn-level error (e.g. ENOENT when `docker` is not on PATH) —
      // surface the message so the classifier can route it to
      // daemon-unavailable rather than busy-polling.
      resolve({
        ok: false,
        status: null,
        stderr: stderr.trim(),
        errorMessage: err.message,
      });
    });
    proc.on('close', (code) => {
      resolve({
        ok: code === 0,
        status: stdout.trim() || null,
        stderr: stderr.trim(),
        errorMessage: null,
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const start = Date.now();
  let lastStatus = null;
  let lastStderr = null;

  process.stdout.write(
    `[db:wait] waiting for container "${CONTAINER}" to report healthy ` +
      `(timeout=${TIMEOUT_MS}ms, interval=${POLL_INTERVAL_MS}ms)\n`
  );

  while (Date.now() - start < TIMEOUT_MS) {
    const result = await runDockerInspect();

    if (!result.ok) {
      lastStderr = result.stderr || result.errorMessage;
      const failureKind = classifyDockerInspectFailure({
        stderr: result.stderr,
        errorMessage: result.errorMessage,
      });

      if (failureKind === 'daemon-unavailable') {
        process.stderr.write(
          `[db:wait] Docker daemon unavailable (is Docker Desktop running?); ` +
            `aborting fast.\nstderr: ${lastStderr ?? 'none'}\n`
        );
        process.exit(4);
      }
      if (failureKind === 'permission-denied') {
        process.stderr.write(
          `[db:wait] permission denied talking to Docker; aborting fast.\n` +
            `stderr: ${lastStderr ?? 'none'}\n`
        );
        process.exit(4);
      }

      // 'container-missing' or 'unknown' — container may not exist yet
      // (compose still starting). Keep polling until the timeout.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }

    lastStatus = result.status;

    if (lastStatus === 'healthy') {
      const elapsed = Date.now() - start;
      process.stdout.write(`[db:wait] ${CONTAINER} is healthy after ${elapsed}ms\n`);
      process.exit(0);
    }

    // Compose with healthcheck reports: starting | healthy | unhealthy.
    // A blank string can mean the container exists but has no healthcheck
    // attached — treat that as a hard error so we don't busy-wait.
    if (lastStatus === 'unhealthy') {
      process.stderr.write(
        `[db:wait] container "${CONTAINER}" reported unhealthy; aborting\n`
      );
      process.exit(2);
    }

    if (lastStatus === '<no value>' || lastStatus === '') {
      process.stderr.write(
        `[db:wait] container "${CONTAINER}" has no healthcheck attached; ` +
          `update docker-compose.yml or set PULSE5_PG_CONTAINER\n`
      );
      process.exit(3);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  process.stderr.write(
    `[db:wait] timed out after ${TIMEOUT_MS}ms ` +
      `(last status=${lastStatus ?? 'unknown'}, last stderr=${lastStderr ?? 'none'})\n`
  );
  process.exit(1);
}

// Only run main() when invoked as the entry script — keeps the file
// importable for unit tests without triggering side effects.
const invokedAsScript =
  process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(`[db:wait] unexpected error: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
