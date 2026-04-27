// Pulse5 v0.2 — Shadow Signal Engine package entrypoint.
//
// This package contains *pure* logic only: the state builder, the signal
// engine, and the outcome labeler. It has no DB / fetch / clock
// dependencies, so live and replay can share the same code path with no
// shim layer. v0.2 explicitly does NOT trade — there is no order, wallet,
// signer, or paper-execution surface in this package.

export const STRATEGY_VERSION = '0.2.0';

export type { StrategyConfig } from './config.js';
export { DEFAULT_STRATEGY_CONFIG } from './config.js';

export type { StateBuilderInput } from './state-builder.js';
export { buildMarketState } from './state-builder.js';

export { generateSignal } from './signal-engine.js';

export type { OutcomeLabelInput, OutcomeLabel } from './outcome-labeler.js';
export { labelSignalOutcome, normalizeFinalOutcome } from './outcome-labeler.js';
