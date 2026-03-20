import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrustCache } from '../engine/cache.js';
import type { TrustResult } from '../types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(subject: string, score = 80): TrustResult {
  return {
    subject,
    trust_score: score,
    confidence: 0.9,
    uncertainty: 0.1,
    valid_until: new Date(Date.now() + 300_000).toISOString(),
    score_interpretation: {
      summary: 'Test result',
      signal_count: 1,
      signal_diversity: 0.2,
      sybil_resistance: 'low',
    },
    risk_level: 'low',
    recommendation: 'install',
    entity_type: 'agent',
    recommendation_label: '✅ Well established',
    signals: [],
    fraud_signals: [],
    unresolved: [],
    evaluated_at: new Date().toISOString(),
    metadata: { query_id: 'test-qid' },
  };
}

// ── Basic get/set ─────────────────────────────────────────────────────────────

describe('TrustCache — basic operations', () => {
  let cache: TrustCache;
  beforeEach(() => { cache = new TrustCache(300); });

  it('returns null for unknown key', () => {
    expect(cache.get('github:nobody')).toBeNull();
  });

  it('stores and retrieves a result', () => {
    const result = makeResult('github:tankcdr');
    cache.set('github:tankcdr', result);
    expect(cache.get('github:tankcdr')).toEqual(result);
  });

  it('stores multiple independent keys', () => {
    cache.set('github:alice', makeResult('github:alice', 70));
    cache.set('github:bob',   makeResult('github:bob',   40));
    expect(cache.get('github:alice')?.trust_score).toBe(70);
    expect(cache.get('github:bob')?.trust_score).toBe(40);
  });

  it('overwrite: last write wins', () => {
    cache.set('k', makeResult('k', 50));
    cache.set('k', makeResult('k', 99));
    expect(cache.get('k')?.trust_score).toBe(99);
  });

  it('size() reflects stored entries', () => {
    expect(cache.size()).toBe(0);
    cache.set('a', makeResult('a'));
    cache.set('b', makeResult('b'));
    expect(cache.size()).toBe(2);
  });
});

// ── TTL / expiry ──────────────────────────────────────────────────────────────

describe('TrustCache — TTL and expiry', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('entry is live before TTL expires', () => {
    const cache = new TrustCache(60);
    cache.set('k', makeResult('k'));
    vi.advanceTimersByTime(59_000);
    expect(cache.get('k')).not.toBeNull();
  });

  it('entry is expired after TTL elapses', () => {
    const cache = new TrustCache(60);
    cache.set('k', makeResult('k'));
    vi.advanceTimersByTime(61_000);
    expect(cache.get('k')).toBeNull();
  });

  it('per-entry TTL override takes precedence over default', () => {
    const cache = new TrustCache(300); // 5-min default
    cache.set('short', makeResult('short'), 10); // 10s override
    vi.advanceTimersByTime(11_000);
    expect(cache.get('short')).toBeNull();
    // Default-TTL entry still live
    cache.set('long', makeResult('long')); // uses 300s default
    expect(cache.get('long')).not.toBeNull();
  });

  it('expired entries are not returned even if not explicitly evicted', () => {
    const cache = new TrustCache(1);
    cache.set('k', makeResult('k'));
    vi.advanceTimersByTime(2_000);
    // No evictExpired() called — expiry check happens in get()
    expect(cache.get('k')).toBeNull();
  });

  it('expired entry is removed from store after get()', () => {
    const cache = new TrustCache(1);
    cache.set('k', makeResult('k'));
    vi.advanceTimersByTime(2_000);
    cache.get('k'); // triggers lazy deletion
    expect(cache.size()).toBe(0);
  });
});

// ── Invalidation ──────────────────────────────────────────────────────────────

describe('TrustCache — invalidation', () => {
  it('invalidate() removes a specific key', () => {
    const cache = new TrustCache(300);
    cache.set('github:tankcdr', makeResult('github:tankcdr'));
    cache.set('github:vbuterin', makeResult('github:vbuterin'));
    cache.invalidate('github:tankcdr');
    expect(cache.get('github:tankcdr')).toBeNull();
    expect(cache.get('github:vbuterin')).not.toBeNull(); // unaffected
  });

  it('invalidate() on non-existent key is a no-op', () => {
    const cache = new TrustCache(300);
    expect(() => cache.invalidate('github:nobody')).not.toThrow();
  });

  it('clear() removes all entries', () => {
    const cache = new TrustCache(300);
    cache.set('a', makeResult('a'));
    cache.set('b', makeResult('b'));
    cache.set('c', makeResult('c'));
    cache.clear();
    expect(cache.size()).toBe(0);
    expect(cache.get('a')).toBeNull();
  });
});

// ── evictExpired ──────────────────────────────────────────────────────────────

describe('TrustCache — evictExpired()', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('evicts expired entries and returns count', () => {
    const cache = new TrustCache(10);
    cache.set('x', makeResult('x'));
    cache.set('y', makeResult('y'));
    cache.set('z', makeResult('z'), 300); // long TTL

    vi.advanceTimersByTime(11_000);

    const evicted = cache.evictExpired();
    expect(evicted).toBe(2);
    expect(cache.size()).toBe(1); // 'z' survives
  });

  it('evictExpired() on empty cache returns 0', () => {
    const cache = new TrustCache(10);
    expect(cache.evictExpired()).toBe(0);
  });

  it('evictExpired() returns 0 when nothing has expired', () => {
    const cache = new TrustCache(300);
    cache.set('a', makeResult('a'));
    cache.set('b', makeResult('b'));
    vi.advanceTimersByTime(100);
    expect(cache.evictExpired()).toBe(0);
    expect(cache.size()).toBe(2);
  });
});

// ── Stale-score safety ────────────────────────────────────────────────────────

describe('TrustCache — stale-score safety', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('never serves an expired high-trust result as trusted', () => {
    const cache = new TrustCache(5); // 5s TTL — very short
    const highTrust = makeResult('github:scammer', 95);
    cache.set('github:scammer', highTrust);

    vi.advanceTimersByTime(6_000); // expired

    // Must return null, not the stale high-trust result
    expect(cache.get('github:scammer')).toBeNull();
  });

  it('fresh entry with trust_score 0 is still returned (not confused with null)', () => {
    const cache = new TrustCache(300);
    const zeroTrust = makeResult('erc8004:unknown', 0);
    cache.set('erc8004:unknown', zeroTrust);
    const hit = cache.get('erc8004:unknown');
    expect(hit).not.toBeNull();
    expect(hit?.trust_score).toBe(0);
  });
});
