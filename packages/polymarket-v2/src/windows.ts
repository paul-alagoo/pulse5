// 5-minute window math for BTC Up/Down market discovery.
//
// Polymarket creates one market per 300 s window with slug
// `btc-updown-5m-{ts}`, where `ts` is a Unix timestamp (seconds) on a
// 300 s grid. Pulse5's discovery loop walks the *current* and a small
// number of *upcoming* windows so subscriptions can be opened ahead of
// time, plus a few *recent* windows to backfill missed creations.

export const FIVE_MIN_S = 300;

export function floorToWindow(nowMs: number): number {
  return Math.floor(nowMs / 1000 / FIVE_MIN_S) * FIVE_MIN_S;
}

export function slugForWindow(ts: number): string {
  return `btc-updown-5m-${ts}`;
}

export interface WindowPlan {
  /** Current window timestamp (seconds, on the 300 s grid). */
  current: number;
  /** Windows in the past, oldest first. */
  past: number[];
  /** Windows in the future, nearest first. */
  upcoming: number[];
}

export function planWindows(
  nowMs: number,
  options: { lookbackWindows?: number; lookaheadWindows?: number } = {}
): WindowPlan {
  const lookback = options.lookbackWindows ?? 2;
  const lookahead = options.lookaheadWindows ?? 1;
  const current = floorToWindow(nowMs);
  const past: number[] = [];
  for (let i = lookback; i >= 1; i -= 1) past.push(current - i * FIVE_MIN_S);
  const upcoming: number[] = [];
  for (let i = 1; i <= lookahead; i += 1) upcoming.push(current + i * FIVE_MIN_S);
  return { current, past, upcoming };
}

export function planWindowSlugs(
  nowMs: number,
  options?: { lookbackWindows?: number; lookaheadWindows?: number }
): string[] {
  const plan = planWindows(nowMs, options);
  return [...plan.past, plan.current, ...plan.upcoming].map(slugForWindow);
}
