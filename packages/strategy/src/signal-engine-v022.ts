// Pulse5 v0.2.2 — fail-closed stub for the redesigned estimator.
//
// v0.2.2 freezes the estimator design (see
// research/reports/v0.2.2-estimator-design-note.md) but does NOT
// implement its numerical body. The numerical implementation, replay
// calibration, and holdout evaluation are all owned by v0.2.3.
//
// This stub exists so the v0.2.2 entrypoint name is reserved for v0.2.3
// to fill in. Calling it always throws, by design — no caller may
// silently fall through to "v0.2.2 behavior" while the estimator body
// is still pending. Callers that intentionally route to v0.2.2 will
// surface the pending error loudly.

import type { MarketState, Signal } from '@pulse5/models';
import type { StrategyConfig } from './config.js';

export const V022_PENDING_ERROR_MESSAGE =
  'v0.2.3 implementation pending: v0.2.2 estimator body is not implemented in v0.2.2 (design-freeze only). Use the v0.2.1 engine, or wait for v0.2.3.';

/**
 * v0.2.2 estimator entrypoint — STUB ONLY.
 *
 * Throws unconditionally with a clear "v0.2.3 implementation pending"
 * error. v0.2.3 will replace this body with the frozen implementation
 * defined in research/reports/v0.2.2-estimator-design-note.md.
 *
 * Parameters are typed so the v0.2.3 implementation slots in without a
 * signature change. They are intentionally unused inside the stub.
 *
 * @throws Error always.
 */
export function generateSignalV022(
  _state: MarketState,
  _config: StrategyConfig
): Signal {
  throw new Error(V022_PENDING_ERROR_MESSAGE);
}
