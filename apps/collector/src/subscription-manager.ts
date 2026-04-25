// Tracks which (market_id, token_id) pairs the CLOB WS is subscribed to,
// so we can:
//   1. Map raw token-id events back to a `market_id` for the
//      `raw_events.market_id` column without an extra DB lookup.
//   2. Skip re-subscribing the same token when discovery re-emits a
//      market we already have.
//   3. Unsubscribe when a market resolves (Phase 5 — the Pulse5 CLOB WS
//      client now sends `custom_feature_enabled: true`, so the server emits
//      `market_resolved` events that the collector can act on).
//
// Storage-layer notes:
//   - `market_id` is the database PK Pulse5 owns (from gamma).
//   - `token_id` is what the CLOB protocol calls `asset_id` and what
//     `book_snapshots.token_id` records.

export interface ActiveSubscription {
  marketId: string;
  tokenId: string;
}

export interface ClobSubscriptionRegistry {
  /**
   * Add subscriptions for the Up + Down tokens of a market. Returns the
   * tokens that were not already subscribed (caller forwards these to
   * the WS).
   */
  add(marketId: string, upTokenId: string, downTokenId: string): string[];
  remove(marketId: string): string[];
  /** Lookup the market_id for an incoming token event. */
  marketIdForToken(tokenId: string): string | null;
  size(): number;
  list(): ActiveSubscription[];
}

export function createClobSubscriptionRegistry(): ClobSubscriptionRegistry {
  // token_id → market_id
  const tokenToMarket = new Map<string, string>();
  // market_id → [up_token, down_token]
  const marketToTokens = new Map<string, [string, string]>();

  return {
    add(marketId: string, upTokenId: string, downTokenId: string): string[] {
      const newTokens: string[] = [];
      if (!tokenToMarket.has(upTokenId)) {
        tokenToMarket.set(upTokenId, marketId);
        newTokens.push(upTokenId);
      }
      if (!tokenToMarket.has(downTokenId)) {
        tokenToMarket.set(downTokenId, marketId);
        newTokens.push(downTokenId);
      }
      marketToTokens.set(marketId, [upTokenId, downTokenId]);
      return newTokens;
    },
    remove(marketId: string): string[] {
      const tokens = marketToTokens.get(marketId);
      if (!tokens) return [];
      marketToTokens.delete(marketId);
      const removed: string[] = [];
      for (const t of tokens) {
        if (tokenToMarket.get(t) === marketId) {
          tokenToMarket.delete(t);
          removed.push(t);
        }
      }
      return removed;
    },
    marketIdForToken(tokenId: string): string | null {
      return tokenToMarket.get(tokenId) ?? null;
    },
    size(): number {
      return marketToTokens.size;
    },
    list(): ActiveSubscription[] {
      const out: ActiveSubscription[] = [];
      for (const [marketId, tokens] of marketToTokens) {
        for (const tokenId of tokens) {
          out.push({ marketId, tokenId });
        }
      }
      return out;
    },
  };
}
