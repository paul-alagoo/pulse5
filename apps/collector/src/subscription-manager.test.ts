import { describe, it, expect } from 'vitest';
import { createClobSubscriptionRegistry } from './subscription-manager.js';

describe('clob subscription registry', () => {
  it('returns the new tokens to subscribe on first add', () => {
    const r = createClobSubscriptionRegistry();
    expect(r.add('mkt-1', 'tok-up', 'tok-down')).toEqual(['tok-up', 'tok-down']);
    expect(r.size()).toBe(1);
  });

  it('returns no new tokens on re-add of an existing market', () => {
    const r = createClobSubscriptionRegistry();
    r.add('mkt-1', 'tok-up', 'tok-down');
    expect(r.add('mkt-1', 'tok-up', 'tok-down')).toEqual([]);
  });

  it('marketIdForToken resolves both up and down tokens', () => {
    const r = createClobSubscriptionRegistry();
    r.add('mkt-1', 'tok-up', 'tok-down');
    expect(r.marketIdForToken('tok-up')).toBe('mkt-1');
    expect(r.marketIdForToken('tok-down')).toBe('mkt-1');
    expect(r.marketIdForToken('unknown')).toBeNull();
  });

  it('remove unsubscribes both tokens and frees the mapping', () => {
    const r = createClobSubscriptionRegistry();
    r.add('mkt-1', 'tok-up', 'tok-down');
    expect(r.remove('mkt-1')).toEqual(['tok-up', 'tok-down']);
    expect(r.marketIdForToken('tok-up')).toBeNull();
    expect(r.size()).toBe(0);
  });

  it('remove returns [] for a market that was never added', () => {
    expect(createClobSubscriptionRegistry().remove('absent')).toEqual([]);
  });

  it('list enumerates active (marketId, tokenId) pairs', () => {
    const r = createClobSubscriptionRegistry();
    r.add('mkt-1', 'a', 'b');
    r.add('mkt-2', 'c', 'd');
    const list = r.list();
    expect(list).toHaveLength(4);
    expect(list).toContainEqual({ marketId: 'mkt-1', tokenId: 'a' });
    expect(list).toContainEqual({ marketId: 'mkt-2', tokenId: 'd' });
  });
});
