import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TrstLyrClient } from '../client.js';
import { TrstLyrError, PaymentRequiredError } from '../types.js';
import { gate } from '../index.js';
import { TrustGateError } from '../types.js';

function makeTrustScore(overrides: Record<string, unknown> = {}) {
  return {
    subject: 'github:test/repo',
    trust_score: 75,
    confidence: 0.8,
    uncertainty: 0.2,
    valid_until: '2026-01-01T00:00:00Z',
    score_interpretation: {
      summary: 'Good',
      signal_count: 2,
      signal_diversity: 2,
      sybil_resistance: 'medium' as const,
    },
    risk_level: 'low' as const,
    recommendation: 'allow' as const,
    entity_type: 'repo' as const,
    recommendation_label: 'Allow',
    signals: [],
    fraud_signals: [],
    unresolved: [],
    evaluated_at: '2026-01-01T00:00:00Z',
    metadata: { query_id: 'q1' },
    ...overrides,
  };
}

describe('TrstLyrClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('score() returns TrustScore on 200', async () => {
    const mockScore = makeTrustScore();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(mockScore),
      }),
    );

    const client = new TrstLyrClient({ baseUrl: 'http://localhost:3000' });
    const result = await client.score('github:test/repo');

    expect(result.trust_score).toBe(75);
    expect(result.subject).toBe('github:test/repo');
    expect(result.risk_level).toBe('low');
  });

  it('score() throws TrstLyrError on 500', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }),
    );

    const client = new TrstLyrClient({ baseUrl: 'http://localhost:3000' });

    await expect(client.score('github:test/repo')).rejects.toThrow(TrstLyrError);
    await expect(client.score('github:test/repo')).rejects.toMatchObject({
      status: 500,
    });
  });

  it('attest() throws PaymentRequiredError on 402 with structured payment details', async () => {
    const x402Payload = {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base',
          maxAmountRequired: '10000',
          resource: 'https://api.trstlyr.ai/v1/attest',
          description: 'On-chain attestation',
          mimeType: 'application/json',
          payTo: '0xabc123',
          maxTimeoutSeconds: 60,
          asset: '0xusdc',
        },
      ],
      error: 'Payment required for on-chain attestation',
    };

    const headerValue = Buffer.from(JSON.stringify(x402Payload)).toString('base64');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 402,
        headers: new Headers({ 'x-payment-required': headerValue }),
        text: () => Promise.resolve(''),
      }),
    );

    const client = new TrstLyrClient({ baseUrl: 'http://localhost:3000' });

    try {
      await client.attest('github:test/repo');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(PaymentRequiredError);
      const payErr = err as PaymentRequiredError;
      expect(payErr.status).toBe(402);
      expect(payErr.payment).not.toBeNull();
      expect(payErr.payment!.accepts).toHaveLength(1);
      expect(payErr.payment!.accepts[0]!.network).toBe('base');
      expect(payErr.payTo).toBe('0xabc123');
      expect(payErr.network).toBe('base');
    }
  });
});

describe('gate()', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // Reset the singleton client by importing fresh
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('throws TrustGateError when score < threshold', async () => {
    const lowScore = makeTrustScore({ trust_score: 30 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(lowScore),
      }),
    );

    await expect(gate('github:test/repo', { minScore: 60 })).rejects.toThrow(TrustGateError);
    try {
      await gate('github:test/repo', { minScore: 60 });
    } catch (err) {
      const gateErr = err as TrustGateError;
      expect(gateErr.trustScore).toBe(30);
      expect(gateErr.threshold).toBe(60);
    }
  });

  it('passes when score >= threshold', async () => {
    const highScore = makeTrustScore({ trust_score: 80 });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.resolve(highScore),
      }),
    );

    const result = await gate('github:test/repo', { minScore: 60 });
    expect(result.trust_score).toBe(80);
  });
});
