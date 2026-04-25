import { defineConfig } from 'vitest/config';

// Coverage gate: per-file thresholds. The previous aggregate-only
// configuration allowed a heavily-tested package to mask a near-zero
// coverage in another package. With `perFile: true`, every covered file
// must clear the threshold individually, matching the README's "80%
// coverage per package" promise more strictly (per-file is a strict
// superset of per-package).
//
// `include` is scoped to workspace `src` directories so generated `dist`
// output and test files do not skew the gate.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.smoke.test.ts'],
    // Reject committed `.only`. A focused test silently shrinks the unit /
    // coverage gate; failing fast forces the offending commit to be cleaned
    // up rather than letting a green CI hide a partial run.
    allowOnly: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['packages/*/src/**', 'apps/*/src/**'],
      exclude: [
        '**/*.test.ts',
        '**/*.smoke.test.ts',
        '**/dist/**',
        // Production composition / runtime wiring — exercised only in
        // `pnpm dev:collector` against a live Postgres + Polymarket
        // WS. Covered by manual / soak verification, not unit tests.
        'apps/collector/src/index.ts',
        'packages/storage/src/client.ts',
      ],
      thresholds: {
        perFile: true,
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
