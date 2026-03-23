// POST /v1/attest/behavioral — submit a behavioral attestation
// GET  /v1/trust/behavior/:subject — query behavioral summary
//
// Spec: BEHAVIORAL_ATTESTATIONS.md

import type { FastifyInstance } from 'fastify';
import { createBehavioralEASWriter } from '@aegis-protocol/core';
import type { BehavioralAttestationData } from '@aegis-protocol/core';
import { checkAttestationGate, extractPayment } from '../x402/payment.js';
import {
  saveBehavioralAttestation,
  loadBehavioralAttestations,
  countRecentAttestations,
} from '../db.js';

const OUTCOME_LABELS: Record<number, string> = { 0: 'failed', 1: 'partial', 2: 'success' };
const VALID_INTERACTION_TYPES = ['delegation', 'trade', 'task', 'data_access', 'payment', 'other'];

export async function registerBehavioralRoutes(
  server: FastifyInstance,
  baseUrl: string,
): Promise<void> {
  // Lazy behavioral EAS writer
  let easWriter: ReturnType<typeof createBehavioralEASWriter> | null = null;
  const getWriter = () => {
    if (!easWriter) easWriter = createBehavioralEASWriter();
    return easWriter;
  };

  // ── POST /v1/attest/behavioral ──────────────────────────────────────────────
  server.post<{
    Body: {
      subject?: string;
      interactionType?: string;
      outcome?: number;
      rating?: number;
      evidenceURI?: string;
      interactionAt?: number;
      valueUSDC?: number;
    };
  }>(
    '/v1/attest/behavioral',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = request.body;
      if (!body) {
        return reply.code(400).send({ error: 'Request body is required' });
      }

      // Validate required fields
      const { subject, interactionType, outcome, rating, evidenceURI, interactionAt, valueUSDC } = body;

      if (!subject || typeof subject !== 'string') {
        return reply.code(400).send({ error: '"subject" is required (e.g. "erc8004:31977")' });
      }
      if (!interactionType || !VALID_INTERACTION_TYPES.includes(interactionType)) {
        return reply.code(400).send({
          error: `"interactionType" must be one of: ${VALID_INTERACTION_TYPES.join(', ')}`,
        });
      }
      if (outcome === undefined || outcome === null || ![0, 1, 2].includes(outcome)) {
        return reply.code(400).send({ error: '"outcome" must be 0 (failed), 1 (partial), or 2 (success)' });
      }
      if (!rating || rating < 1 || rating > 5 || !Number.isInteger(rating)) {
        return reply.code(400).send({ error: '"rating" must be an integer 1-5' });
      }
      if (!interactionAt || typeof interactionAt !== 'number') {
        return reply.code(400).send({ error: '"interactionAt" is required (unix timestamp)' });
      }

      // Derive attester from x402 payment proof (EIP-3009 `from` = payer wallet)
      let attester: string | undefined;
      try {
        const payment = extractPayment(request);
        attester = payment?.payload?.authorization?.from?.toLowerCase();
      } catch {
        // No valid payment header — fall through
      }
      if (!attester) {
        return reply.code(401).send({ error: 'Attester identity required — submit an x402 payment header (payer wallet is used as attester)' });
      }

      // No self-attestation
      if (subject === attester) {
        return reply.code(400).send({ error: 'Self-attestation is not allowed (subject must differ from attester)' });
      }

      // Rate limit: max 10 per attester per subject per 30 days
      const recentCount = await countRecentAttestations(attester, subject, 30);
      if (recentCount >= 10) {
        return reply.code(429).send({
          error: 'Rate limit: max 10 attestations per attester per subject per 30 days',
          current: recentCount,
        });
      }

      // x402 gate — first free per attester per month, then $0.01 USDC
      const resourceUrl = `${baseUrl}/v1/attest/behavioral`;
      const allowed = await checkAttestationGate(request, reply, attester, resourceUrl);
      if (!allowed) return; // 402 already sent

      // Write to EAS
      let attestationUid: string | null = null;
      let txHash: string | null = null;
      let easError: string | undefined;
      const writer = getWriter();
      const easWriterConfigured = writer !== null;
      if (!easWriterConfigured) {
        console.warn('[behavioral] EAS writer not configured — AEGIS_ATTESTATION_PRIVATE_KEY or AEGIS_BEHAVIORAL_SCHEMA_UID missing');
      }
      if (writer) {
        try {
          const data: BehavioralAttestationData = {
            subject,
            attester,
            interactionType,
            outcome,
            rating,
            evidenceURI: evidenceURI ?? '',
            interactionAt,
            valueUSDC: valueUSDC ?? 0,
            disputed: false,
          };
          const result = await writer.attest(data);
          attestationUid = result.uid;
          txHash = result.txHash;
        } catch (err) {
          console.warn('[behavioral] EAS write failed:', err instanceof Error ? err.message : err);
          easError = 'on-chain anchor failed — see server logs';
        }
      }

      // Save to Supabase
      await saveBehavioralAttestation({
        subject,
        attester,
        interaction_type: interactionType,
        outcome,
        rating,
        evidence_uri: evidenceURI ?? null,
        interaction_at: new Date(interactionAt * 1000).toISOString(),
        value_usdc: valueUSDC ?? 0,
        disputed: false,
        eas_uid: attestationUid,
        tx_hash: txHash,
      });

      return reply.code(201).send({
        attestationUID: attestationUid,
        txHash,
        subject,
        outcome: OUTCOME_LABELS[outcome] ?? outcome,
        baseUrl: attestationUid
          ? `https://base.easscan.org/attestation/view/${attestationUid}`
          : null,
        ...(easError ? { eas_error: easError } : {}),
        ...(!easWriterConfigured ? { eas_writer_configured: false } : {}),
      });
    },
  );

  // ── GET /v1/trust/behavior/:subject ─────────────────────────────────────────
  server.get<{ Params: { subject: string } }>(
    '/v1/trust/behavior/:subject',
    async (request, reply) => {
      const raw = decodeURIComponent(request.params.subject);
      if (raw.length > 256) {
        return reply.code(400).send({ error: 'Subject exceeds maximum length of 256 characters' });
      }

      const rows = await loadBehavioralAttestations(raw);
      const total = rows.length;

      if (total === 0) {
        return reply.send({
          subject: raw,
          behavioral_summary: {
            total_interactions: 0,
            success_rate: 0,
            avg_rating: 0,
            dispute_rate: 0,
          },
          behavioral_score: 0,
          attestations: [],
        });
      }

      const successes = rows.filter(r => r.outcome === 2).length;
      const disputed = rows.filter(r => r.disputed).length;
      const successRate = successes / total;
      const disputeRate = disputed / total;
      const avgRating = rows.reduce((sum, r) => sum + r.rating, 0) / total;

      // Compute behavioral score (same formula as provider)
      const successComponent = successRate * 0.50;
      const ratingComponent = ((avgRating - 1) / 4) * 0.35;
      const disputePenalty = disputeRate * 0.15;
      const behavioralScore = Math.min(Math.max(successComponent + ratingComponent - disputePenalty, 0), 1);

      return reply.send({
        subject: raw,
        behavioral_summary: {
          total_interactions: total,
          success_rate: Math.round(successRate * 10000) / 10000,
          avg_rating: Math.round(avgRating * 100) / 100,
          dispute_rate: Math.round(disputeRate * 10000) / 10000,
        },
        behavioral_score: Math.round(behavioralScore * 10000) / 10000,
        attestations: rows.map(r => ({
          id: r.id,
          attester: r.attester,
          interaction_type: r.interaction_type,
          outcome: OUTCOME_LABELS[r.outcome] ?? r.outcome,
          rating: r.rating,
          evidence_uri: r.evidence_uri ?? null,
          interaction_at: r.interaction_at,
          value_usdc: r.value_usdc,
          disputed: r.disputed,
          eas_uid: r.eas_uid ?? null,
          created_at: r.created_at,
        })),
      });
    },
  );
}
