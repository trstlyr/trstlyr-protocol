export { TrstLyrClient } from './client.js';
export type {
  ClientConfig,
  TrustScore,
  Attestation,
  BehavioralOpts,
  BehavioralResult,
  BehavioralHistory,
  BehavioralAttestation,
  BehavioralSummary,
  Signal,
  FraudSignal,
  ScoreInterpretation,
  RiskLevel,
  Recommendation,
  EntityType,
  X402PaymentDetails,
  X402PaymentRequirement,
} from './types.js';
export { TrstLyrError, TrustGateError, PaymentRequiredError } from './types.js';

import { TrstLyrClient } from './client.js';
import type { TrustScore, Attestation, BehavioralOpts, BehavioralResult, BehavioralHistory, ClientConfig } from './types.js';
import { TrustGateError } from './types.js';

// ── Singleton ──

let _client: TrstLyrClient | undefined;

/** Configure the default client. Call before using the functional API, or omit for defaults. */
export function configure(config: ClientConfig): void {
  _client = new TrstLyrClient(config);
}

function client(): TrstLyrClient {
  if (!_client) _client = new TrstLyrClient();
  return _client;
}

// ── Functional API ──

/**
 * Query trust score for a subject.
 * Throws on error — callers must distinguish 'score is 0' from 'API is down'.
 */
export async function score(subject: string): Promise<TrustScore> {
  return client().score(subject);
}

/** Anchor a trust attestation on-chain (EAS on Base). */
export async function attest(subject: string): Promise<Attestation> {
  return client().attest(subject);
}

/** Post a behavioral attestation after an interaction. */
export async function behavioral(opts: BehavioralOpts): Promise<BehavioralResult> {
  return client().behavioral(opts);
}

/** Get behavioral attestation history for a subject. */
export async function behaviorHistory(subject: string): Promise<BehavioralHistory> {
  return client().behaviorHistory(subject);
}

/** Returns true if the subject's trust score meets or exceeds the threshold. */
export async function isTrusted(subject: string, minScore = 60): Promise<boolean> {
  try {
    const result = await client().score(subject);
    return result.trust_score >= minScore;
  } catch (err) {
    // Fail closed: if we can't reach the API, do not assume trusted
    console.warn('[trstlyr] isTrusted() failed, returning false:', err);
    return false;
  }
}

export interface GateOptions {
  minScore?: number;
  /** If true, throw even when the API is unreachable. Default: false (fail open). */
  strictMode?: boolean;
}

/**
 * Gate — throws TrustGateError if the subject's trust score is below the threshold.
 * Fail-open by default: if the API is unreachable, the gate passes silently.
 */
export async function gate(subject: string, opts: GateOptions = {}): Promise<TrustScore> {
  const threshold = opts.minScore ?? 60;

  let result: TrustScore;
  try {
    result = await client().score(subject);
  } catch (err) {
    if (opts.strictMode) throw err;
    // Fail open: return a synthetic "unknown" result
    return {
      subject,
      trust_score: 0,
      confidence: 0,
      uncertainty: 1,
      valid_until: new Date().toISOString(),
      score_interpretation: { summary: 'API unreachable — fail open', signal_count: 0, signal_diversity: 0, sybil_resistance: 'low' },
      risk_level: 'medium',
      recommendation: 'review',
      entity_type: 'unknown',
      recommendation_label: 'Review — API unreachable',
      signals: [],
      fraud_signals: [],
      unresolved: [],
      evaluated_at: new Date().toISOString(),
    };
  }

  if (result.trust_score < threshold) {
    throw new TrustGateError(subject, result.trust_score, threshold);
  }

  return result;
}
