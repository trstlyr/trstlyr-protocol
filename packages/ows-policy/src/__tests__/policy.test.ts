import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TrustPolicy, TrustGateDeniedError } from '../index.js';

vi.mock('@trstlyr/sdk', () => ({
  score: vi.fn(),
  configure: vi.fn(),
}));

// Also mock the OWS import since it won't be available in test env
vi.mock('@open-wallet-standard/core', () => ({
  signTransaction: vi.fn(),
}));

import { score as mockScoreFn } from '@trstlyr/sdk';

const mockScore = mockScoreFn as ReturnType<typeof vi.fn>;

function makeTrustScore(trustScore: number, overrides: Record<string, unknown> = {}) {
  return {
    subject: 'github:test/repo',
    trust_score: trustScore,
    confidence: 0.8,
    uncertainty: 0.2,
    valid_until: '2026-01-01T00:00:00Z',
    score_interpretation: {
      summary: 'Test',
      signal_count: 1,
      signal_diversity: 1,
      sybil_resistance: 'medium',
    },
    risk_level: trustScore >= 60 ? 'low' : 'high',
    recommendation: trustScore >= 60 ? 'allow' : 'deny',
    entity_type: 'repo',
    recommendation_label: trustScore >= 60 ? 'Allow' : 'Deny',
    signals: [],
    fraud_signals: [],
    unresolved: [],
    evaluated_at: '2026-01-01T00:00:00Z',
    metadata: { query_id: 'q1' },
    ...overrides,
  };
}

describe('TrustPolicy.preflightCheck()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns allowed: true when score >= minScore', async () => {
    mockScore.mockResolvedValue(makeTrustScore(75));
    const policy = new TrustPolicy({ minScore: 60 });
    const result = await policy.preflightCheck('github:test/repo');

    expect(result.allowed).toBe(true);
    expect(result.score).toBe(75);
  });

  it('returns allowed: false when score < minScore', async () => {
    mockScore.mockResolvedValue(makeTrustScore(40));
    const policy = new TrustPolicy({ minScore: 60 });
    const result = await policy.preflightCheck('github:test/repo');

    expect(result.allowed).toBe(false);
    expect(result.score).toBe(40);
  });

  it('returns requiresLedger: true when score < requireLedgerBelow', async () => {
    mockScore.mockResolvedValue(makeTrustScore(30));
    const policy = new TrustPolicy({ minScore: 60, requireLedgerBelow: 40 });
    const result = await policy.preflightCheck('github:test/repo');

    expect(result.requiresLedger).toBe(true);
  });

  it('returns allowed: false on API error when failOpen is false', async () => {
    mockScore.mockRejectedValue(new Error('API unreachable'));
    const policy = new TrustPolicy({ minScore: 60, failOpen: false });

    await expect(policy.preflightCheck('github:test/repo')).rejects.toThrow('API unreachable');
  });

  it('returns allowed: true on API error when failOpen is true (default)', async () => {
    mockScore.mockRejectedValue(new Error('API unreachable'));
    const policy = new TrustPolicy({ minScore: 60 });
    const result = await policy.preflightCheck('github:test/repo');

    expect(result.allowed).toBe(true);
    expect(result.score).toBe(0);
    expect(result.requiresLedger).toBe(true);
  });
});

describe('TrustGateDeniedError', () => {
  it('has correct score and threshold in message', () => {
    const trustCheck = {
      subject: 'github:test/repo',
      score: 35,
      riskLevel: 'high',
      recommendation: 'deny',
      allowed: false,
      requiresLedger: true,
      attestationUrl: null,
    };

    const error = new TrustGateDeniedError(trustCheck, 60);

    expect(error.message).toContain('scored 35');
    expect(error.message).toContain('minimum: 60');
    expect(error.threshold).toBe(60);
    expect(error.trustCheck.score).toBe(35);
  });
});
