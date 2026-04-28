// Pulse5 v0.2.2 — Versioned signal-engine identifier (design-freeze
// scaffolding only).
//
// v0.2.1 is the *default* and reproducible engine. v0.2.2 is the frozen
// redesign whose numerical body, replay calibration, and holdout
// evaluation are all owned by v0.2.3 (see
// research/reports/v0.2.2-estimator-design-note.md).
//
// This module exists so the v0.2.2 entrypoint name is reserved at the
// type level for v0.2.3 to fill in. v0.2.2 ships zero numerical estimator
// logic, zero schema changes, and does not switch the default engine.

/**
 * Versions of the pure signal engine that may be selected at scoring
 * time. Treat as a closed union: adding a new version is a redesign
 * task, not a configuration change.
 */
export type SignalEngineVersion = 'v0.2.1' | 'v0.2.2';

/**
 * Versions known to this build. Order is stable so reports / iteration
 * can rely on it.
 */
export const KNOWN_SIGNAL_ENGINE_VERSIONS: readonly SignalEngineVersion[] = [
  'v0.2.1',
  'v0.2.2',
] as const;

/**
 * Default engine version. v0.2.2 is design-freeze only — its estimator
 * body lives in v0.2.3. v0.2.1 must remain the default until v0.2.3
 * ships AND its holdout evaluation passes; design-freeze alone does not
 * promote the default.
 */
export const DEFAULT_SIGNAL_ENGINE_VERSION: SignalEngineVersion = 'v0.2.1';

/**
 * Type guard. Narrows arbitrary input (CLI args, JSON config, env vars)
 * into the closed `SignalEngineVersion` union, or returns false. Always
 * use this at system boundaries before passing a string to engine code.
 */
export function isSignalEngineVersion(value: unknown): value is SignalEngineVersion {
  return value === 'v0.2.1' || value === 'v0.2.2';
}
