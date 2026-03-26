// @trstlyr/core — public API

// ── Engine ───────────────────────────────────────────────────────────────────
export { TrustEngine, TrustCache } from './engine/index.js';
export {
  applyContextMultiplier,
  evTrustAdjust,
  fuseOpinions,
  fuseTwo,
  mapRecommendation,
  mapRiskLevel,
  projectScore,
  signalToOpinion,
  detectEntityType,
  recommendationLabel,
} from './engine/index.js';

// ── Providers ────────────────────────────────────────────────────────────────
export { GitHubProvider }   from './providers/index.js';
export { TwitterProvider }  from './providers/index.js';
export { ERC8004Provider }  from './providers/index.js';
export { MoltbookProvider } from './providers/index.js';
export { ClawHubProvider }  from './providers/index.js';
export { BehavioralProvider } from './providers/index.js';
export type { BehavioralRow, BehavioralFetcher } from './providers/index.js';

// ── Identity graph ───────────────────────────────────────────────────────────
export { identityGraph, IdentityGraph } from './identity/index.js';
export { issueChallenge, verifyChallenge, getChallenge, importChallenge } from './identity/index.js';
export { resolveIdentity, linkedNamespaces } from './identity/index.js';
export type {
  Challenge,
  ChallengeMethod,
  IdentityLink,
  ResolvedIdentity,
  SubjectRef,
  VerificationMethod,
  VerifyResult,
} from './identity/index.js';

// ── Attestation ──────────────────────────────────────────────────────────────
export { EASWriter, createEASWriter } from './attestation/eas.js';
export type { AttestationResult }     from './attestation/eas.js';
export { BehavioralEASWriter, createBehavioralEASWriter } from './attestation/behavioral-eas.js';
export type { BehavioralAttestationData, BehavioralAttestationResult } from './attestation/behavioral-eas.js';

// ── Types ────────────────────────────────────────────────────────────────────
export type {
  Action,
  TrstLyrConfig,
  AegisConfig,
  Context,
  EvaluateRequest,
  FraudSignal,
  HealthStatus,
  Opinion,
  Provider,
  ProviderMetadata,
  EntityType,
  RecommendationType,
  RiskLevel,
  RiskLevelResult,
  Signal,
  Subject,
  SubjectType,
  TrustResult,
} from './types/index.js';
