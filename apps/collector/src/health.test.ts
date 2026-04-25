import { describe, it, expect } from 'vitest';
import { createHealthMetrics } from './health.js';

describe('health metrics', () => {
  it('records raw + normalized counts per source and exposes them in snapshot', () => {
    const m = createHealthMetrics(1000);
    m.recordRawEvent('clob', 2000);
    m.recordRawEvent('clob', 3000);
    m.recordRawEvent('rtds.binance', 2500);
    m.recordNormalized('clob');
    m.setMarketsDiscovered(3);
    m.setActiveSubscriptions(6);
    m.setClobConnected(true);
    m.setRtdsStatus('connected');

    const snap = m.snapshot(5000);
    expect(snap.uptimeSec).toBe(4);
    expect(snap.marketsDiscovered).toBe(3);
    expect(snap.activeSubscriptions).toBe(6);
    expect(snap.clobConnected).toBe(true);
    expect(snap.rtdsStatus).toBe('connected');
    expect(snap.sources['clob']).toEqual({
      rawEvents: 2,
      normalizedRows: 1,
      lastEventAtMs: 3000,
    });
    expect(snap.sources['rtds.binance']).toEqual({
      rawEvents: 1,
      normalizedRows: 0,
      lastEventAtMs: 2500,
    });
  });

  it('snapshot is a deep copy: mutating it does not change later snapshots', () => {
    const m = createHealthMetrics(0);
    m.recordRawEvent('clob', 1000);
    const snap = m.snapshot(2000);
    snap.sources['clob']!.rawEvents = 999;
    const snap2 = m.snapshot(2000);
    expect(snap2.sources['clob']!.rawEvents).toBe(1);
  });

  it('uptimeSec is clamped to 0 if nowMs precedes start', () => {
    const m = createHealthMetrics(10_000);
    expect(m.snapshot(0).uptimeSec).toBe(0);
  });
});
