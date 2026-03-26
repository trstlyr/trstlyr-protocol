// GET /v1/discover — protocol-agnostic agent discovery with live trust scoring
// x402 priced: 0.001 USDC per query, 3 free queries per IP per day

import type { FastifyInstance } from 'fastify';
import type { TrustEngine } from '@trstlyr/core';
import { listAgentIndex, countAgentIndex, type AgentIndexRow } from '../db.js';
import { getPaymentReceiver } from '../x402/payment.js';

// ─── HOL.org integration ───────────────────────────────────────────────────────
// HOL.org aggregates 72k+ agents across 14 registries.
// Currently returning 503 — wired up and ready for when they come back.

interface HolAgent {
  id: string;
  name: string;
  description?: string;
  protocols?: string[];
  capabilities?: string[];
  metadata?: Record<string, unknown>;
}

interface HolSearchHit {
  id: string;
  uaid?: string;
  name?: string;
  description?: string;
  registry?: string;
  capabilities?: unknown[];
  endpoints?: Record<string, string>;
  metadata?: Record<string, unknown>;
}

// Map HOL.org capabilities (numeric enum) to string tags
function holCapabilitiesToStrings(caps: unknown[]): string[] {
  // HOL.org capability enum: 0=text, 1=voice, 2=vision, 3=code, etc.
  const capMap: Record<number, string> = { 0: 'text', 1: 'voice', 2: 'vision', 3: 'code', 4: 'data', 5: 'web' };
  return caps
    .filter((c): c is number => typeof c === 'number')
    .map(c => capMap[c] ?? `cap_${c}`);
}

