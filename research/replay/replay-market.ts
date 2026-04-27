// Pulse5 v0.2 — minimal replay example.
//
// Walks ONE resolved BTC 5-minute Up/Down market end-to-end, using the
// same pure logic the live collector uses:
//
//   1. Load market metadata + the slices of book_snapshots / btc_ticks
//      visible at a target timestamp.
//   2. Call buildMarketState(...) — pure function in @pulse5/strategy.
//   3. Call generateSignal(state) — pure, deterministic.
//   4. After the underlying market resolves, call labelSignalOutcome(...).
//   5. Persist the resulting market_state + signal to v0.2 tables.
//
// This file is intentionally NOT a batch runner / dashboard / CLI tool —
// it is documentation that compiles. Wire it to a real Postgres URL
// via the same connection rules `pnpm db:migrate` uses
// (DATABASE_URL env / .env / `C:\postgres.json` JSON fallback) and run:
//
//     pnpm -r build
//     npx tsx research/replay/replay-market.ts <market_id>
//
// SAFETY: this script reads from Postgres and writes to the v0.2
// market_states / signals tables. It does NOT place orders, sign
// transactions, hold a wallet, or perform paper trading.

import { fileURLToPath } from 'node:url';
import { resolve as pathResolve } from 'node:path';
import {
  createDb,
  createMarketsRepository,
  createMarketStatesRepository,
  createSignalsRepository,
} from '@pulse5/storage';
import type { BookSnapshot, BtcTick } from '@pulse5/models';
import {
  DEFAULT_STRATEGY_CONFIG,
  buildMarketState,
  generateSignal,
  labelSignalOutcome,
} from '@pulse5/strategy';

interface ReplayInputs {
  marketId: string;
  /** When to score. For a typical replay: market.startTime + 30 s. */
  targetTimestamp: Date;
}

async function main(args: ReplayInputs): Promise<void> {
  const { db } = createDb();
  try {
    const markets = createMarketsRepository(db);
    const marketStates = createMarketStatesRepository(db);
    const signals = createSignalsRepository(db);

    const market = await markets.findById(args.marketId);
    if (!market) {
      throw new Error(`market not found: ${args.marketId}`);
    }

    // 1. Pull the latest receive_ts-visible inputs at the target timestamp.
    //    The "<= target" filter is the no-lookahead rule: replay must not
    //    use any row whose receive_ts is in the future of the timestamp it
    //    is scoring.
    const upBook = await latestBookByReceiveTs(db, args.marketId, market.upTokenId, args.targetTimestamp);
    const downBook = await latestBookByReceiveTs(
      db,
      args.marketId,
      market.downTokenId,
      args.targetTimestamp
    );
    const chainlinkTick = await latestTickByReceiveTs(db, 'rtds.chainlink', args.targetTimestamp);
    const binanceTick = await latestTickByReceiveTs(db, 'rtds.binance', args.targetTimestamp);
    const priceToBeatFallbackTick =
      market.priceToBeat === null
        ? await chainlinkTickNearestStartTime(
            db,
            market.startTime,
            DEFAULT_STRATEGY_CONFIG.priceToBeatToleranceMs,
            args.targetTimestamp
          )
        : null;

    // 2. Pure state construction.
    const state = buildMarketState(
      {
        market,
        upBook,
        downBook,
        chainlinkTick,
        binanceTick,
        priceToBeatFallbackTick,
        targetTimestamp: args.targetTimestamp,
      },
      DEFAULT_STRATEGY_CONFIG
    );

    // 3. Pure decision.
    const signal = generateSignal(state, DEFAULT_STRATEGY_CONFIG);

    // 4. Persist state, then signal pointing back at it.
    const stateId = await marketStates.insert(state);
    const signalId = await signals.insert({ ...signal, marketStateId: stateId });

    // 5. If the market is already resolved, label the outcome. The state
    //    builder and signal engine never touch markets.final_outcome /
    //    status — only this last step does.
    if (market.status === 'resolved') {
      // Replay determinism: pass `market.endTime` as the label clock so
      // re-runs of the same market produce identical `resolved_at`
      // values. The outcome-labeler's interface documents this exact
      // pattern ("`now()` in live, market end time in replay").
      const label = labelSignalOutcome({
        signal: { ...signal, id: signalId, marketStateId: stateId },
        rawFinalOutcome: market.finalOutcome,
        resolvedAt: market.endTime,
      });
      await signals.updateOutcome(signalId, label.outcome, label.finalOutcome, label.resolvedAt);
    }
  } finally {
    await db.end();
  }
}

// --- Local helpers -------------------------------------------------------
// These helpers are deliberately inlined here rather than added as repo-wide
// utilities; v0.2 keeps the persistence surface narrow on purpose.

