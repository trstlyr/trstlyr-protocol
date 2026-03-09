// Aegis HTTP API — Fastify adapter
// Implements the REST API defined in SPEC.md §5

import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { AegisEngine, identityGraph, issueChallenge, verifyChallenge, getChallenge, importChallenge } from '@aegis-protocol/core';
import type { Action, Subject } from '@aegis-protocol/core';
import type { FastifyReply } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { registerAttestRoutes } from './routes/attest.js';
import { registerDiscoverRoutes } from './routes/discover.js';
import { initDb, saveIdentityLink, loadIdentityLinks, dbStats, saveChallenge, deletePersistedChallenge, loadPendingChallenges, saveScoreHistory, loadScoreHistory } from './db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── EAS schema UID — env var takes priority, fall back to config file ─────────
let easSchemaUid: string | undefined;
easSchemaUid = process.env['AEGIS_EAS_SCHEMA_UID'];
if (!easSchemaUid) {
  try {
    // process.cwd() = repo root locally, /app in Docker — both work
    const cfg = JSON.parse(
      readFileSync(join(process.cwd(), 'config/base.json'), 'utf8'),
    ) as { schemaUid?: string };
    easSchemaUid = cfg.schemaUid;
  } catch {
    // config not present — schema UID unset
  }
}

// ── Engine ────────────────────────────────────────────────────────────────────
const engine = new AegisEngine();

// ── Server ────────────────────────────────────────────────────────────────────
// trustProxy: false — use raw socket IP for rate limiting.
// X-Forwarded-For is client-controlled and cannot be trusted without a verified proxy allowlist.
const server = Fastify({
  logger: process.env['NODE_ENV'] !== 'test',
  trustProxy: false,
});

// ── Rate limiting ─────────────────────────────────────────────────────────────
await server.register(rateLimit, {
  global: true,
  max: 60,               // 60 req/min per IP — baseline
  timeWindow: '1 minute',
  errorResponseBuilder: (_req, context) => ({
    error: 'Rate limit exceeded',
    limit: context.max,
    retry_after_seconds: Math.ceil(context.ttl / 1000),
  }),
});

// ── Security headers ──────────────────────────────────────────────────────────
server.addHook('onSend', (_req, reply, _payload, done) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  reply.header('Referrer-Policy', 'no-referrer');
  done();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
await server.register(cors, {
  origin: [
    'https://trstlyr.ai',
    'https://www.trstlyr.ai',
    /\.trstlyr\.ai$/,
    /^http:\/\/localhost(:\d+)?$/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Payment'],
  exposedHeaders: ['X-Payment-Required'],
});

// ── Request body types ────────────────────────────────────────────────────────
interface TrustQueryBody {
  subject: Subject;
  context?: { action?: Action };
}

// ── Routes ────────────────────────────────────────────────────────────────────

// POST /v1/trust/query — SPEC §5.1
server.post('/v1/trust/query', async (request, reply) => {
  const body = request.body as TrustQueryBody | undefined;
  const subject = body?.subject;
  if (!subject?.namespace || !subject?.id) {
    return reply.code(400).send({
      error: 'subject.namespace and subject.id are required',
      example: { subject: { type: 'agent', namespace: 'github', id: 'owner/repo' } },
    });
  }
  if (!validateSubjectParts(subject.namespace, subject.id, reply)) return;
  const result = await engine.query({ subject, context: body?.context });
  saveScoreHistory({
    subject: result.subject,
    trust_score: result.trust_score,
    confidence: result.confidence,
    risk_level: result.risk_level,
    recommendation: result.recommendation,
    signal_count: result.signals.length,
    query_id: result.metadata?.query_id ?? null,
    evaluated_at: result.evaluated_at,
  }).catch(() => {}); // fire-and-forget, non-fatal
  return reply.send(result);
});

// POST /v1/trust/batch — evaluate up to 20 subjects in one call
server.post('/v1/trust/batch', async (request, reply) => {
  const body = request.body as {
    subjects: Array<{ namespace: string; id: string }>;
    context?: { action?: Action };
  } | undefined;

  if (!Array.isArray(body?.subjects) || body.subjects.length === 0) {
    return reply.code(400).send({
      error: '"subjects" must be a non-empty array',
      example: {
        subjects: [
          { namespace: 'github', id: 'tankcdr' },
          { namespace: 'erc8004', id: '19077' },
        ],
      },
    });
  }

  if (body.subjects.length > 20) {
    return reply.code(400).send({ error: 'Maximum 20 subjects per batch request' });
  }
  for (const s of body.subjects) {
    if (!validateSubjectParts(s.namespace ?? '', s.id ?? '', reply)) return;
  }

  // Fan out in parallel with per-subject timeout — cache means repeated subjects are free
  const BATCH_SUBJECT_TIMEOUT_MS = 15_000;
  const results = await Promise.allSettled(
    body.subjects.map(subject => {
      const queryPromise = engine.query({ subject: { type: 'agent', ...subject }, context: body.context });
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('subject query timeout')), BATCH_SUBJECT_TIMEOUT_MS).unref(),
      );
      return Promise.race([queryPromise, timeoutPromise]);
    }),
  );

  return reply.send({
    results: results.map((r, i) =>
      r.status === 'fulfilled'
        ? r.value
        : {
            subject: `${body.subjects[i]!.namespace}:${body.subjects[i]!.id}`,
            error: r.reason instanceof Error ? r.reason.message : 'Query failed',
          },
    ),
    total: body.subjects.length,
    evaluated_at: new Date().toISOString(),
  });
});

