import { defineConfig } from 'vitest/config';

// Smoke test config: live endpoint checks (gamma-api, RTDS, CLOB WS).
// Runs live by default — this is the authoritative release gate. To skip the
// live probes (e.g. air-gapped CI), use `pnpm test:smoke:offline`, which
// sets PULSE5_SKIP_SMOKE_NETWORK=1 via vitest.smoke.offline.config.ts.
export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['**/*.smoke.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    passWithNoTests: false,
    // Reject committed `.only`. The offline smoke variant inherits this
    // via mergeConfig in vitest.smoke.offline.config.ts.
    allowOnly: false,
  },
});
