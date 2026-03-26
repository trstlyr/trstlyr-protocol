import { score, configure } from '@trstlyr/sdk';
import type { ClientConfig } from '@trstlyr/sdk';
import { signTransaction } from '@open-wallet-standard/core';

// ── Types ──

export interface TrustPolicyConfig {
  /** Minimum trust score to allow signing. Default: 60 */
  minScore?: number;
  /** Score below which hardware wallet approval is flagged. Default: 40 */
  requireLedgerBelow?: number;
  /** Pass-through config to @trstlyr/sdk configure() */
  trstlyr?: ClientConfig;
  /** If true (default), allow signing when TrstLyr API is unreachable */
  failOpen?: boolean;
}

export interface CheckAndSignParams {
  wallet: string;
  chain: string;
  txHex: string;
  /** Who we are paying — e.g. "erc8004:31977" or "github:torvalds" */
  subject: string;
  passphrase?: string;
  index?: number;
  vaultPath?: string;
}

export interface TrustCheckResult {
  subject: string;
  score: number;
  riskLevel: string;
  recommendation: string;
  allowed: boolean;
  requiresLedger: boolean;
  attestationUrl: string | null;
}

export interface OWSSignResult {
  signature: string;
  recoveryId?: number;
  trustCheck: TrustCheckResult;
}

// ── Errors ──

export class TrustGateDeniedError extends Error {
  public readonly trustCheck: TrustCheckResult;
  public readonly threshold: number;

  constructor(trustCheck: TrustCheckResult, threshold: number) {
    super(
      `Trust gate denied: ${trustCheck.subject} scored ${trustCheck.score} (minimum: ${threshold}). Risk: ${trustCheck.riskLevel}, recommendation: ${trustCheck.recommendation}`,
    );
    this.name = 'TrustGateDeniedError';
    this.trustCheck = trustCheck;
    this.threshold = threshold;
  }
}

// ── TrustPolicy ──

export class TrustPolicy {
  private readonly minScore: number;
  private readonly requireLedgerBelow: number;
  private readonly failOpen: boolean;

  constructor(config: TrustPolicyConfig = {}) {
    this.minScore = config.minScore ?? 60;
    this.requireLedgerBelow = config.requireLedgerBelow ?? 40;
    this.failOpen = config.failOpen ?? true;

    if (config.trstlyr) {
      configure(config.trstlyr);
    }
  }

  /**
   * Check trust score for a subject, then sign via OWS if it passes.
   */
  async checkAndSign(params: CheckAndSignParams): Promise<OWSSignResult> {
    const trustCheck = await this.preflightCheck(params.subject);

    if (!trustCheck.allowed) {
      throw new TrustGateDeniedError(trustCheck, this.minScore);
    }

    const result = await signTransaction(
      params.wallet,
      params.chain,
      params.txHex,
      params.passphrase,
      params.index,
      params.vaultPath,
    );

    return {
      signature: result.signature,
      recoveryId: result.recoveryId,
      trustCheck,
    };
  }

  /**
   * Resolve subjects to on-chain addresses and build an OWS-compatible
   * allowlist policy JSON string containing only subjects that pass minScore.
   */
  async buildAllowlistPolicy(
    subjects: string[],
    policyId?: string,
  ): Promise<string> {
    const allowedAddresses: string[] = [];

    const results = await Promise.allSettled(
      subjects.map(async (subject) => {
        const trustScore = await score(subject);
        if (trustScore.trust_score >= this.minScore) {
          return {
            subject: trustScore.subject,
            address: trustScore.subject,
          };
        }
        return null;
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled' && result.value) {
        allowedAddresses.push(result.value.address);
      }
    }

    const policy = {
      id: policyId ?? 'trstlyr-trust-gate',
      name: 'TrstLyr Trust Gate',
      rules: [
        {
          type: 'allowlist',
          addresses: allowedAddresses,
        },
      ],
    };

    return JSON.stringify(policy);
  }

  /**
   * Run a trust check against a subject without signing.
   */
  async preflightCheck(subject: string): Promise<TrustCheckResult> {
    try {
      const trustScore = await score(subject);

      const allowed = trustScore.trust_score >= this.minScore;
      const requiresLedger = trustScore.trust_score < this.requireLedgerBelow;
      const attestationUid = trustScore.metadata?.attestation_uid ?? null;

      return {
        subject: trustScore.subject,
        score: trustScore.trust_score,
        riskLevel: trustScore.risk_level,
        recommendation: trustScore.recommendation,
        allowed,
        requiresLedger,
        attestationUrl: attestationUid
          ? `https://base.easscan.org/attestation/view/${attestationUid}`
          : null,
      };
    } catch (err) {
      if (this.failOpen) {
        console.warn(
          `[ows-policy] TrstLyr API unreachable for "${subject}", failing open`,
          err,
        );
        return {
          subject,
          score: 0,
          riskLevel: 'unknown',
          recommendation: 'review',
          allowed: true,
          requiresLedger: true,
          attestationUrl: null,
        };
      }
      throw err;
    }
  }
}