// GET /v1/trust/score/:subject — SPEC §5.2 (cached lookup)
server.get<{ Params: { subject: string } }>(
  '/v1/trust/score/:subject',
  async (request, reply) => {
    const raw = decodeURIComponent(request.params.subject);
    if (!validateSubjectString(raw, reply)) return;
    const colonIdx = raw.indexOf(':');
    let namespace: string;
    let id: string;
    if (colonIdx > 0) {
      namespace = raw.slice(0, colonIdx);
      id = raw.slice(colonIdx + 1);
    } else {
      namespace = 'github';
      id = raw;
    }
    const result = await engine.query({
      subject: { type: 'agent', namespace, id },
    });
    saveScoreHistory({
      subject: result.subject,
      trust_score: result.trust_score,
      confidence: result.confidence,
      risk_level: result.risk_level,
      recommendation: result.recommendation,
      signal_count: result.signals.length,
      query_id: result.metadata?.query_id ?? null,
      evaluated_at: result.evaluated_at,
    }).catch(() => {});
    return reply.send(result);
  },
);

// GET /v1/trust/history/:subject — trust score over time
server.get<{ Params: { subject: string }; Querystring: { limit?: string } }>(
  '/v1/trust/history/:subject',
  async (request, reply) => {
    const raw     = decodeURIComponent(request.params.subject);
    if (!validateSubjectString(raw, reply)) return;
    const colonIdx = raw.indexOf(':');
    const namespace = colonIdx > 0 ? raw.slice(0, colonIdx) : 'github';
    const id        = colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;
    const subject   = `${namespace}:${id}`;
    const limit     = Math.min(parseInt(request.query.limit ?? '30', 10), 100);

    const history = await loadScoreHistory(subject, limit);

    return reply.send({
      subject,
      count: history.length,
      history: history.map(h => ({
        trust_score:    h.trust_score,
        confidence:     h.confidence,
        risk_level:     h.risk_level,
        recommendation: h.recommendation,
        signal_count:   h.signal_count,
        evaluated_at:   h.evaluated_at,
      })),
    });
  },
);

// XML escape helper — prevents XSS in SVG string templates
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Subject validation — prevent oversized inputs
const MAX_SUBJECT_LEN = 256;
const MAX_ID_LEN      = 200;

function validateSubjectString(raw: string, reply: FastifyReply): boolean {
  if (raw.length > MAX_SUBJECT_LEN) {
    reply.code(400).send({ error: `Subject exceeds maximum length of ${MAX_SUBJECT_LEN} characters` });
    return false;
  }
  return true;
}

function validateSubjectParts(namespace: string, id: string, reply: FastifyReply): boolean {
  if (id.length > MAX_ID_LEN) {
    reply.code(400).send({ error: `Subject id exceeds maximum length of ${MAX_ID_LEN} characters` });
    return false;
  }
  if (namespace.length > 32) {
    reply.code(400).send({ error: 'Subject namespace exceeds maximum length of 32 characters' });
    return false;
  }
  return true;
}

