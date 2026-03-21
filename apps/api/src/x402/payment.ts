// x402 payment gate — handles 402 responses, verification, and settlement
// Self-verifies EIP-3009 TransferWithAuthorization signatures locally.
// Does not depend on the Coinbase facilitator (x402.org is unreliable).
// Spec: https://github.com/coinbase/x402

import { Wallet, verifyTypedData } from 'ethers';
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

// Base Mainnet chain ID (used for local EIP-712 domain verification)
const BASE_CHAIN_ID = 8453n;

// Base Mainnet — x402 network identifier
const BASE_MAINNET = 'base';

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

/**
 * Locally verify an EIP-3009 TransferWithAuthorization signature.
 * No dependency on x402.org facilitator — self-sovereign verification.
 */
async function verifyPayment(
  payload: PaymentPayload,
  requirement: PaymentRequirement,
): Promise<FacilitatorVerifyResponse> {
  try {
    const auth = payload.payload?.authorization;
    const sig  = payload.payload?.signature;

    if (!auth || !sig) {
      return { isValid: false, invalidReason: 'Missing authorization or signature' };
    }

    // Check recipient matches our payment receiver
    if (auth.to?.toLowerCase() !== PAYMENT_RECEIVER.toLowerCase()) {
      return { isValid: false, invalidReason: `Recipient mismatch: expected ${PAYMENT_RECEIVER}, got ${auth.to}` };
    }

    // Check amount meets minimum
    if (BigInt(auth.value ?? '0') < BigInt(requirement.maxAmountRequired)) {
      return { isValid: false, invalidReason: `Insufficient amount: ${auth.value} < ${requirement.maxAmountRequired}` };
    }

    // Check expiry
    const now = BigInt(Math.floor(Date.now() / 1000));
    if (BigInt(auth.validBefore ?? '0') < now) {
      return { isValid: false, invalidReason: 'Payment authorization expired' };
    }

    // EIP-712 domain for USDC on Base Mainnet
    const domain = {
      name:              'USD Coin',
      version:           '2',
      chainId:           BASE_CHAIN_ID,
      verifyingContract: USDC_BASE,
    };

    const types = {
      TransferWithAuthorization: [
        { name: 'from',        type: 'address' },
        { name: 'to',          type: 'address' },
        { name: 'value',       type: 'uint256' },
        { name: 'validAfter',  type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce',       type: 'bytes32' },
      ],
    };

    const message = {
      from:        auth.from,
      to:          auth.to,
      value:       BigInt(auth.value),
      validAfter:  BigInt(auth.validAfter ?? '0'),
      validBefore: BigInt(auth.validBefore),
      nonce:       auth.nonce,
    };

    const recovered = verifyTypedData(domain, types, message, sig);

    if (recovered.toLowerCase() !== auth.from?.toLowerCase()) {
      return { isValid: false, invalidReason: `Signature mismatch: recovered ${recovered}, expected ${auth.from}` };
    }

    console.log(`[x402] ✓ self-verified EIP-3009 from ${recovered}`);
    return { isValid: true, payer: recovered };

  } catch (err) {
    console.warn('[x402] verification error:', err);
    return { isValid: false, invalidReason: `Verification error: ${err}` };
  }
}

// Settlement is fire-and-forget — log the payment for record-keeping.
// Full on-chain settlement (calling USDC.transferWithAuthorization) is Phase 2.
async function settlePayment(
  payload: PaymentPayload,
  _requirement: PaymentRequirement,
): Promise<void> {
  const auth = payload.payload?.authorization;
  console.log(`[x402] payment settled (self-custody): from=${auth?.from} amount=${auth?.value} nonce=${auth?.nonce?.slice(0, 10)}...`);
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
