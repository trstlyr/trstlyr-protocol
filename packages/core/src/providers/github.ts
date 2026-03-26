// GitHubProvider — Phase 1 built-in signal provider (SPEC §6, PROVIDERS.md)
//
// Evaluates agents and skills by namespace "github". Produces two signal types:
//   • author_reputation — GitHub user credibility (account age, followers, repos)
//   • repo_health       — Repository quality (stars, recency, issues, license)

import { providerFetch, providerFetchText, HttpError } from './http.js';
import { GITHUB, TTL } from '../constants.js';
import type {
  EvaluateRequest,
  HealthStatus,
  Provider,
  ProviderMetadata,
  Signal,
  Subject,
} from '../types/index.js';

// ─── GitHub REST API types (minimal) ─────────────────────────────────────────

interface GitHubUser {
  login: string;
  followers: number;
  public_repos: number;
  created_at: string;
  hireable: boolean | null;
  blog: string | null;
  twitter_username: string | null;
}

interface GitHubRepo {
  full_name: string;
  stargazers_count: number;
  forks_count: number;
  open_issues_count: number;
  pushed_at: string;
  license: { spdx_id: string } | null;
  description: string | null;
}

interface GitHubRateLimit {
  resources: {
    core: { limit: number; remaining: number; reset: number };
  };
}

interface GitHubCommit {
  sha: string;
}