async function fetchHolAgents(q = 'agent', limit = 100, _offset = 0): Promise<HolAgent[]> {
  try {
    // GET /registry/api/v1/search — keyword search across all registries
    const url = `https://hol.org/registry/api/v1/search?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 50)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.warn(`[discover] HOL.org returned ${res.status} — skipping`);
      return [];
    }
    const data = await res.json() as { hits?: HolSearchHit[]; results?: HolSearchHit[] };
    const hits = data.hits ?? data.results ?? [];
    return hits.map(h => ({
      id: `hol:${h.uaid ?? h.id}`,
      name: h.name ?? h.id,
      description: h.description,
      protocols: h.endpoints ? Object.keys(h.endpoints).map(k => k.toLowerCase()) : [],
      capabilities: holCapabilitiesToStrings(Array.isArray(h.capabilities) ? h.capabilities : []),
      metadata: { registry: h.registry, uaid: h.uaid, endpoints: h.endpoints, ...h.metadata },
    }));
  } catch (err) {
    console.warn('[discover] HOL.org unreachable:', (err as Error).message);
    return [];
  }
}

// ─── Known fallback agents (real agents with real data) ───────────────────────
// Used when agent_index is empty AND HOL.org is down.
const FALLBACK_SUBJECTS = [
  { namespace: 'erc8004', id: '19077' },   // Charon — TrstLyr Protocol
  { namespace: 'moltbook', id: 'nyx' },
  { namespace: 'moltbook', id: 'erebus' },
  { namespace: 'github', id: 'tankcdr/aegis' },
  { namespace: 'clawhub', id: 'charon' },
];

// ─── x402 free-tier tracking (in-memory, per IP) ─────────────────────────────
// 3 free queries per IP per day — then require X-Payment.
// In production replace with DB-backed store (same pattern as attestation_free_tier).
const discoverFreeTier = new Map<string, { count: number; resetAt: number }>();
const FREE_LIMIT = 3;
const DAY_MS = 86_400_000;
const MAX_FREE_TIER_ENTRIES = 10_000;

function checkFreeQuota(ip: string): { allowed: boolean; remaining: number } {
  const now = Date.now();

  // Prune expired entries and cap Map size to prevent unbounded growth
  if (discoverFreeTier.size > MAX_FREE_TIER_ENTRIES) {
    for (const [key, val] of discoverFreeTier) {
      if (now > val.resetAt) discoverFreeTier.delete(key);
    }
    // If still over limit after pruning expired, delete oldest entries
    if (discoverFreeTier.size > MAX_FREE_TIER_ENTRIES) {
      const excess = discoverFreeTier.size - MAX_FREE_TIER_ENTRIES;
      let deleted = 0;
      for (const key of discoverFreeTier.keys()) {
        if (deleted >= excess) break;
        discoverFreeTier.delete(key);
        deleted++;
      }
    }
  }

  const entry = discoverFreeTier.get(ip);

  if (!entry || now > entry.resetAt) {
    discoverFreeTier.set(ip, { count: 1, resetAt: now + DAY_MS });
    return { allowed: true, remaining: FREE_LIMIT - 1 };
  }

  if (entry.count < FREE_LIMIT) {
    entry.count++;
    return { allowed: true, remaining: FREE_LIMIT - entry.count };
  }

  return { allowed: false, remaining: 0 };
}

// ─── Query params ─────────────────────────────────────────────────────────────

interface DiscoverQuery {
  q?: string;
  min_score?: string;
  max_score?: string;
  provider?: string;    // comma-separated
  capability?: string;  // comma-separated
  protocol?: string;    // comma-separated
  claimed?: string;
  min_confidence?: string;
  limit?: string;
  offset?: string;
  sort?: string;
}

// ─── Response types ───────────────────────────────────────────────────────────

interface ProviderSnapshots {
  moltbook?: { karma?: number; followers?: number; is_claimed?: boolean; is_active?: boolean; profile_url?: string };
  github?: { stars?: number; repos?: number; followers?: number; commit_frequency?: string };
  erc8004?: { registry_id?: string; owner_address?: string; services?: string[]; supported_trust?: string[] };
  clawhub?: { skill_count?: number; total_installs?: number; total_stars?: number };
  twitter?: { followers?: number; verified?: boolean };
  hol?: { source_registries?: string[]; agent_url?: string };
}

interface AgentSummary {
  id: string;
  name: string;
  description?: string;
  entity_type: string;
  trust_score: number;
  confidence: number;
  risk_level: string;
  recommendation: string;
  protocols: string[];
  capabilities: string[];
  claimed: boolean;
  providers: ProviderSnapshots;
  endpoints: {
    a2a_card?: string;
    mcp_server?: string;
    trust_score: string;
    trust_gate: string;
    badge_svg: string;
  };
  linked_identifiers: string[];
  last_updated: string;
}

// ─── Route registration ────────────────────────────────────────────────────────

export async function registerDiscoverRoutes(
  server: FastifyInstance,
  engine: TrustEngine,
): Promise<void> {

  server.get<{ Querystring: DiscoverQuery }>(
    '/v1/discover',
    {
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const startMs = Date.now();

      // ── x402 gate ────────────────────────────────────────────────────────────
      // 3 free queries per IP per day; after that, require X-Payment: 0.001 USDC
      const ip = (request.ip ?? '0.0.0.0').split(':').pop() ?? '0.0.0.0';
      const hasPayment = Boolean(request.headers['x-payment']);
      const { allowed, remaining } = checkFreeQuota(ip);

      if (!allowed && !hasPayment) {
        return reply
          .code(402)
          .header('X-Payment-Required', 'true')
          .header('X-Free-Queries-Remaining', '0')
          .send({
            error: 'Payment required — free tier exhausted (3 queries/day)',
            payment: {
              amount_usdc: '0.001',
              network: 'Base Mainnet',
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              payTo: getPaymentReceiver(),
              description: 'TrstLyr /discover — 0.001 USDC per query',
            },
          });
      }

      // ── Parse query params ────────────────────────────────────────────────────
      const q = request.query.q?.trim();
      const minScore = parseFloat(request.query.min_score ?? '0');
      const maxScore = parseFloat(request.query.max_score ?? '100');
      const minConfidence = parseFloat(request.query.min_confidence ?? '0');
      const providers = request.query.provider?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
      const capabilities = request.query.capability?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
      const protocols = request.query.protocol?.split(',').map(s => s.trim()).filter(Boolean) ?? [];
      const claimedFilter = request.query.claimed === 'true' ? true : request.query.claimed === 'false' ? false : undefined;
      const limit = Math.min(parseInt(request.query.limit ?? '20', 10), 100);
      const offset = parseInt(request.query.offset ?? '0', 10);
      const sort = request.query.sort ?? 'trust_score';

      // ── Pull from agent_index ─────────────────────────────────────────────────
      let indexRows: AgentIndexRow[] = [];
      let total = 0;
      let usingFallback = false;

      try {
        const [rows, count] = await Promise.all([
          listAgentIndex({ q, provider: providers, capability: capabilities, protocol: protocols, claimed: claimedFilter, limit: limit * 3, offset }),
          countAgentIndex({ q, provider: providers, capability: capabilities, protocol: protocols, claimed: claimedFilter }),
        ]);
        indexRows = rows;
        total = count;
      } catch {
        // DB unavailable — fall through to fallback
      }

      // ── HOL.org (primary external source when agent_index is small) ───────────
      // Wire up regardless of 503 — when they come back, we get 72k agents for free
      if (indexRows.length === 0) {
        const holAgents = await fetchHolAgents(q ?? 'agent', limit, offset);
        if (holAgents.length > 0) {
          indexRows = holAgents.map(a => ({
            id: a.id,
            name: a.name,
            description: a.description,
            entity_type: 'agent',
            protocols: a.protocols ?? [],
            capabilities: a.capabilities ?? [],
            claimed: false,
            provider_sources: ['hol'],
            last_indexed_at: new Date().toISOString(),
            metadata: a.metadata ?? {},
          }));
          total = holAgents.length;
        }
      }

      // ── Fallback: known agents ─────────────────────────────────────────────────
      if (indexRows.length === 0) {
        usingFallback = true;
        indexRows = FALLBACK_SUBJECTS.map(s => ({
          id: `${s.namespace}:${s.id}`,
          name: s.id,
          description: undefined,
          entity_type: 'agent',
          protocols: [s.namespace],
          capabilities: [],
          claimed: false,
          provider_sources: [s.namespace],
          last_indexed_at: new Date().toISOString(),
          metadata: {},
        }));
        total = indexRows.length;
      }

      // ── Fan out trust scoring in parallel ─────────────────────────────────────
      const scored = await Promise.allSettled(
        indexRows.map(async row => {
          const colonIdx = row.id.indexOf(':');
          const namespace = colonIdx > 0 ? row.id.slice(0, colonIdx) : 'github';
          const id = colonIdx > 0 ? row.id.slice(colonIdx + 1) : row.id;

          const result = await engine.query({ subject: { type: 'agent', namespace, id } });

          // Extract provider snapshots from signals
          const providerMap: ProviderSnapshots = {};
          for (const signal of result.signals) {
            const src = signal.provider ?? '';
            if (src.startsWith('moltbook') && !providerMap.moltbook) {
              providerMap.moltbook = {
                profile_url: `https://www.moltbook.com/u/${id}`,
              };
            }
            if (src.startsWith('github') && !providerMap.github) {
              providerMap.github = {};
            }
            if (src.startsWith('erc8004') && !providerMap.erc8004) {
              providerMap.erc8004 = { registry_id: namespace === 'erc8004' ? id : undefined };
            }
            if (src.startsWith('clawhub') && !providerMap.clawhub) {
              providerMap.clawhub = {};
            }
            if (src.startsWith('twitter') && !providerMap.twitter) {
              providerMap.twitter = {};
            }
          }

          const summary: AgentSummary = {
            id: row.id,
            name: result.subject?.toString() ?? row.name,
            description: row.description ?? undefined,
            entity_type: row.entity_type ?? 'agent',
            trust_score: result.trust_score,
            confidence: result.confidence,
            risk_level: result.risk_level,
            recommendation: result.recommendation,
            protocols: row.protocols ?? [namespace],
            capabilities: row.capabilities ?? [],
            claimed: row.claimed ?? false,
            providers: providerMap,
            endpoints: {
              trust_score: `https://api.trstlyr.ai/v1/trust/score/${encodeURIComponent(row.id)}`,
              trust_gate: 'https://api.trstlyr.ai/v1/trust/gate',
              badge_svg: `https://api.trstlyr.ai/v1/trust/score/${encodeURIComponent(row.id)}/badge.svg`,
            },
            linked_identifiers: [],
            last_updated: result.evaluated_at,
          };

          return summary;
        }),
      );

      // ── Collect fulfilled results ──────────────────────────────────────────────
      let agents: AgentSummary[] = scored
        .filter((r): r is PromiseFulfilledResult<AgentSummary> => r.status === 'fulfilled')
        .map(r => r.value);

      // ── Post-scoring filters ──────────────────────────────────────────────────
      agents = agents.filter(a =>
        a.trust_score >= minScore &&
        a.trust_score <= maxScore &&
        a.confidence >= minConfidence &&
        (claimedFilter === undefined || a.claimed === claimedFilter) &&
        (capabilities.length === 0 || capabilities.some(c => a.capabilities.includes(c))) &&
        (protocols.length === 0 || protocols.some(p => a.protocols.includes(p))) &&
        (q === undefined || a.name.toLowerCase().includes(q.toLowerCase()) || (a.description ?? '').toLowerCase().includes(q.toLowerCase()))
      );

      // ── Sort ─────────────────────────────────────────────────────────────────
      if (sort === 'confidence') {
        agents.sort((a, b) => b.confidence - a.confidence);
      } else if (sort === 'updated_at') {
        agents.sort((a, b) => new Date(b.last_updated).getTime() - new Date(a.last_updated).getTime());
      } else {
        // Default: trust_score desc
        agents.sort((a, b) => b.trust_score - a.trust_score);
      }

      // ── Paginate ──────────────────────────────────────────────────────────────
      const paginated = usingFallback ? agents.slice(offset, offset + limit) : agents.slice(0, limit);

      return reply
        .header('X-Free-Queries-Remaining', String(remaining))
        .send({
          agents: paginated,
          total: usingFallback ? agents.length : total,
          limit,
          offset,
          query_ms: Date.now() - startMs,
          evaluated_at: new Date().toISOString(),
          ...(usingFallback ? { note: 'agent_index empty — returning live-scored fallback agents' } : {}),
        });
    },
  );
}
