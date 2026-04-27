// Pulse5 v0.2 — pure outcome labeler.
//
// After a market resolves, the labeler stamps each signal with:
//   - finalOutcome: the normalized market settlement snapshot (UP|DOWN).
//   - outcome    : WIN | LOSS | NOT_APPLICABLE.
//   - resolvedAt : when the labeling ran.
//
// Semantics:
//   - Accepted BUY_UP wins iff finalOutcome = UP.
//   - Accepted BUY_DOWN wins iff finalOutcome = DOWN.
//   - Accepted losing signals get LOSS.
//   - Rejected signals get NOT_APPLICABLE — they made no claim, so the
//     scoring is undefined; they retain their rejection_reasons unchanged.
//
// `finalOutcome` is *copied from* `markets.final_outcome` at label time.
// The state-builder and signal-engine never read `markets.final_outcome` /
// `markets.status` — only the labeler does, and only here.

import type { Signal, SignalOutcome, SignalSide } from '@pulse5/models';

/**
 * Normalize whatever string Polymarket left in `markets.final_outcome` into
 * the {UP, DOWN, null} alphabet `signals.final_outcome` uses. Anything we
 * don't recognize becomes `null` so the labeler can't silently mis-score a
 * resolution it didn't anticipate.
 */
export function normalizeFinalOutcome(raw: string | null | undefined): SignalSide | null {
  if (typeof raw !== 'string') return null;
  // Polymarket settlement strings observed in v0.1 are "Up"/"Down" (the
  // 5m BTC market outcome labels) and "Yes"/"No" (the canonical CLOB
  // YES/NO labels for the same up/down outcomes). Anything else becomes
  // null so we never silently misscore an unanticipated resolution.
  const upper = raw.trim().toUpperCase();
  if (upper === 'UP' || upper === 'YES') return 'UP';
  if (upper === 'DOWN' || upper === 'NO') return 'DOWN';
  return null;
}

export interface OutcomeLabelInput {
  signal: Signal;
  /** Raw value from `markets.final_outcome`. Will be normalized. */
  rawFinalOutcome: string | null | undefined;
  /** The label clock — typically `now()` in live, or the market end time in replay. */
  resolvedAt: Date;
}

export interface OutcomeLabel {
  outcome: SignalOutcome;
  finalOutcome: SignalSide | null;
  resolvedAt: Date;
}

/**
 * Score a single signal. Pure: same inputs always produce the same label.
 */
export function labelSignalOutcome(input: OutcomeLabelInput): OutcomeLabel {
  const { signal, rawFinalOutcome, resolvedAt } = input;
  const finalOutcome = normalizeFinalOutcome(rawFinalOutcome);

  if (!signal.accepted) {
    return {
      outcome: 'NOT_APPLICABLE',
      finalOutcome,
      resolvedAt,
    };
  }

  // Accepted signals: WIN iff side matches finalOutcome.
  if (finalOutcome === null) {
    // Market resolved with an unrecognized outcome. We cannot honestly
    // call this a WIN or a LOSS, so we mark it NOT_APPLICABLE and the
    // signal still gets its `final_outcome=null` recorded.
    return {
      outcome: 'NOT_APPLICABLE',
      finalOutcome: null,
      resolvedAt,
    };
  }

  if (signal.side === 'UP' && finalOutcome === 'UP') {
    return { outcome: 'WIN', finalOutcome, resolvedAt };
  }
  if (signal.side === 'DOWN' && finalOutcome === 'DOWN') {
    return { outcome: 'WIN', finalOutcome, resolvedAt };
  }

  return { outcome: 'LOSS', finalOutcome, resolvedAt };
}
