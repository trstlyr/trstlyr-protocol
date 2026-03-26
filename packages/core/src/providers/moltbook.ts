import { providerFetch, HttpError } from './http.js';
// Moltbook Provider — agent community reputation signals (SPEC §6)
//
// Moltbook is "the front page of the agent internet" — a social network for AI agents.
// Provides karma, follower count, activity, and verified status signals.
//
// Requires MOLTBOOK_API_KEY env var (format: moltbook_xxx).
// Degrades gracefully (empty signals) without a key.
// Apply for access: https://www.moltbook.com
//
// Subject formats accepted:
//   moltbook:agentname   — Moltbook agent username

import type {
  EvaluateRequest,
  HealthStatus,
  Provider,
  ProviderMetadata,
  Signal,
  Subject,
} from '../types/index.js';

const MOLTBOOK_API = 'https://www.moltbook.com/api/v1';

interface MoltbookProfile {
  name: string;
  karma: number;
  follower_count: number;
  following_count: number;
  is_claimed: boolean;
  is_active: boolean;
  created_at: string;
  post_count?: number;
  description?: string;
}

interface MoltbookProfileResponse {
  agent?: MoltbookProfile;
  error?: string;
}

export class MoltbookProvider implements Provider {
  private readonly apiKey: string | undefined;

  constructor(apiKey?: string) {
    this.apiKey = apiKey ?? process.env['MOLTBOOK_API_KEY'];
  }

  metadata(): ProviderMetadata {
    return {
      name: 'moltbook',
      version: '1.0.0',
      description: 'Moltbook agent community reputation: karma, followers, activity, verified status',
      supported_subjects: ['agent'],
      supported_namespaces: ['moltbook'],
      signal_types: [
        {
          type: 'community_reputation',
          description: 'Moltbook karma, follower count, claim status, and community activity',
        },
      ],
      rate_limit: { requests_per_minute: 60, burst: 10 },
    };
  }

  supported(subject: Subject): boolean {
    return subject.namespace === 'moltbook';
  }

  async evaluate(request: EvaluateRequest): Promise<Signal[]> {
    const { subject } = request;
    if (!this.supported(subject)) return [];

    // No API key = no signals, not an error
    if (!this.apiKey) return [];

    const agentName = subject.id;
    const timestamp = new Date().toISOString();

    try {
      const profile = await this.fetchProfile(agentName);

      // Score components
      const karmaScore     = Math.min(profile.karma / 500, 1.0) * 0.35;
      const followerScore  = Math.min(profile.follower_count / 100, 1.0) * 0.25;
      const claimedBonus   = profile.is_claimed ? 0.20 : 0.00;  // human has verified ownership
      const activeBonus    = profile.is_active  ? 0.10 : 0.00;

      // Account age
      const createdAt = new Date(profile.created_at);
      const ageDays   = (Date.now() - createdAt.getTime()) / 86_400_000;
      const ageScore  = Math.min(ageDays / 365, 1.0) * 0.10;

      const score = Math.min(karmaScore + followerScore + claimedBonus + activeBonus + ageScore, 1.0);

      // Confidence: higher karma = more observable signal
      const confidence = Math.min(0.50 + profile.karma / 1000, 0.90);

      return [{
        provider: 'moltbook',
        signal_type: 'community_reputation',
        score,
        confidence,
        evidence: {
          name: profile.name,
          karma: profile.karma,
          followers: profile.follower_count,
          following: profile.following_count,
          is_claimed: profile.is_claimed,
          is_active: profile.is_active,
          account_age_days: Math.round(ageDays),
          created_at: profile.created_at,
        },
        timestamp,
        ttl: 1800, // 30 min — karma changes frequently
      }];

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('404') || message.includes('not found')) return [];
      return [{
        provider: 'moltbook',
        signal_type: 'community_reputation',
        score: 0,
        confidence: 0.2,
        evidence: { error: message, agent: agentName },
        timestamp,
        ttl: 120,
      }];
    }
  }

  async health(): Promise<HealthStatus> {
    const lastCheck = new Date().toISOString();
    if (!this.apiKey) {
      return {
        status: 'unhealthy',
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 0,
        dependencies: { 'www.moltbook.com': 'unhealthy' },
      };
    }
    try {
      let status: 'healthy' | 'degraded' | 'unhealthy';
      try {
        await providerFetch(`${MOLTBOOK_API}/agents/me`, { bearerToken: this.apiKey! });
        status = 'healthy';
      } catch (e) {
        status = e instanceof HttpError && e.status === 429 ? 'degraded' : 'unhealthy';
      }
      return {
        status,
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 0,
        dependencies: { 'www.moltbook.com': status },
      };
    } catch (err: unknown) {
      console.warn(`[${"moltbook"}] health check failed:`, err instanceof Error ? err.message : err);
      return {
        status: 'unhealthy',
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 1,
        dependencies: { 'www.moltbook.com': 'unhealthy' },
      };
    }
  }

  private async fetchProfile(agentName: string): Promise<MoltbookProfile> {
    const url = `${MOLTBOOK_API}/agents/profile?name=${encodeURIComponent(agentName)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await globalThis.fetch(url, {
        headers: { Authorization: `Bearer ${this.apiKey!}` },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) throw new Error(`404: agent "${agentName}" not found on Moltbook`);
    if (res.status === 401) throw new Error('Moltbook API key invalid or expired');
    if (res.status === 429) throw new Error('Rate limited by Moltbook API');
    if (!res.ok) throw new Error(`Moltbook API error ${res.status}`);

    const body = await res.json() as MoltbookProfileResponse;
    if (body.error) throw new Error(body.error);
    if (!body.agent) throw new Error(`No profile data for "${agentName}"`);

    return body.agent;
  }
}
