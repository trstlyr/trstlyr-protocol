import { TTL, HTTP, FRAUD } from '../constants.js';
// TrustEngine — the embeddable trust engine (SPEC §4)
//
// Embedding example (OpenClaw, custom platform, etc.):
//   import { TrustEngine } from '@trstlyr/core';
//   const engine = new TrustEngine();
//   const result = await engine.query({
//     subject: { type: 'skill', namespace: 'github', id: 'author/skill' }
//   });

import type {
  TrstLyrConfig,
  EvaluateRequest,
  FraudSignal,
  Provider,
  Signal,
  TrustResult,
} from '../types/index.js';
import {
  GitHubProvider,
  TwitterProvider,
  ERC8004Provider,
  MoltbookProvider,
  ClawHubProvider,
  SelfProtocolProvider,
} from '../providers/index.js';
import { TrustCache } from './cache.js';
import { createEASWriter } from '../attestation/eas.js';
import type { EASWriter } from '../attestation/eas.js';
import { resolveIdentity } from '../identity/resolver.js';
import {
  applyContextMultiplier,
  evTrustAdjust,
  fuseOpinions,
  mapRecommendation,
  mapRiskLevel,
  projectScore,
  signalToOpinion,
  detectEntityType,
  recommendationLabel,
} from './scoring.js';

/**
 * Embeddable trust scoring engine — aggregates signals from registered providers,
 * fuses them via Subjective Logic + Ev-Trust, and optionally anchors results on-chain via EAS.
 */
export class TrustEngine {
  private readonly providers: Provider[];
  private readonly cache: TrustCache;
  private readonly providerTimeout: number;
  private readonly easWriter: EASWriter | null;
  private readonly attestationEnabled: boolean;
  /** In-flight queries — deduplicates simultaneous requests for the same subject */
  private readonly inFlight = new Map<string, Promise<TrustResult>>();

  /** @param config - Optional engine configuration (providers, cache, attestation, scoring params). */
  constructor(config: TrstLyrConfig = {}) {
    // Build default provider set based on available env vars
    // Explicit config.providers always wins; otherwise auto-detect from env
    this.providers =
      config.providers && config.providers.length > 0
        ? config.providers
        : buildDefaultProviders();

    this.cache = new TrustCache(TTL.DEFAULT);
    this.providerTimeout = config.scoring?.providerTimeout ?? HTTP.TIMEOUT_MS;

    // EAS attestation writer — optional, requires AEGIS_ATTESTATION_PRIVATE_KEY
    this.attestationEnabled = config.attestation?.enabled ?? false;
    this.easWriter = this.attestationEnabled
      ? createEASWriter()
      : null;
  }

  /**
   * Evaluate trust for a subject by dispatching to all eligible providers and fusing signals.
   * @param request - The subject and optional context to evaluate.
   * @returns Aggregated trust result with score, confidence, risk level, and signals.
   */
  async query(request: EvaluateRequest): Promise<TrustResult> {
    const { subject, context } = request;

    // ── Step 1: Identity resolution ────────────────────────────────────────────
    const subjectKey = `${subject.namespace}:${subject.id}`;

    // Check cache first
    const cached = this.cache.get(subjectKey);
    if (cached) return cached;

    // Deduplicate simultaneous in-flight queries for the same subject
    const existing = this.inFlight.get(subjectKey);
    if (existing) return existing;

    const promise = this._evaluate(request, subjectKey);
    this.inFlight.set(subjectKey, promise);
    promise.finally(() => this.inFlight.delete(subjectKey));
    return promise;
  }

