// Core types — aligned with SPEC.md §3 (Core Concepts) and §6 (Provider Interface)

// ─── Subject ──────────────────────────────────────────────────────────────────

export type SubjectType = 'agent' | 'skill' | 'interaction';

export interface Subject {
  type: SubjectType;
  namespace: string; // e.g. "github", "clawhub", "erc8004"
  id: string;        // e.g. "tankcdr", "author/skill", "eip155:8453:0x.../42"
}

// ─── Context ──────────────────────────────────────────────────────────────────

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type Action = 'install' | 'execute' | 'delegate' | 'transact' | 'review';

export interface Context {
  action?: Action;
  risk_level?: RiskLevel;
  permissions_requested?: string[];
  requester?: string;
}

// ─── Signal ───────────────────────────────────────────────────────────────────

export interface Signal {
  provider: string;
  signal_type: string;
  score: number;      // [0.0, 1.0] — normalized by provider (SPEC §7.2)
  confidence: number; // [0.0, 1.0] — 1 - uncertainty in Subjective Logic terms
  evidence: Record<string, unknown>;
  timestamp: string;  // ISO 8601
  ttl?: number;       // seconds
}

// ─── Opinion (Subjective Logic — SPEC §7.1) ───────────────────────────────────

export interface Opinion {
  belief: number;      // b ∈ [0,1]
  disbelief: number;   // d ∈ [0,1]
  uncertainty: number; // u ∈ [0,1], b + d + u = 1
  baseRate: number;    // a ∈ [0,1], prior expectation
}

// ─── Trust Result ─────────────────────────────────────────────────────────────

export type RecommendationType = 'allow' | 'install' | 'review' | 'caution' | 'deny';

/** Semantic category of the evaluated subject — drives human-readable label selection. */
export type EntityType = 'agent' | 'repo' | 'skill' | 'developer' | 'unknown';
export type RiskLevelResult = 'minimal' | 'low' | 'medium' | 'high' | 'critical';

export interface FraudSignal {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  agents?: string[];
  evidence?: Record<string, unknown>;
  detected_at: string;
}

export interface ScoreInterpretation {
  summary: string;           // plain English e.g. "Reasonably trusted, good certainty"
  signal_count: number;      // how many signals contributed
  signal_diversity: number;  // unique contributing providers / 5 (total possible)
  sybil_resistance: 'low' | 'medium' | 'high';
}

export interface TrustResult {
  subject: string;           // Full Aegis subject identifier
  trust_score: number;       // Projected score: b + a×u
  confidence: number;        // 1 - uncertainty
  uncertainty: number;       // raw SL uncertainty (= 1 - confidence), 0-1
  valid_until: string;       // ISO 8601 — evaluated_at + min(signal ttl, default 3600s)
  score_interpretation: ScoreInterpretation;
  risk_level: RiskLevelResult;
  recommendation: RecommendationType;
  entity_type: EntityType;        // What kind of thing is being evaluated
  recommendation_label: string;   // Human-readable, entity-appropriate label
  signals: Signal[];
  fraud_signals: FraudSignal[];
  unresolved: Array<{ provider: string; reason: string }>;
  evaluated_at: string;
  metadata?: {
    attestation_uid?: string; // EAS attestation UID if anchored
    query_id: string;
  };
}

// ─── Provider Interface (SPEC §6.1) ───────────────────────────────────────────

export interface ProviderMetadata {
  name: string;
  version: string;
  description: string;
  supported_subjects: SubjectType[];
  supported_namespaces: string[];
  signal_types: Array<{ type: string; description: string }>;
  rate_limit?: { requests_per_minute: number; burst: number };
}

export interface HealthStatus {
  status: 'healthy' | 'degraded' | 'unhealthy';
  last_check: string;
  avg_response_ms: number;
  error_rate_1h: number;
  dependencies?: Record<string, 'healthy' | 'degraded' | 'unhealthy'>;
}

export interface EvaluateRequest {
  subject: Subject;
  context?: Context;
}

// Canonical provider interface — all four methods required (SPEC §6.1)
export interface Provider {
  metadata(): ProviderMetadata;
  evaluate(request: EvaluateRequest): Promise<Signal[]>;
  health(): Promise<HealthStatus>;       // SPEC §6.1
  supported(subject: Subject): boolean; // SPEC §6.1
}

// ─── Engine Config ────────────────────────────────────────────────────────────

export interface AegisConfig {
  providers?: Provider[];
  cache?: 'memory' | 'none';
  attestation?: {
    enabled: boolean;
    easSchemaUid?: string;
    rpcUrl?: string;
    privateKey?: string;
  };
  scoring?: {
    lambda?: number;         // Ev-Trust penalty weight (default: 0.15, SPEC §7.9)
    providerTimeout?: number; // ms (default: 10000)
  };
}
