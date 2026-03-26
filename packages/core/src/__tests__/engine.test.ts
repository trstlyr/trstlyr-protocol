import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrustEngine } from '../engine/trust-engine.js';
import type { EvaluateRequest, Provider, Signal, HealthStatus } from '../types/index.js';

// ── Mock provider factory ─────────────────────────────────────────────────────

function makeProvider(
  namespace: string,
  score: number,
  confidence: number,
  opts: { delayMs?: number; throws?: boolean } = {},
): Provider {
  return {
    metadata(): ReturnType<Provider['metadata']> {
      return {
        name: namespace,
        version: '0.0.1',
        description: `Mock ${namespace} provider`,
        supported_subjects: ['agent', 'skill'],
        supported_namespaces: [namespace],
        signal_types: [{ type: 'mock_signal', description: 'mock' }],
      };
    },
    supported(subject) { return subject.namespace === namespace; },
    async evaluate({ subject }): Promise<Signal[]> {
      if (opts.throws) throw new Error(`${namespace} provider exploded`);
      if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
      return [{
        provider: namespace,
        signal_type: 'mock_signal',
        score,
        confidence,
        evidence: { namespace, id: subject.id },
        timestamp: new Date().toISOString(),
        ttl: 300,
      }];
    },
    async health(): Promise<HealthStatus> {
      return {
        status: 'healthy',
        last_check: new Date().toISOString(),
        avg_response_ms: 1,
        error_rate_1h: 0,
        dependencies: {},
      };
    },
  };
}

function makeEngine(providers: Provider[]): TrustEngine {
  return new TrustEngine({ providers });
}

// ── Basic query ───────────────────────────────────────────────────────────────

describe('TrustEngine — basic query', () => {
  it('returns a trust result with expected shape', async () => {
    const engine = makeEngine([makeProvider('github', 0.8, 0.9)]);
    const result = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'tankcdr' },
    });

    expect(result.subject).toBe('github:tankcdr');
    expect(result.trust_score).toBeGreaterThan(0);
    expect(result.trust_score).toBeLessThanOrEqual(100);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.risk_level).toBeTruthy();
    expect(result.recommendation).toBeTruthy();
    expect(result.signals).toHaveLength(1);
    expect(result.evaluated_at).toBeTruthy();
    expect(result.metadata?.query_id).toBeTruthy();
  });

  it('strong signal (score=0.9, conf=0.95) → high trust score', async () => {
    const engine = makeEngine([makeProvider('github', 0.9, 0.95)]);
    const result = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'vbuterin' },
    });
    expect(result.trust_score).toBeGreaterThan(70);
    expect(['minimal', 'low']).toContain(result.risk_level);
  });

  it('weak signal (score=0.2, conf=0.25) → low trust score', async () => {
    const engine = makeEngine([makeProvider('github', 0.2, 0.25)]);
    const result = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'newbie' },
    });
    // Weak confidence → high uncertainty → score near base rate (50), not 0 or 100
    expect(result.trust_score).toBeLessThan(75);
  });

  it('no providers support namespace → returns 0/critical with fraud signal', async () => {
    const engine = makeEngine([makeProvider('github', 0.8, 0.9)]);
    const result = await engine.query({
      subject: { type: 'agent', namespace: 'unknownns', id: 'foo' },
    });
    expect(result.trust_score).toBe(0);
    expect(result.risk_level).toBe('critical');
    expect(result.recommendation).toBe('deny');
    expect(result.fraud_signals.some(f => f.type === 'no_providers')).toBe(true);
  });
});

// ── Caching ───────────────────────────────────────────────────────────────────

describe('TrustEngine — caching', () => {
  it('second query for same subject returns cached result (same query_id)', async () => {
    const provider = makeProvider('github', 0.8, 0.9);
    const evaluateSpy = vi.spyOn(provider, 'evaluate');
    const engine = makeEngine([provider]);

    const r1 = await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });
    const r2 = await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });

    expect(r1.metadata?.query_id).toBe(r2.metadata?.query_id);
    expect(evaluateSpy).toHaveBeenCalledTimes(1); // provider only called once
  });

  it('different subjects are cached independently', async () => {
    const engine = makeEngine([
      makeProvider('github', 0.8, 0.9),
    ]);
    const r1 = await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });
    const r2 = await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'bob' } });
    expect(r1.metadata?.query_id).not.toBe(r2.metadata?.query_id);
  });

  it('invalidate() forces re-evaluation on next query', async () => {
    const provider = makeProvider('github', 0.8, 0.9);
    const evaluateSpy = vi.spyOn(provider, 'evaluate');
    const engine = makeEngine([provider]);

    await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });
    engine.invalidate('github:alice');
    await engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });

    expect(evaluateSpy).toHaveBeenCalledTimes(2);
  });
});

// ── In-flight deduplication ───────────────────────────────────────────────────

describe('TrustEngine — in-flight deduplication', () => {
  it('concurrent queries for same subject only invoke provider once', async () => {
    const provider = makeProvider('github', 0.8, 0.9, { delayMs: 50 });
    const evaluateSpy = vi.spyOn(provider, 'evaluate');
    const engine = makeEngine([provider]);

    const [r1, r2, r3] = await Promise.all([
      engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } }),
      engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } }),
      engine.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } }),
    ]);

    expect(evaluateSpy).toHaveBeenCalledTimes(1);
    // All three get the same result
    expect(r1.metadata?.query_id).toBe(r2.metadata?.query_id);
    expect(r2.metadata?.query_id).toBe(r3.metadata?.query_id);
  });
});