  private async _evaluate(request: EvaluateRequest, subjectKey: string): Promise<TrustResult> {
    const { subject, context } = request;

    // Resolve to all linked identifiers via the identity graph
    const identity = await resolveIdentity(subject);
    const allSubjects = identity.all; // canonical + all linked

    // ── Step 2: Find eligible providers across ALL linked identifiers ──────────
    // Build a flat list of (provider, subject) pairs to dispatch
    type DispatchPair = { provider: Provider; subject: typeof subject };
    const dispatchPairs: DispatchPair[] = [];

    for (const subj of allSubjects) {
      // SubjectRef doesn't carry type — inherit from original or default to 'agent'
      const typedSubj = {
        type: subject.type,
        namespace: subj.namespace,
        id: subj.id,
      } satisfies typeof subject;

      for (const provider of this.providers) {
        if (provider.supported(typedSubj)) {
          dispatchPairs.push({ provider, subject: typedSubj });
        }
      }
    }

    if (dispatchPairs.length === 0) {
      const evaluatedAt = new Date();
      const result: TrustResult = {
        subject: subjectKey,
        trust_score: 0,
        confidence: 0,
        uncertainty: 1,
        valid_until: new Date(evaluatedAt.getTime() + 3600 * 1000).toISOString(),
        score_interpretation: {
          summary: 'Low trust, very low certainty — more signals needed',
          signal_count: 0,
          signal_diversity: 0,
          sybil_resistance: 'low',
        },
        risk_level: 'critical',
        recommendation: 'deny',
        entity_type: detectEntityType(subject.namespace, subject.id),
        recommendation_label: recommendationLabel('deny', detectEntityType(subject.namespace, subject.id)),
        signals: [],
        fraud_signals: [{
          type: 'no_providers',
          severity: 'critical',
          description: `No signal providers support namespace "${subject.namespace}"`,
          detected_at: evaluatedAt.toISOString(),
        }],
        unresolved: [{
          provider: 'none',
          reason: `No providers support namespace "${subject.namespace}"`,
        }],
        evaluated_at: evaluatedAt.toISOString(),
        metadata: { query_id: crypto.randomUUID() },
      };
      return result;
    }

    // ── Step 3: Signal dispatch (parallel fan-out across all subjects) ──────────
    const allSignals: Signal[] = [];
    const unresolved: Array<{ provider: string; reason: string }> = [];

    const providerResults = await Promise.allSettled(
      dispatchPairs.map(({ provider, subject: subj }) =>
        Promise.race([
          provider.evaluate({ subject: subj, context }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout after ${this.providerTimeout}ms`)),
              this.providerTimeout,
            ),
          ),
        ]).then((signals) => ({ provider, signals })),
      ),
    );

    for (let i = 0; i < providerResults.length; i++) {
      const outcome = providerResults[i]!;
      if (outcome.status === 'fulfilled') {
        allSignals.push(...outcome.value.signals);
      } else {
        const pair = dispatchPairs[i]!;
        unresolved.push({
          provider: pair.provider.metadata().name,
          reason: outcome.reason instanceof Error
            ? outcome.reason.message
            : String(outcome.reason),
        });
      }
    }

    // ── Step 4: Fraud detection (Phase 1 — lightweight heuristics) ────────────
    const fraudSignals: FraudSignal[] = [];
    const now = new Date().toISOString();

    if (allSignals.length === 0) {
      fraudSignals.push({
        type: 'no_signals',
        severity: 'high',
        description: 'No signals could be collected for this subject',
        detected_at: now,
      });
    }

    for (const signal of allSignals) {
      if (signal.score < FRAUD.LOW_SCORE && signal.confidence > FRAUD.HIGH_CONFIDENCE) {
        fraudSignals.push({
          type: 'low_trust_signal',
          severity: 'medium',
          description: `Provider "${signal.provider}" returned very low trust (${signal.score.toFixed(2)}) with high confidence (${signal.confidence.toFixed(2)}) — signal: ${signal.signal_type}`,
          evidence: { signal_type: signal.signal_type, score: signal.score, confidence: signal.confidence },
          detected_at: now,
        });
      }
    }

    // ── Step 5: Subjective Logic opinion fusion ────────────────────────────────
    const opinions = allSignals.map(signalToOpinion);
    const fusedOpinion = fuseOpinions(opinions);
    const rawScore = projectScore(fusedOpinion);

    // ── Step 6: Ev-Trust evolutionary stability adjustment (λ = 0.15) ──────────
    const adjustedScore = evTrustAdjust(rawScore, allSignals);

    // ── Step 7: Risk level mapping + context multiplier ────────────────────────
    let riskLevel = mapRiskLevel(adjustedScore);
    riskLevel = applyContextMultiplier(riskLevel, context?.action);
    const recommendation = mapRecommendation(riskLevel, adjustedScore);

    // Derive effective TTL from minimum signal TTL (default 300s)
    const ttl =
      allSignals.length > 0
        ? Math.min(...allSignals.map((s) => s.ttl ?? TTL.DEFAULT))
        : TTL.DEFAULT;

    const entityType = detectEntityType(subject.namespace, subject.id);

    const confidence = Math.round((1 - fusedOpinion.uncertainty) * 10_000) / 10_000;
    const uncertainty = Math.round(fusedOpinion.uncertainty * 10_000) / 10_000;
    const trustScore = Math.round(adjustedScore * 10_000) / 100; // 0-100 scale, 2 dp

    // valid_until: evaluated_at + min(signal TTL, default 3600s)
    const evaluatedAt = new Date();
    const minTtl = allSignals.length > 0
      ? Math.min(...allSignals.map((s) => s.ttl ?? 3600))
      : 3600;
    const validUntil = new Date(evaluatedAt.getTime() + minTtl * 1000).toISOString();

    // score_interpretation
    const scoreBucket =
      trustScore < 40 ? 'Low trust'
      : trustScore < 60 ? 'Moderate trust'
      : trustScore < 75 ? 'Reasonably trusted'
      : trustScore < 90 ? 'Trusted'
      : 'Highly trusted';
    const confBucket =
      confidence < 0.4 ? 'very low certainty — more signals needed'
      : confidence < 0.6 ? 'moderate certainty'
      : confidence < 0.8 ? 'good certainty'
      : 'high certainty';

    const contributingSignals = allSignals.filter((s) => s.confidence > 0.3);
    const uniqueProviders = new Set(contributingSignals.map((s) => s.provider));
    const signalDiversity = Math.round((uniqueProviders.size / 5) * 10_000) / 10_000;

    const hasOnChain = allSignals.some(
      (s) => s.provider === 'erc8004' || s.signal_type.includes('on_chain'),
    );
    const sybilResistance: 'low' | 'medium' | 'high' =
      hasOnChain ? 'high'
      : uniqueProviders.size >= 2 ? 'medium'
      : 'low';

    let result: TrustResult = {
      subject: subjectKey,
      trust_score: trustScore,
      confidence,
      uncertainty,
      valid_until: validUntil,
      score_interpretation: {
        summary: `${scoreBucket}, ${confBucket}`,
        signal_count: allSignals.length,
        signal_diversity: signalDiversity,
        sybil_resistance: sybilResistance,
      },
      risk_level: riskLevel,
      recommendation,
      entity_type: entityType,
      recommendation_label: recommendationLabel(recommendation, entityType),
      signals: allSignals,
      fraud_signals: fraudSignals,
      unresolved,
      evaluated_at: evaluatedAt.toISOString(),
      metadata: { query_id: crypto.randomUUID() },
    };

    // ── Step 7b: Optional EAS attestation anchoring ───────────────────────────
    if (this.easWriter && this.attestationEnabled) {
      try {
        const attestation = await this.easWriter.attest(result);
        result = {
          ...result,
          metadata: {
            ...result.metadata!,
            attestation_uid: attestation.uid,
          },
        };
      } catch (err) {
        // Attestation failure is non-fatal — log and continue
        console.warn('[trstlyr] EAS attestation failed:', err instanceof Error ? err.message : err);
      }
    }

    // Store in cache
    this.cache.set(subjectKey, result, ttl);

    return result;
  }

  /** Invalidate a cached result, forcing a fresh evaluation on next query. */
  invalidate(subjectKey: string): void {
    this.cache.invalidate(subjectKey);
  }

  /** Health check across all registered providers. */
  async health(): Promise<
    Array<{ provider: string; status: string; last_check: string }>
  > {
    return Promise.all(
      this.providers.map(async (p) => {
        try {
          const h = await p.health();
          return { provider: p.metadata().name, status: h.status, last_check: h.last_check };
        } catch {
          return {
            provider: p.metadata().name,
            status: 'unhealthy',
            last_check: new Date().toISOString(),
          };
        }
      }),
    );
  }

  /** Names of all registered providers. */
  providerNames(): string[] {
    return this.providers.map((p) => p.metadata().name);
  }

  /** Add a provider at runtime (e.g. behavioral provider after DB init). */
  addProvider(provider: Provider): void {
    this.providers.push(provider);
  }
}

// ─── Default provider factory ─────────────────────────────────────────────────

/**
 * Build the default provider set based on available environment variables.
 * GitHubProvider is always included (unauthenticated = 60 req/hr; token = 5k/hr).
 * TwitterProvider, MoltbookProvider, ERC8004Provider are optional — enabled when
 * their respective tokens are present in the environment.
 */
function buildDefaultProviders(): Provider[] {
  const providers: Provider[] = [
    new GitHubProvider(),   // always on — web2 author reputation + repo health
    new ERC8004Provider(),  // always on — web3 on-chain identity (Base Mainnet)
    new ClawHubProvider(),  // always on — skill marketplace adoption metrics
  ];

  if (process.env['TWITTER_BEARER_TOKEN']) {
    providers.push(new TwitterProvider());
  }

  if (process.env['MOLTBOOK_API_KEY']) {
    providers.push(new MoltbookProvider());
  }

  providers.push(new SelfProtocolProvider({})); // ZK proof-of-human (Celo Mainnet, no API key needed)

  return providers;
}
