#!/usr/bin/env npx tsx
// AgentCash x402 Demo — shows the full x402 payment loop for TrstLyr attestations
//
// Usage:
//   npx tsx scripts/agentcash-demo.ts [subject]
//
// Modes:
//   - Dry-run (default): shows what AgentCash would pay, no actual payment
//   - Live:   set AGENTCASH_API_KEY env to pay via AgentCash wallet and complete attestation
//
// Examples:
//   npx tsx scripts/agentcash-demo.ts                    # default subject: github:tankcdr
//   npx tsx scripts/agentcash-demo.ts erc8004:31977
//   AGENTCASH_API_KEY=ak_... npx tsx scripts/agentcash-demo.ts

const API_BASE = process.env['TRSTLYR_API_URL'] ?? 'https://api.trstlyr.ai';
const AGENTCASH_API_KEY = process.env['AGENTCASH_API_KEY'];
const subject = process.argv[2] ?? 'github:tankcdr';

// ── Helpers ──────────────────────────────────────────────────────────────────

function header(msg: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  ${msg}`);
  console.log('═'.repeat(60));
}

function kv(key: string, value: unknown) {
  console.log(`  ${key.padEnd(22)} ${value}`);
}

// ── Step 1: Query trust score (free) ─────────────────────────────────────────

header(`Step 1: Query trust score for "${subject}"`);

const scoreRes = await fetch(`${API_BASE}/v1/trust/score/${encodeURIComponent(subject)}`);
if (!scoreRes.ok) {
  console.error(`  Failed to fetch trust score: HTTP ${scoreRes.status}`);
  process.exit(1);
}

const score = await scoreRes.json() as {
  subject: string;
  trust_score: number;
  confidence: number;
  risk_level: string;
  recommendation: string;
};

kv('Subject', score.subject);
kv('Trust Score', `${score.trust_score.toFixed(1)}%`);
kv('Confidence', score.confidence.toFixed(3));
kv('Risk Level', score.risk_level);
kv('Recommendation', score.recommendation);

// ── Step 2: Attempt attestation (may return 402) ─────────────────────────────

header('Step 2: POST /v1/attest — anchor on-chain');

const attestRes = await fetch(`${API_BASE}/v1/attest`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ subject }),
});

if (attestRes.status === 200) {
  // First attestation is free — it went through
  const data = await attestRes.json() as {
    attestation_uid: string | null;
    attestation_url: string | null;
    on_chain: boolean;
    payment?: { free_tier?: boolean };
  };
  header('Result: Free-tier attestation succeeded');
  kv('Attestation UID', data.attestation_uid ?? '(EAS write skipped)');
  kv('On-chain', data.on_chain);
  if (data.attestation_url) kv('EASScan URL', data.attestation_url);
  kv('Payment', 'FREE (first attestation)');
  console.log('\n  Re-run this script to trigger the x402 payment flow.\n');
  process.exit(0);
}

// ── Step 3: Parse x402 402 response ──────────────────────────────────────────

if (attestRes.status !== 402) {
  console.error(`  Unexpected HTTP ${attestRes.status}`);
  const body = await attestRes.text();
  console.error(`  Body: ${body}`);
  process.exit(1);
}

header('Step 3: Received 402 — payment required');

const paymentHeader = attestRes.headers.get('x-payment-required');
if (!paymentHeader) {
  console.error('  Missing X-PAYMENT-REQUIRED header');
  process.exit(1);
}

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  payTo: string;
  asset: string;
  extra?: { name?: string };
}

interface PaymentRequired {
  x402Version: number;
  accepts: PaymentRequirement[];
  error: string;
}

const paymentRequired: PaymentRequired = JSON.parse(
  Buffer.from(paymentHeader, 'base64').toString('utf8'),
);
const req = paymentRequired.accepts[0]!;

console.log('  x402 Payment Requirements:');
kv('Protocol', `x402 v${paymentRequired.x402Version}`);
kv('Scheme', req.scheme);
kv('Network', req.network);
kv('Amount', `${parseInt(req.maxAmountRequired) / 1e6} ${req.extra?.name ?? 'USDC'}`);
kv('Recipient', req.payTo);
kv('Asset (token)', req.asset);
kv('Resource', req.resource);
kv('Description', req.description);

// ── Step 4: Pay via AgentCash (or dry-run) ───────────────────────────────────

if (!AGENTCASH_API_KEY) {
  header('Step 4: Dry-run — no AGENTCASH_API_KEY set');
  console.log('  An AgentCash wallet would pay:');
  kv('Amount', `$0.01 USDC`);
  kv('To', req.payTo);
  kv('On', req.network);
  kv('Token', req.asset);
  console.log('\n  To complete the payment, set AGENTCASH_API_KEY and re-run:');
  console.log(`    AGENTCASH_API_KEY=ak_... npx tsx scripts/agentcash-demo.ts ${subject}\n`);
  process.exit(0);
}

header('Step 4: Paying via AgentCash wallet');

// Call AgentCash MCP to make the x402 payment
const agentcashRes = await fetch('https://mcp.agentcash.dev/x402/pay', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${AGENTCASH_API_KEY}`,
  },
  body: JSON.stringify({
    paymentRequirements: paymentRequired.accepts,
    resource: req.resource,
  }),
});

if (!agentcashRes.ok) {
  console.error(`  AgentCash payment failed: HTTP ${agentcashRes.status}`);
  const errBody = await agentcashRes.text();
  console.error(`  ${errBody}`);
  process.exit(1);
}

const paymentResult = await agentcashRes.json() as { paymentHeader?: string; payment_header?: string };
const xPaymentHeader = paymentResult.paymentHeader ?? paymentResult.payment_header;

if (!xPaymentHeader) {
  console.error('  AgentCash returned no payment header');
  console.error('  Response:', JSON.stringify(paymentResult, null, 2));
  process.exit(1);
}

kv('Payment', 'SUCCESS');
kv('X-Payment header', `${xPaymentHeader.slice(0, 40)}...`);

// ── Step 5: Complete attestation with payment proof ──────────────────────────

header('Step 5: Completing attestation with payment proof');

const paidRes = await fetch(`${API_BASE}/v1/attest`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Payment': xPaymentHeader,
  },
  body: JSON.stringify({ subject }),
});

if (!paidRes.ok) {
  console.error(`  Paid attestation failed: HTTP ${paidRes.status}`);
  const body = await paidRes.text();
  console.error(`  ${body}`);
  process.exit(1);
}

const paidData = await paidRes.json() as {
  attestation_uid: string | null;
  attestation_url: string | null;
  on_chain: boolean;
  trust_score: number;
  payment?: { amount_usdc?: string };
};

header('Result: Paid attestation complete');
kv('Trust Score', `${paidData.trust_score}%`);
kv('Attestation UID', paidData.attestation_uid ?? '(EAS write skipped)');
kv('On-chain', paidData.on_chain);
if (paidData.attestation_url) kv('EASScan URL', paidData.attestation_url);
kv('Payment', `$${paidData.payment?.amount_usdc ?? '0.01'} USDC via AgentCash`);
console.log('\n  The on-chain attestation includes payment proof in signalSummary.\n');
