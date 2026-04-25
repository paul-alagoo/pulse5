// Collector health metrics + periodic logger.

export interface SourceMetrics {
  rawEvents: number;
  normalizedRows: number;
  /** Wall-clock timestamp (ms) of the last received event from the source. */
  lastEventAtMs: number | null;
}

export interface HealthMetricsSnapshot {
  uptimeSec: number;
  marketsDiscovered: number;
  activeSubscriptions: number;
  clobConnected: boolean;
  rtdsStatus: 'connecting' | 'connected' | 'disconnected';
  sources: Record<string, SourceMetrics>;
}

export interface HealthMetrics {
  recordRawEvent(source: string, atMs: number): void;
  recordNormalized(source: string): void;
  setMarketsDiscovered(n: number): void;
  setActiveSubscriptions(n: number): void;
  setClobConnected(connected: boolean): void;
  setRtdsStatus(status: 'connecting' | 'connected' | 'disconnected'): void;
  snapshot(nowMs: number): HealthMetricsSnapshot;
}

export function createHealthMetrics(startedAtMs: number): HealthMetrics {
  const sources: Record<string, SourceMetrics> = {};
  let marketsDiscovered = 0;
  let activeSubscriptions = 0;
  let clobConnected = false;
  let rtdsStatus: 'connecting' | 'connected' | 'disconnected' = 'disconnected';

  function ensure(source: string): SourceMetrics {
    let m = sources[source];
    if (!m) {
      m = { rawEvents: 0, normalizedRows: 0, lastEventAtMs: null };
      sources[source] = m;
    }
    return m;
  }

  return {
    recordRawEvent(source: string, atMs: number): void {
      const m = ensure(source);
      m.rawEvents += 1;
      m.lastEventAtMs = atMs;
    },
    recordNormalized(source: string): void {
      ensure(source).normalizedRows += 1;
    },
    setMarketsDiscovered(n: number): void {
      marketsDiscovered = n;
    },
    setActiveSubscriptions(n: number): void {
      activeSubscriptions = n;
    },
    setClobConnected(connected: boolean): void {
      clobConnected = connected;
    },
    setRtdsStatus(status: 'connecting' | 'connected' | 'disconnected'): void {
      rtdsStatus = status;
    },
    snapshot(nowMs: number): HealthMetricsSnapshot {
      // Deep-copy sources so callers can't mutate internal state.
      const sourcesCopy: Record<string, SourceMetrics> = {};
      for (const [k, v] of Object.entries(sources)) {
        sourcesCopy[k] = { ...v };
      }
      return {
        uptimeSec: Math.max(0, Math.floor((nowMs - startedAtMs) / 1000)),
        marketsDiscovered,
        activeSubscriptions,
        clobConnected,
        rtdsStatus,
        sources: sourcesCopy,
      };
    },
  };
}
