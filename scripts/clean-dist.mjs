#!/usr/bin/env node
// Cross-platform `dist/` cleaner used by every workspace package's `build`
// script. Removes the *current package's* `dist/` directory before `tsc`
// runs, so stale outputs (e.g. `dist/*.test.js` left over from a previous
// tsconfig that did not exclude tests) cannot ship via the package's
// `files: ["dist"]` allow-list.
//
// Why a Node script and not `rm -rf dist`?
//   - Windows / PowerShell does not have `rm -rf` — it has `Remove-Item`,
//     and the bash-style command would force the script to run under WSL
//     or Git Bash. A Node script works identically on every host shell.
//
// Safety:
//   - Resolves the deletion target relative to `process.cwd()` (the package
//     dir, set by pnpm when running the workspace script).
//   - Refuses to delete the repo root or any path whose basename is not
//     literally `dist`.
//   - Idempotent: missing `dist/` is treated as success.

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const cwd = process.cwd();
const target = path.resolve(cwd, 'dist');

// Safety guard 1: target basename must be exactly `dist` so a misconfigured
// `cwd` (e.g. running from the repo root because someone pasted the script
// into the wrong package) cannot wipe anything else.
if (path.basename(target) !== 'dist') {
  process.stderr.write(
    `[clean-dist] refusing to delete non-"dist" path: ${target}\n`
  );
  process.exit(1);
}

// Safety guard 2: target must live strictly inside the current cwd. This
// rules out paths like `..\dist` produced by symlink trickery.
const rel = path.relative(cwd, target);
if (rel !== 'dist') {
  process.stderr.write(
    `[clean-dist] refusing to delete dist outside cwd (relative=${rel})\n`
  );
  process.exit(1);
}

// Safety guard 3: never operate on the repo root. We detect "repo root" by
// the presence of `pnpm-workspace.yaml`, which only exists at the monorepo
// root by convention.
if (existsSync(path.join(cwd, 'pnpm-workspace.yaml'))) {
  process.stderr.write(
    `[clean-dist] refusing to run from monorepo root (cwd=${cwd}); ` +
      `this script must be invoked from inside an individual package\n`
  );
  process.exit(1);
}

try {
  await rm(target, { recursive: true, force: true });
} catch (err) {
  process.stderr.write(
    `[clean-dist] failed to remove ${target}: ${err?.stack ?? err}\n`
  );
  process.exit(1);
}