async function latestBookByReceiveTs(
  db: ReturnType<typeof createDb>['db'],
  marketId: string,
  tokenId: string,
  target: Date
): Promise<BookSnapshot | null> {
  const result = await db.query<{
    ts: Date;
    receive_ts: Date;
    market_id: string;
    token_id: string;
    best_bid: string | null;
    best_ask: string | null;
    bid_size: string | null;
    ask_size: string | null;
    spread: string | null;
    raw_event_id: string | null;
  }>(
    `SELECT ts, receive_ts, market_id, token_id,
            best_bid, best_ask, bid_size, ask_size, spread,
            raw_event_id
       FROM book_snapshots
      WHERE market_id = $1 AND token_id = $2 AND receive_ts <= $3::timestamptz
      ORDER BY receive_ts DESC
      LIMIT 1`,
    [marketId, tokenId, target]
  );
  const row = result.rows[0];
  if (!row) return null;
  const num = (v: string | null): number | null => (v === null ? null : Number(v));
  return {
    ts: row.ts,
    receiveTs: row.receive_ts,
    marketId: row.market_id,
    tokenId: row.token_id,
    bestBid: num(row.best_bid),
    bestAsk: num(row.best_ask),
    bidSize: num(row.bid_size),
    askSize: num(row.ask_size),
    spread: num(row.spread),
    rawEventId: row.raw_event_id === null ? null : BigInt(row.raw_event_id),
  };
}

async function latestTickByReceiveTs(
  db: ReturnType<typeof createDb>['db'],
  source: 'rtds.chainlink' | 'rtds.binance',
  target: Date
): Promise<BtcTick | null> {
  const result = await db.query<{
    ts: Date;
    receive_ts: Date;
    source: string;
    symbol: string;
    price: string;
    latency_ms: number | null;
    raw_event_id: string | null;
  }>(
    `SELECT ts, receive_ts, source, symbol, price, latency_ms, raw_event_id
       FROM btc_ticks
      WHERE source = $1 AND receive_ts <= $2::timestamptz
      ORDER BY receive_ts DESC
      LIMIT 1`,
    [source, target]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    ts: row.ts,
    receiveTs: row.receive_ts,
    source: row.source,
    symbol: row.symbol,
    price: Number(row.price),
    latencyMs: row.latency_ms,
    rawEventId: row.raw_event_id === null ? null : BigInt(row.raw_event_id),
  };
}

async function chainlinkTickNearestStartTime(
  db: ReturnType<typeof createDb>['db'],
  startTime: Date,
  toleranceMs: number,
  target: Date
): Promise<BtcTick | null> {
  // "Nearest in either direction" is approximated by ORDER BY |ts -
  // startTime| LIMIT 1, restricted to ticks whose `receive_ts` is visible
  // at the replay target (`receive_ts <= target`). The visibility filter
  // is the no-lookahead rule: a Chainlink tick that *was emitted* near
  // `market.startTime` but *was received* after the replay target is in
  // the future relative to the moment we are scoring, so it must not be
  // used to derive `priceToBeat`. The TS-side proximity check below then
  // enforces the tolerance window; the state builder also re-checks ts
  // proximity, so this is triple-bounded (visibility, ORDER BY,
  // tolerance).
  const result = await db.query<{
    ts: Date;
    receive_ts: Date;
    source: string;
    symbol: string;
    price: string;
    latency_ms: number | null;
    raw_event_id: string | null;
  }>(
    `SELECT ts, receive_ts, source, symbol, price, latency_ms, raw_event_id
       FROM btc_ticks
      WHERE source = 'rtds.chainlink'
        AND receive_ts <= $2::timestamptz
      ORDER BY ABS(EXTRACT(EPOCH FROM (ts - $1::timestamptz)))
      LIMIT 1`,
    [startTime, target]
  );
  const row = result.rows[0];
  if (!row) return null;
  const proximityMs = Math.abs(row.ts.getTime() - startTime.getTime());
  if (proximityMs > toleranceMs) return null;
  return {
    ts: row.ts,
    receiveTs: row.receive_ts,
    source: row.source,
    symbol: row.symbol,
    price: Number(row.price),
    latencyMs: row.latency_ms,
    rawEventId: row.raw_event_id === null ? null : BigInt(row.raw_event_id),
  };
}

// CLI shim — only runs when executed directly. The collector's
// `isEntrypoint` utility handles the same platform-portable detection
// (Windows back/forward slashes, drive-letter case, .ts vs .js when
// running via `tsx` vs the compiled output). We inline the same logic
// here rather than reaching across into apps/collector.
function isDirectInvocation(): boolean {
  if (typeof process === 'undefined') return false;
  if (!Array.isArray(process.argv)) return false;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  let modulePath: string;
  try {
    modulePath = fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
  const a = pathResolve(modulePath);
  const b = pathResolve(argv1);
  if (process.platform === 'win32') {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

if (isDirectInvocation()) {
  const marketId = process.argv[2];
  const targetIso = process.argv[3];
  if (!marketId || !targetIso) {
    process.stderr.write(
      'usage: tsx research/replay/replay-market.ts <market_id> <target-iso-timestamp>\n'
    );
    process.exit(2);
  }
  main({ marketId, targetTimestamp: new Date(targetIso) }).catch((err: unknown) => {
    process.stderr.write(
      `[replay-market] failed: ${err instanceof Error ? err.message : String(err)}\n`
    );
    process.exit(1);
  });
}

export {
  main as replayMarket,
  chainlinkTickNearestStartTime as __testOnlyChainlinkTickNearestStartTime,
  latestBookByReceiveTs as __testOnlyLatestBookByReceiveTs,
  latestTickByReceiveTs as __testOnlyLatestTickByReceiveTs,
};