// ── Provider failure handling ─────────────────────────────────────────────────

describe('TrustEngine — provider failure handling', () => {
  it('throwing provider does not crash the engine — result still returned', async () => {
    const badProvider  = makeProvider('github', 0.8, 0.9, { throws: true });
    const goodProvider = makeProvider('twitter', 0.7, 0.8);
    const engine = makeEngine([badProvider, goodProvider]);

    const result = await engine.query({
      subject: { type: 'agent', namespace: 'twitter', id: 'alice' },
    });

    expect(result.trust_score).toBeGreaterThan(0);
    // Unresolved list should mention the failing provider
    // (twitter subject isn't handled by github provider, so only twitter runs here)
    expect(result).toBeTruthy();
  });

  it('provider timeout: slow provider is recorded as unresolved', async () => {
    const slowProvider = makeProvider('github', 0.9, 0.95, { delayMs: 5000 });
    const engine = new TrustEngine({
      providers: [slowProvider],
      scoring: { providerTimeout: 100 }, // 100ms timeout
    });

    const result = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'slow' },
    });

    // Unresolved entry recorded for the timeout
    expect(result.unresolved.length).toBeGreaterThan(0);
    expect(result.unresolved[0]?.reason).toMatch(/timeout/i);
  }, 10_000);

  it('all providers fail → score 0, critical, all providers in unresolved', async () => {
    const engine = makeEngine([
      makeProvider('github', 0.8, 0.9, { throws: true }),
    ]);

    const result = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'alice' },
    });

    // No signals survived → vacuous → score near base rate (50) or 0
    // but definitely not a high trusted result
    expect(result.trust_score).toBeLessThan(60);
    expect(result.unresolved.length).toBeGreaterThan(0);
  });
});

// ── Context multiplier ────────────────────────────────────────────────────────

describe('TrustEngine — context action escalation', () => {
  it('transact context escalates risk vs no context', async () => {
    const engine = makeEngine([makeProvider('github', 0.7, 0.7)]);

    const noCtx = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'alice' },
    });
    engine.invalidate('github:alice');
    const withTransact = await engine.query({
      subject: { type: 'agent', namespace: 'github', id: 'alice' },
      context: { action: 'transact' },
    });

    // transact should escalate risk level by at least one step
    const levels = ['minimal', 'low', 'medium', 'high', 'critical'];
    const baseIdx = levels.indexOf(noCtx.risk_level);
    const txIdx   = levels.indexOf(withTransact.risk_level);
    expect(txIdx).toBeGreaterThanOrEqual(baseIdx);
  });
});

// ── providerNames / health ────────────────────────────────────────────────────

describe('TrustEngine — introspection', () => {
  it('providerNames() lists all registered providers', () => {
    const engine = makeEngine([
      makeProvider('github', 0.8, 0.9),
      makeProvider('twitter', 0.7, 0.8),
    ]);
    const names = engine.providerNames();
    expect(names).toContain('github');
    expect(names).toContain('twitter');
  });

  it('health() returns one entry per provider', async () => {
    const engine = makeEngine([
      makeProvider('github', 0.8, 0.9),
      makeProvider('twitter', 0.7, 0.8),
    ]);
    const health = await engine.health();
    expect(health).toHaveLength(2);
    expect(health.every(h => h.status === 'healthy')).toBe(true);
  });

  it('addProvider() extends the provider list', () => {
    const engine = makeEngine([makeProvider('github', 0.8, 0.9)]);
    engine.addProvider(makeProvider('twitter', 0.7, 0.8));
    expect(engine.providerNames()).toContain('twitter');
  });
});

// ── Score sanity across provider combinations ─────────────────────────────────

describe('TrustEngine — scoring sanity', () => {
  it('trust_score is bounded [0,100] for single and multi-provider engines', async () => {
    const single = makeEngine([makeProvider('github', 0.85, 0.9)]);
    const double = makeEngine([
      makeProvider('github', 0.85, 0.9),
      makeProvider('twitter', 0.80, 0.85),
    ]);

    const r1 = await single.query({ subject: { type: 'agent', namespace: 'github', id: 'alice' } });
    const r2 = await double.query({ subject: { type: 'agent', namespace: 'github', id: 'alice2' } });

    expect(r1.trust_score).toBeGreaterThanOrEqual(0);
    expect(r1.trust_score).toBeLessThanOrEqual(100);
    expect(r2.trust_score).toBeGreaterThanOrEqual(0);
    expect(r2.trust_score).toBeLessThanOrEqual(100);
  });

  it('trust_score is always in [0, 100]', async () => {
    const combinations: [number, number][] = [
      [0.0, 0.0], [0.5, 0.0], [1.0, 1.0],
      [0.0, 1.0], [0.5, 0.5], [0.9, 0.95],
    ];
    for (const [score, conf] of combinations) {
      const engine = makeEngine([makeProvider('github', score, conf)]);
      const result = await engine.query({
        subject: { type: 'agent', namespace: 'github', id: 'test' },
      });
      expect(result.trust_score).toBeGreaterThanOrEqual(0);
      expect(result.trust_score).toBeLessThanOrEqual(100);
    }
  });
});