interface GitHubContributor {
  login: string;
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class GitHubProvider implements Provider {
  private readonly token: string | undefined;
  private readonly baseUrl = 'https://api.github.com';

  constructor(token?: string) {
    this.token = token ?? process.env['GITHUB_TOKEN'];
  }

  metadata(): ProviderMetadata {
    return {
      name: 'github',
      version: '1.0.0',
      description: 'GitHub author reputation and repository health signals',
      supported_subjects: ['agent', 'skill'],
      supported_namespaces: ['github'],
      signal_types: [
        {
          type: 'author_reputation',
          description:
            'GitHub user credibility: account age, followers, public repos, contribution activity',
        },
        {
          type: 'repo_health',
          description:
            'Repository quality: stars, forks, recency, issue resolution ratio',
        },
      ],
      rate_limit: { requests_per_minute: 60, burst: 10 },
    };
  }

  supported(subject: Subject): boolean {
    return subject.namespace === 'github';
  }

  async evaluate(request: EvaluateRequest): Promise<Signal[]> {
    const { subject } = request;
    if (!this.supported(subject)) return [];

    // Parse id: "owner", "owner/repo", or "owner/repo#ref"
    const withoutRef = subject.id.split('#')[0] ?? subject.id;
    const parts = withoutRef.split('/');
    const owner = parts[0];
    const repo = parts[1]; // may be undefined

    if (!owner) return [];

    const signals: Signal[] = [];
    const timestamp = new Date().toISOString();

    // ── author_reputation ─────────────────────────────────────────────────────
    try {
      const user = await this.fetchUser(owner);
      const ageDays =
        (Date.now() - new Date(user.created_at).getTime()) / 86_400_000;

      const followerScore = Math.min(user.followers / GITHUB.AUTHOR.FOLLOWER_MAX, 1.0) * GITHUB.AUTHOR.FOLLOWER_WEIGHT;
      const repoScore = Math.min(user.public_repos / GITHUB.AUTHOR.REPO_MAX, 1.0) * GITHUB.AUTHOR.REPO_WEIGHT;
      const ageScore = Math.min(ageDays / GITHUB.AUTHOR.AGE_MAX_DAYS, 1.0) * GITHUB.AUTHOR.AGE_WEIGHT;
      const hireableBonus = user.hireable ? GITHUB.AUTHOR.HIREABLE_BONUS : 0.0;
      const blogBonus = user.blog ? GITHUB.AUTHOR.BLOG_BONUS : 0.0;
      const twitterBonus = user.twitter_username ? GITHUB.AUTHOR.TWITTER_BONUS : 0.0;

      const score = Math.min(
        followerScore + repoScore + ageScore + hireableBonus + blogBonus + twitterBonus,
        1.0,
      );
      const confidence = Math.min(0.5 + user.followers / 2000, 0.95);

      signals.push({
        provider: 'github',
        signal_type: 'author_reputation',
        score,
        confidence,
        evidence: {
          login: user.login,
          followers: user.followers,
          public_repos: user.public_repos,
          account_age_days: Math.round(ageDays),
          created_at: user.created_at,
          hireable: user.hireable,
          blog: user.blog,
          twitter_username: user.twitter_username,
        },
        timestamp,
        ttl: 3600,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // 404 → subject not found, silently skip
      if (!message.includes('404')) {
        signals.push({
          provider: 'github',
          signal_type: 'author_reputation',
          score: 0,
          confidence: 0.3,
          evidence: { error: message, owner },
          timestamp,
          ttl: 300,
        });
      }
    }

    // ── repo_health (only when id contains "/") ────────────────────────────────
    if (repo) {
      try {
        const since90d = new Date(Date.now() - 90 * 86_400_000).toISOString();

        // Fan out: base data + CI check + recent commits + contributors in parallel
        const [repoData, hasCI, recentCommits, contributors] = await Promise.all([
          this.fetchRepo(owner, repo),
          this.fetchHasCI(owner, repo),
          this.fetchRecentCommits(owner, repo, since90d),
          this.fetchContributorCount(owner, repo),
        ]);

        const daysSincePush =
          (Date.now() - new Date(repoData.pushed_at).getTime()) / 86_400_000;

        const starScore        = Math.min(repoData.stargazers_count / 1000, 1.0) * 0.20;
        const forkScore        = Math.min(repoData.forks_count / 200, 1.0)       * 0.10;
        const recencyScore     = Math.max(0, 1 - daysSincePush / 365)             * 0.20;
        const issuesRatio      =
          repoData.open_issues_count > 0
            ? Math.max(0, 1 - repoData.open_issues_count / (repoData.stargazers_count + 1)) * 0.10
            : 0.10;
        const licenseBonus     = repoData.license     ? 0.10 : 0.0;
        const descriptionBonus = repoData.description ? 0.05 : 0.0;
        const ciBonus          = hasCI                ? 0.10 : 0.0;
        const commitScore      = Math.min(recentCommits / 50, 1.0)  * 0.10;
        const contribScore     = Math.min(contributors / 10, 1.0)   * 0.05;

        const score = Math.min(
          starScore + forkScore + recencyScore + issuesRatio +
          licenseBonus + descriptionBonus + ciBonus + commitScore + contribScore,
          1.0,
        );
        const confidence = Math.min(0.4 + repoData.stargazers_count / 5000, 0.9);

        signals.push({
          provider: 'github',
          signal_type: 'repo_health',
          score,
          confidence,
          evidence: {
            full_name:         repoData.full_name,
            stars:             repoData.stargazers_count,
            forks:             repoData.forks_count,
            open_issues:       repoData.open_issues_count,
            pushed_at:         repoData.pushed_at,
            days_since_push:   Math.round(daysSincePush),
            license:           repoData.license?.spdx_id ?? null,
            has_description:   Boolean(repoData.description),
            has_ci:            hasCI,
            commits_last_90d:  recentCommits,
            contributor_count: contributors,
          },
          timestamp,
          ttl: 1800,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (!message.includes('404')) {
          signals.push({
            provider: 'github',
            signal_type: 'repo_health',
            score: 0,
            confidence: 0.3,
            evidence: { error: message, repo: `${owner}/${repo}` },
            timestamp,
            ttl: 300,
          });
        }
      }
    }

    return signals;
  }

  async health(): Promise<HealthStatus> {
    const lastCheck = new Date().toISOString();
    try {
      const data = await this.fetch<GitHubRateLimit>('/rate_limit');
      const { remaining } = data.resources.core;
      const status =
        remaining > 10 ? 'healthy' : remaining > 0 ? 'degraded' : 'unhealthy';
      return {
        status,
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 0,
        dependencies: { 'api.github.com': status },
      };
    } catch (err: unknown) {
      console.warn(`[${"github"}] health check failed:`, err instanceof Error ? err.message : err);
      return {
        status: 'unhealthy',
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 1,
        dependencies: { 'api.github.com': 'unhealthy' },
      };
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────────

  private async fetchUser(owner: string): Promise<GitHubUser> {
    return this.fetch<GitHubUser>(`/users/${encodeURIComponent(owner)}`);
  }

  private async fetchRepo(owner: string, repo: string): Promise<GitHubRepo> {
    return this.fetch<GitHubRepo>(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    );
  }

  /** Returns true if the repo has a .github/workflows directory (CI present). */
  private async fetchHasCI(owner: string, repo: string): Promise<boolean> {
    try {
      const res = await this.fetchRaw(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/.github/workflows`,
      );
      return res.ok;
    } catch (err) {
      console.warn('[trstlyr] fetchHasCI:', err);
      return false;
    }
  }

  /** Returns the number of commits since a given ISO date (capped at 100). */
  private async fetchRecentCommits(owner: string, repo: string, since: string): Promise<number> {
    try {
      const commits = await this.fetch<GitHubCommit[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits?since=${since}&per_page=100`,
      );
      return Array.isArray(commits) ? commits.length : 0;
    } catch (err) {
      console.warn('[trstlyr] fetchRecentCommits:', err);
      return 0;
    }
  }

  /** Returns the number of distinct contributors (capped at 30). */
  private async fetchContributorCount(owner: string, repo: string): Promise<number> {
    try {
      const contributors = await this.fetch<GitHubContributor[]>(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contributors?per_page=30&anon=false`,
      );
      return Array.isArray(contributors) ? contributors.length : 0;
    } catch (err) {
      console.warn('[trstlyr] fetchContributorCount:', err);
      return 0;
    }
  }

  private async fetchRaw(path: string): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'trstlyr-protocol/1.0',
    };
    if (this.token) headers['Authorization'] = `Bearer ${this.token}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      return await globalThis.fetch(`${this.baseUrl}${path}`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetch<T>(path: string): Promise<T> {
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'trstlyr-protocol/1.0',
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await globalThis.fetch(`${this.baseUrl}${path}`, { headers, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 404) {
      throw new Error(`404 Not Found: ${path}`);
    }
    if (res.status === 403 || res.status === 429) {
      const retryAfter = res.headers.get('Retry-After') ?? 'unknown';
      throw new Error(
        `Rate limited (${res.status}): retry after ${retryAfter}s`,
      );
    }
    if (!res.ok) {
      throw new Error(`GitHub API error ${res.status} for ${path}`);
    }

    return res.json() as Promise<T>;
  }
}