// GET /v1/trust/score/:subject/badge.svg — embeddable SVG trust badge
server.get<{ Params: { subject: string } }>(
  '/v1/trust/score/:subject/badge.svg',
  async (request, reply) => {
    const raw = decodeURIComponent(request.params.subject);
    const colonIdx = raw.indexOf(':');
    const namespace = colonIdx > 0 ? raw.slice(0, colonIdx) : 'github';
    const id        = colonIdx > 0 ? raw.slice(colonIdx + 1) : raw;

    const result = await engine.query({ subject: { type: 'agent', namespace, id } });

    const score = result.trust_score.toFixed(1);
    const color =
      result.risk_level === 'minimal' ? '#44cc11' :
      result.risk_level === 'low'     ? '#97ca00' :
      result.risk_level === 'medium'  ? '#dfb317' :
      result.risk_level === 'high'    ? '#e05d44' : '#c0392b';

    const label      = escapeXml('trstlyr');
    const value      = escapeXml(`${score}%`);
    const labelW     = 62;
    const valueW     = 46;
    const totalW     = labelW + valueW;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${label}: ${value}">
  <title>${label}: ${value}</title>
  <linearGradient id="s" x2="0" y2="100%">
    <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
    <stop offset="1" stop-opacity=".1"/>
  </linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="3" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${labelW}" height="20" fill="#555"/>
    <rect x="${labelW}" width="${valueW}" height="20" fill="${color}"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="110" transform="scale(.1)" textLength="10">
    <text aria-hidden="true" x="${labelW * 5}" y="150" fill="#010101" fill-opacity=".3" transform="scale(1)" textLength="${(labelW - 10) * 10}" lengthAdjust="spacing">${label}</text>
    <text x="${labelW * 5}" y="140" textLength="${(labelW - 10) * 10}" lengthAdjust="spacing">${label}</text>
    <text aria-hidden="true" x="${(labelW + valueW / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" textLength="${(valueW - 10) * 10}" lengthAdjust="spacing">${value}</text>
    <text x="${(labelW + valueW / 2) * 10}" y="140" textLength="${(valueW - 10) * 10}" lengthAdjust="spacing">${value}</text>
  </g>
</svg>`;

    return reply
      .header('Content-Type', 'image/svg+xml')
      .header('Cache-Control', 'public, max-age=300')
      .header('X-Content-Type-Options', 'nosniff')
      .send(svg);
  },
);

// GET /v1/providers — list registered providers and their live health
server.get('/v1/providers', async (_request, reply) => {
  const health = await engine.health();
  return reply.send({
    providers: health,
    total: health.length,
    evaluated_at: new Date().toISOString(),
  });
});

// GET /v1/identity/:namespace/:id/links — list all verified links for an identifier
server.get<{ Params: { namespace: string; id: string } }>(
  '/v1/identity/:namespace/:id/links',
  async (request, reply) => {
    const { namespace, id } = request.params;
    const subject = { namespace, id: decodeURIComponent(id) };
    const links = identityGraph.getLinked(subject);
    const all = identityGraph.resolveAll(subject);
    return reply.send({
      subject: `${namespace}:${id}`,
      link_count: links.length,
      linked_identifiers: all.map(s => `${s.namespace}:${s.id}`),
      links: links.map(l => ({
        from: `${l.from.namespace}:${l.from.id}`,
        to:   `${l.to.namespace}:${l.to.id}`,
        method: l.method,
        confidence: l.confidence,
        verified_at: l.verifiedAt,
        attestation_uid: l.attestationUid ?? null,
      })),
    });
  },
);

// POST /v1/identity/register — register an identity and get a verification challenge
// Tighter rate limit: 20/min — prevents challenge spam
// Method is auto-selected by namespace (twitter→tweet, github→gist, erc8004→wallet_signature)
// Optional link_to: link to an already-verified identity on success
server.post('/v1/identity/register', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = request.body as {
    subject?:  { namespace: string; id: string };
    link_to?:  { namespace: string; id: string };
  } | undefined;

  if (!body?.subject?.namespace || !body?.subject?.id) {
    return reply.code(400).send({
      error: '"subject" required: { namespace, id }',
      example: {
        subject: { namespace: 'twitter', id: 'myagent' },
        link_to: { namespace: 'github',  id: 'myagent' }, // optional
      },
    });
  }

  const challenge = issueChallenge(body.subject, body.link_to);

  // Persist so a restart doesn't invalidate in-flight verifications
  await saveChallenge({
    id:               challenge.id,
    subject_ns:       challenge.subject.namespace,
    subject_id:       challenge.subject.id,
    link_to_ns:       challenge.linkTo?.namespace ?? null,
    link_to_id:       challenge.linkTo?.id ?? null,
    method:           challenge.method,
    challenge_string: challenge.challengeString,
    instructions:     challenge.instructions,
    status:           'pending',
    created_at:       challenge.createdAt,
    expires_at:       challenge.expiresAt,
  });

  return reply.code(201).send({
    challenge_id:     challenge.id,
    challenge_string: challenge.challengeString,
    method:           challenge.method,
    instructions:     challenge.instructions,
    expires_at:       challenge.expiresAt,
  });
});

// POST /v1/identity/link — deprecated alias for /v1/identity/register
server.post('/v1/identity/link', async (request, reply) => {
  return reply.code(301).send({
    error:    'Deprecated — use POST /v1/identity/register',
    redirect: '/v1/identity/register',
  });
});

// POST /v1/identity/verify — submit proof for a pending challenge
server.post('/v1/identity/verify', async (request, reply) => {
  const body = request.body as {
    challenge_id?:      string;
    // Subject proof
    tweet_url?:         string;
    gist_url?:          string;
    signature?:         string;
    twitter_username?:  string; // legacy
    // link_to proof (required when challenge was issued with link_to)
    link_to_tweet_url?: string;
    link_to_gist_url?:  string;
    link_to_signature?: string;
  } | undefined;

  if (!body?.challenge_id) {
    return reply.code(400).send({ error: '"challenge_id" is required' });
  }

  const challenge = getChallenge(body.challenge_id);
  if (!challenge) {
    return reply.code(404).send({ error: 'Challenge not found or expired' });
  }

  const result = await verifyChallenge(body.challenge_id, {
    tweetUrl:        body.tweet_url,
    gistUrl:         body.gist_url,
    signature:       body.signature,
    twitterUsername: body.twitter_username,
    linkToTweetUrl:  body.link_to_tweet_url,
    linkToGistUrl:   body.link_to_gist_url,
    linkToSignature: body.link_to_signature,
  });

  if (!result.success) {
    return reply.code(422).send({ error: result.error });
  }

  // Remove from DB — challenge is consumed
  await deletePersistedChallenge(body.challenge_id);

  // Invalidate cache for both subjects so next query picks up new linked signals
  if (result.registered) engine.invalidate(result.registered);
  if (result.linked)     engine.invalidate(result.linked);

  // Persist to DB — survives restarts
  if (result.registered && result.method) {
    const [fromNs, ...fromIdParts] = result.registered.split(':');
    const fromId = fromIdParts.join(':');
    const now = new Date().toISOString();
    await saveIdentityLink({
      id:          `${result.registered}:${now}`,
      from_ns:     fromNs!,
      from_id:     fromId,
      to_ns:       fromNs!,
      to_id:       fromId,
      method:      result.method,
      confidence:  result.confidence ?? 0.8,
      evidence:    { challenge_id: body?.challenge_id },
      verified_at: now,
    });

    if (result.linked) {
      const [toNs, ...toIdParts] = result.linked.split(':');
      await saveIdentityLink({
        id:          `${result.registered}:${result.linked}:${now}`,
        from_ns:     fromNs!,
        from_id:     fromId,
        to_ns:       toNs!,
        to_id:       toIdParts.join(':'),
        method:      result.method,
        confidence:  result.confidence ?? 0.8,
        evidence:    { challenge_id: body?.challenge_id },
        verified_at: now,
      });
    }
  }

  const msg = result.linked
    ? `✅ ${result.registered} verified and linked to ${result.linked} (confidence: ${result.confidence})`
    : `✅ ${result.registered} verified (confidence: ${result.confidence})`;

  return reply.send({
    verified:    true,
    registered:  result.registered,
    linked:      result.linked ?? null,
    method:      result.method,
    confidence:  result.confidence,
    message:     msg,
  });
});

// ── x402 attestation routes ───────────────────────────────────────────────────
const BASE_URL = process.env['BASE_URL'] ?? 'https://api.trstlyr.ai';
await registerAttestRoutes(server, engine, BASE_URL);

// ── Discovery routes ──────────────────────────────────────────────────────────
await registerDiscoverRoutes(server, engine);

// POST /v1/trust/gate — pre-trade / pre-action trust check
// Returns machine-readable proceed: true/false with score + risk context.
// Threshold logic:
//   Default threshold: 65 (override via TRUST_GATE_DEFAULT_THRESHOLD env)
//   Action escalation:
//     transact  → threshold 65, ≥$1K → 70, ≥$10K → 75
//     delegate  → threshold 70
//     execute   → threshold 60
//     install   → threshold 55
//     review    → threshold 40
//   Risk shortcut: risk_level high/critical → reject regardless of score
server.post('/v1/trust/gate', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
  const body = request.body as {
    counterparty?: string;
    action?: string;
    amount_usd?: number;
  } | undefined;

  if (!body?.counterparty || typeof body.counterparty !== 'string') {
    return reply.code(400).send({
      error: '"counterparty" is required (e.g. "erc8004:42" or "github:tankcdr")',
    });
  }
  if (!validateSubjectString(body.counterparty, reply)) return;

  const action = (body.action ?? 'transact') as Action;
  const amountUsd = typeof body.amount_usd === 'number' ? body.amount_usd : null;

  // Determine threshold based on action + amount
  const DEFAULT_THRESHOLD = parseInt(process.env['TRUST_GATE_DEFAULT_THRESHOLD'] ?? '65', 10);
  const ACTION_THRESHOLDS: Record<string, number> = {
    transact: DEFAULT_THRESHOLD,
    delegate: 70,
    execute:  60,
    install:  55,
    review:   40,
  };
  let threshold = ACTION_THRESHOLDS[action] ?? DEFAULT_THRESHOLD;
  let contextEscalation: string | null = null;

  if (action === 'transact' && amountUsd !== null && amountUsd >= 10_000) {
    threshold = 75;
    contextEscalation = 'transact high-value (>=\$10K) -> threshold elevated to 75';
  } else if (action === 'transact' && amountUsd !== null && amountUsd >= 1_000) {
    threshold = 70;
    contextEscalation = 'transact mid-value (>=\$1K) -> threshold elevated to 70';
  }

  // Parse counterparty subject
  const colonIdx = body.counterparty.indexOf(':');
  const namespace = colonIdx > 0 ? body.counterparty.slice(0, colonIdx) : 'github';
  const id = colonIdx > 0 ? body.counterparty.slice(colonIdx + 1) : body.counterparty;

  const startMs = Date.now();
  const result = await engine.query({
    subject: { type: 'agent', namespace, id },
    context: { action },
  });
  const latencyMs = Date.now() - startMs;

  // Risk shortcut: always block on high/critical regardless of numeric score
  const highRisk = result.risk_level === 'high' || result.risk_level === 'critical';
  const proceed = !highRisk && result.trust_score >= threshold;

  return reply.send({
    proceed,
    counterparty: `${namespace}:${id}`,
    trust_score: result.trust_score,
    confidence: result.confidence,
    risk_level: result.risk_level,
    recommendation_label: result.recommendation,
    threshold_used: threshold,
    action,
    ...(contextEscalation ? { context_escalation: contextEscalation } : {}),
    ...(highRisk ? { block_reason: `risk_level "${result.risk_level}" is always blocked` } : {}),
    signals_used: result.signals.length,
    latency_ms: latencyMs,
    evaluated_at: result.evaluated_at,
  });
});

// POST /v1/audit/submit — SPEC §5.5 (Phase 2)
server.post('/v1/audit/submit', async (_request, reply) => {
  return reply.code(501).send({ error: 'Audit submissions — Phase 2' });
});

// POST /v1/attest/anchor — SPEC §9.4 (Phase 3)
server.post('/v1/attest/anchor', async (_request, reply) => {
  return reply.code(501).send({ error: 'EAS attestation anchoring — Phase 3' });
});

// GET /.well-known/agent.json — A2A Agent Card
server.get('/.well-known/agent.json', async (_request, reply) => {
  return reply
    .header('Content-Type', 'application/json')
    .header('Cache-Control', 'public, max-age=300')
    .send({
      name: 'Charon',
      description: 'TrstLyr Protocol — trust infrastructure for the agent internet. Evaluates AI agents, skills, and repos via multi-signal trust scoring (GitHub, ERC-8004, Twitter, ClawHub, Moltbook). Anchors results on-chain via EAS on Base Mainnet.',
      url: 'https://api.trstlyr.ai',
      version: '0.2.0',
      documentationUrl: 'https://trstlyr.ai',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['application/json'],
      defaultOutputModes: ['application/json'],
      skills: [
        { id: 'trust_query',       name: 'Trust Query',           description: 'Evaluate trust score for an agent, skill, or GitHub repo' },
        { id: 'trust_batch',       name: 'Batch Trust Query',     description: 'Evaluate up to 20 subjects in one call' },
        { id: 'identity_register', name: 'Identity Registration', description: 'Register and verify agent identities across namespaces' },
        { id: 'attest',            name: 'On-chain Attestation',  description: 'Anchor trust scores as EAS attestations on Base Mainnet' },
        { id: 'trust_gate',        name: 'Trust Gate',            description: 'Pre-trade / pre-action trust check — returns proceed:true/false with score, risk, and threshold context', tags: ['trading', 'risk', 'compliance'] },
        { id: 'discover',          name: 'Agent Discovery',       description: 'Find and rank agents by capability, protocol, and trust score across ERC-8004, A2A, MCP, ACP, ClawHub, Moltbook, and HOL.org', tags: ['discovery', 'search', 'registry'] },
        { id: 'discover',          name: 'Agent Discovery',       description: 'Search and filter agents by capability, protocol, and trust score', tags: ['discovery', 'search', 'registry'] },
      ],
      trstlyrScoreUrl: 'https://api.trstlyr.ai/v1/trust/score/erc8004:19077',
      trustGateEndpoint: 'https://api.trstlyr.ai/v1/trust/gate',
    });
});

// GET /skill.md — agent-readable skill manifest
server.get('/skill.md', async (_request, reply) => {
  try {
    // skill.md lives at the repo/project root; cwd = /app in Docker
    const skillPath = join(process.cwd(), 'skill.md');
    const content = readFileSync(skillPath, 'utf8');
    return reply
      .header('Content-Type', 'text/markdown; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300')
      .send(content);
  } catch {
    return reply.code(404).send({ error: 'skill.md not found' });
  }
});

// GET / — redirect to skill.md (agents and humans both start here)
server.get('/', async (_request, reply) => {
  return reply.redirect('/skill.md', 302);
});

// GET /health
server.get('/health', async () => {
  const providerHealth = await engine.health();
  return {
    status: 'ok',
    version: '0.2.0',
    providers: engine.providerNames(),
    provider_health: providerHealth,
    eas_schema_uid: easSchemaUid ?? null,
    x402: {
      attestation_price_usdc: '0.01',
      // Address is derived from AEGIS_ATTESTATION_PRIVATE_KEY at startup — same wallet for both
      attestation_enabled: process.env['ATTESTATION_ENABLED'] === 'true',
      network: 'Base Mainnet',
      ...await dbStats(),
    },
    uptime_seconds: process.uptime(),
  };
});

// ── Start ─────────────────────────────────────────────────────────────────────

const port = parseInt(process.env['PORT'] ?? '3000', 10);

// ── Startup: init DB then hydrate in-memory graph ─────────────────────────────
await initDb();

// Restore pending challenges into the in-memory store
const savedChallenges = await loadPendingChallenges();
for (const c of savedChallenges) {
  importChallenge({
    id:              c.id,
    subject:         { namespace: c.subject_ns, id: c.subject_id },
    linkTo:          c.link_to_ns && c.link_to_id ? { namespace: c.link_to_ns, id: c.link_to_id } : undefined,
    method:          c.method as 'tweet' | 'gist' | 'wallet_signature',
    challengeString: c.challenge_string,
    instructions:    c.instructions,
    createdAt:       c.created_at,
    expiresAt:       c.expires_at,
    status:          'pending',
  });
}
if (savedChallenges.length > 0) {
  console.log(`[db] Restored ${savedChallenges.length} pending challenge(s)`);
}

// Restore verified identity links into the in-memory graph
const savedLinks = await loadIdentityLinks();
for (const link of savedLinks) {
  identityGraph.addLink(
    { namespace: link.from_ns, id: link.from_id },
    { namespace: link.to_ns,   id: link.to_id   },
    link.method as 'tweet_challenge' | 'wallet_signature' | 'erc8004_services',
    link.evidence,
  );
}
if (savedLinks.length > 0) {
  console.log(`[db] Restored ${savedLinks.length} identity link(s)`);
}

server.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) {
    server.log.error(err);
    process.exit(1);
  }
  console.log(`
⛵ TrstLyr Protocol API v0.1.0
  → Trust engine: active (providers: ${engine.providerNames().join(', ')})
  → EAS schema:   ${easSchemaUid ?? '(not configured)'}
  → Listening on  http://0.0.0.0:${port}
`);
});
