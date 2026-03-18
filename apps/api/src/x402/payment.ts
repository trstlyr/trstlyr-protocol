// x402 payment gate — handles 402 responses, verification, and settlement
// Uses the Coinbase facilitator at https://x402.org/facilitator
// Spec: https://github.com/coinbase/x402

import { Wallet } from 'ethers';
import type { FastifyRequest, FastifyReply } from 'fastify';
import type {
  FacilitatorSettleResponse,
  FacilitatorVerifyResponse,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirement,
} from './types.js';
import { hasUsedFree, isNonceUsed, markFreeUsed, markNonceUsed } from './store.js';

// ─── Constants ────────────────────────────────────────────────────────────────

// USDC on Base Mainnet
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// Derive payment receiver from the attestation private key — same wallet does both.
// If no key is set (e.g. local dev without .env), fall back to the known deployment address.
function resolvePaymentReceiver(): string {
  const key = process.env['AEGIS_ATTESTATION_PRIVATE_KEY'];
  if (key) {
    try {
      return new Wallet(key).address;
    } catch {
      console.warn('[x402] Invalid AEGIS_ATTESTATION_PRIVATE_KEY — cannot derive payment receiver');
    }
  }
  const fallback = process.env['X402_PAYMENT_RECEIVER'];
  if (!fallback) throw new Error('X402_PAYMENT_RECEIVER env var is required when AEGIS_ATTESTATION_PRIVATE_KEY is not set');
  return fallback;
}

const PAYMENT_RECEIVER = resolvePaymentReceiver();

/** The wallet address that receives x402 payments (derived from AEGIS_ATTESTATION_PRIVATE_KEY). */
export function getPaymentReceiver(): string {
  return PAYMENT_RECEIVER;
}

// $0.01 USDC (6 decimals)
const AMOUNT_USDC = '10000';

// Coinbase x402 public facilitator
const FACILITATOR_URL = 'https://x402.org/facilitator';

// Base Mainnet chain in CAIP-2 format
const BASE_MAINNET = 'eip155:8453';

// ─── Helpers ──────────────────────────────────────────────────────────────────

export function buildPaymentRequired(resource: string, error: string): PaymentRequired {
  const requirement: PaymentRequirement = {
    scheme: 'exact',
    network: BASE_MAINNET,
    maxAmountRequired: AMOUNT_USDC,
    resource,
    description: 'Anchor this trust score as an EAS attestation on Base Mainnet ($0.01 USDC)',
    mimeType: 'application/json',
    payTo: PAYMENT_RECEIVER,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE,
    extra: { name: 'USDC', version: '2' },
  };

  return { x402Version: 2, accepts: [requirement], error };
}

export function extractPayment(request: FastifyRequest): PaymentPayload | null {
  const header = request.headers['x-payment'];
  if (!header || typeof header !== 'string') return null;
  if (header.length > 4096) throw new Error('X-Payment header exceeds maximum size (4096 bytes)');
  try {
    return JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as PaymentPayload;
  } catch {
    throw new Error('Malformed X-PAYMENT header: expected base64-encoded JSON');
  }
}

async function verifyPayment(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
): Promise<FacilitatorVerifyResponse> {
  try {
    const res = await globalThis.fetch(`${FACILITATOR_URL}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirement }),
    });
    if (!res.ok) return { isValid: false, invalidReason: `Facilitator HTTP ${res.status}` };
    return res.json() as Promise<FacilitatorVerifyResponse>;
  } catch (err) {
    return { isValid: false, invalidReason: `Facilitator unreachable: ${err}` };
  }
}

// Fire-and-forget — don't block the response on settlement
async function settlePayment(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
): Promise<void> {
  try {
    const res = await globalThis.fetch(`${FACILITATOR_URL}/settle`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paymentPayload: payload, paymentRequirements: requirement }),
    });
    const body = await res.json() as FacilitatorSettleResponse;
    if (!body.success) {
      console.warn('[x402] settlement failed:', body.error);
    } else {
      console.log('[x402] settled:', body.txHash);
    }
  } catch (err) {
    console.warn('[x402] settle error:', err);
  }
}

// ─── Gate ─────────────────────────────────────────────────────────────────────

/**
 * x402 gate for POST /v1/attest.
 *
 * Returns true  → caller may proceed (free tier granted or payment verified).
 * Returns false → reply already sent (402 or 4xx); caller must return immediately.
 *
 * Pricing:
 *   - First attestation per subject: FREE
 *   - Subsequent attestations:       $0.01 USDC via x402 (Base Mainnet)
 */
export async function checkAttestationGate(
  request: FastifyRequest,
  reply: FastifyReply,
  subject: string,
  resourceUrl: string,
): Promise<boolean> {
  // Extract payment header (may throw on bad base64)
  let payment: PaymentPayload | null;
  try {
    payment = extractPayment(request);
  } catch (err) {
    await reply.code(400).send({ error: String(err) });
    return false;
  }

  // ── No payment header ────────────────────────────────────────────────────────
  if (!payment) {
    if (!await hasUsedFree(subject)) {
      // Grant free attestation
      await markFreeUsed(subject);
      return true;
    }

    // Free used — request payment
    const paymentRequired = buildPaymentRequired(
      resourceUrl,
      'Free attestation already used for this subject. Pay $0.01 USDC to anchor additional trust scores on Base Mainnet.',
    );
    await reply
      .code(402)
      .header('X-PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'))
      .send(paymentRequired);
    return false;
  }

  // ── Payment header present ────────────────────────────────────────────────────
  const requirement = buildPaymentRequired(resourceUrl, '').accepts[0]!;

  // Replay protection
  const nonce = payment.payload?.authorization?.nonce;
  if (nonce) {
    if (await isNonceUsed(nonce)) {
      await reply.code(402).send({ error: 'Payment nonce already used — replay detected' });
      return false;
    }
  }

  // Verify with facilitator
  const verification = await verifyPayment(payment, requirement);
  if (!verification.isValid) {
    const paymentRequired = buildPaymentRequired(
      resourceUrl,
      verification.invalidReason ?? 'Payment invalid',
    );
    await reply
      .code(402)
      .header('X-PAYMENT-REQUIRED', Buffer.from(JSON.stringify(paymentRequired)).toString('base64'))
      .send(paymentRequired);
    return false;
  }

  // Mark nonce used before we proceed (prevents race-condition replay)
  if (nonce) await markNonceUsed(nonce);

  // Settle asynchronously — don't hold the HTTP response
  settlePayment(payment, requirement).catch(() => {/* logged inside */});

  return true;
}
