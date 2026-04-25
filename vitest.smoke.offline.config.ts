import { defineConfig, mergeConfig } from 'vitest/config';
import smokeConfig from './vitest.smoke.config';

// Offline smoke config: sets PULSE5_SKIP_SMOKE_NETWORK=1 so all live network
// checks are skipped. Used by `pnpm test:smoke:offline`. NOT a release gate.
//
// INVARIANT: passWithNoTests: false is intentionally inherited from
// vitest.smoke.config.ts via mergeConfig. Do NOT add passWithNoTests here —
// the suite must still enumerate at least one test file (even if all tests
// inside it are skipped), so a misconfigured include glob doesn't silently pass.
export default mergeConfig(
  smokeConfig,
  defineConfig({
    test: {
      env: { PULSE5_SKIP_SMOKE_NETWORK: '1' },
    },
  })
);
