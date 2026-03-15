// POST /v1/attest — query trust score and anchor as EAS attestation on Base Mainnet
//
// Pricing:
//   First attestation per subject → FREE
//   Subsequent                    → $0.01 USDC via x402 (Base Mainnet)
//
// The x402 gate handles the 402 response automatically.
// Clients that support x402 will retry with X-PAYMENT header after paying.

import type { FastifyInstance } from 'fastify';
import type { AegisEngine } from '@aegis-protocol/core';
import { createEASWriter } from '@aegis-protocol/core';
import { checkAttestationGate, extractPayment } from '../x402/payment.js';

interface AttestBody {
  subject?: string;
}

export async function registerAttestRoutes(
  server: FastifyInstance,
  engine: AegisEngine,
  baseUrl: string,
): Promise<void> {
  // Lazy EAS writer — created once, only if private key is set
  let easWriter: ReturnType<typeof createEASWriter> | null = null;
  const getWriter = () => {
    if (!easWriter) easWriter = createEASWriter();
    return easWriter;
  };

  // POST /v1/attest — 10 req/min (expensive: runs engine + writes EAS)
  server.post<{ Body: AttestBody }>('/v1/attest', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (request, reply) => {
    const subject = request.body?.subject;
    if (!subject || typeof subject !== 'string') {
      return reply.code(400).send({
        error: '"subject" is required',
        examples: ['github:tankcdr', 'erc8004:19077', 'clawhub:skill/weather'],
      });
    }

    const resourceUrl = `${baseUrl}/v1/attest`;

    // x402 gate — grants free first time, then requires $0.01 USDC
    const allowed = await checkAttestationGate(request, reply, subject, resourceUrl);
    if (!allowed) return; // 402 (or 400) already sent

    // Extract payment nonce for on-chain proof (if payment was made)
    let paymentProof: string | undefined;
    try {
      const payment = extractPayment(request);
      const nonce = payment?.payload?.authorization?.nonce;
      if (nonce) paymentProof = `0x${nonce.replace(/^0x/, '')}`;
    } catch {
      // Non-fatal — payment was already verified by the gate
    }

    // Parse subject into namespace + id
    const colonIdx = subject.indexOf(':');
    const namespace = colonIdx > 0 ? subject.slice(0, colonIdx) : 'github';
    const id = colonIdx > 0 ? subject.slice(colonIdx + 1) : subject;

    // Query the trust engine
    const result = await engine.query({ subject: { type: 'agent', namespace, id } });

    // Write EAS attestation — always write on this endpoint (that's the whole point)
    let attestationUid: string | null = null;
    const writer = getWriter();
    if (writer) {
      try {
        const attestation = await writer.attest(result, { paymentProof });
        attestationUid = attestation.uid;
      } catch (err) {
        // Non-fatal — return the trust result even if attestation fails
        console.warn('[attest] EAS write failed:', err instanceof Error ? err.message : err);
      }
    }

    return reply.send({
      subject: result.subject,
      trust_score: result.trust_score,
      confidence: result.confidence,
      risk_level: result.risk_level,
      recommendation: result.recommendation,
      attestation_uid: attestationUid,
      attestation_url: attestationUid
        ? `https://base.easscan.org/attestation/view/${attestationUid}`
        : null,
      on_chain: attestationUid !== null,
      signals_used: result.signals.length,
      query_id: result.metadata?.query_id ?? null,
      computed_at: result.evaluated_at,
      payment: attestationUid
        ? { amount_usdc: '0.01', token: 'USDC', network: 'Base Mainnet' }
        : { free_tier: true },
    });
  });
}
