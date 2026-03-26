// Identity Challenge — register and verify agent identities (SPEC §8)
//
// Any agent can register any identity they control. Validation method is
// determined by namespace:
//   twitter / x     → post challenge tweet, submit URL (no API key needed)
//   github          → create public gist with challenge string, submit URL
//   erc8004         → sign challenge with wallet that owns the token
//   moltbook        → post challenge as a moltbook post, submit URL
//
// Optional link_to: link a newly verified identity to one already in the graph.
// The link_to identity must be verified first — we don't auto-discover sameness.
//
// Challenges expire after 24 hours.

import { ethers } from 'ethers';
import { identityGraph } from './graph.js';
import type { SubjectRef, VerificationMethod } from './graph.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChallengeMethod = 'tweet' | 'gist' | 'wallet_signature';
export type ChallengeStatus = 'pending' | 'verified' | 'expired' | 'failed';

export interface Challenge {
  id:              string;
  subject:         SubjectRef;   // the identity being claimed/registered
  linkTo?:         SubjectRef;   // optional: link to this already-verified identity
  method:          ChallengeMethod;
  challengeString: string;       // the token the agent must publish or sign
  instructions:    string;       // human-readable steps
  createdAt:       string;
  expiresAt:       string;
  status:          ChallengeStatus;
}

export interface VerifyResult {
  success: boolean;
  registered?: string;           // the newly verified identity
  linked?:     string;           // the identity it was linked to (if link_to provided)
  confidence?: number;
  method?:     VerificationMethod;
  error?:      string;
}

// Proof payload for a single identity
export interface ProofPayload {
  tweetUrl?:  string;   // twitter/moltbook: URL of verification tweet
  gistUrl?:   string;   // github: URL of public gist
  signature?: string;   // erc8004/wallet: hex signature
}

export interface VerifyProof {
  // Proof for the subject identity
  tweetUrl?:        string;
  gistUrl?:         string;
  signature?:       string;
  twitterUsername?: string; // legacy bearer-token fallback

  // Proof for link_to identity (REQUIRED when link_to was set on the challenge)
  // The SAME challenge string must appear in the link_to's medium too.
  linkToTweetUrl?:  string;
  linkToGistUrl?:   string;
  linkToSignature?: string;
}

// ─── Challenge store ──────────────────────────────────────────────────────────

const challenges    = new Map<string, Challenge>();
const idempotencyIdx = new Map<string, string>(); // idempotency key → challenge id
const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Deterministic key for a registration request — same subject + link_to = same key */
function idempotencyKey(subject: SubjectRef, linkTo?: SubjectRef): string {
  const base = `${subject.namespace}:${subject.id}`;
  return linkTo ? `${base}|${linkTo.namespace}:${linkTo.id}` : base;
}

/** Remove a challenge from both stores */
function deleteChallenge(id: string, key?: string): void {
  challenges.delete(id);
  if (key) idempotencyIdx.delete(key);
}

// Purge expired challenges every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [id, challenge] of challenges) {
    if (now > new Date(challenge.expiresAt).getTime()) {
      const key = idempotencyKey(challenge.subject, challenge.linkTo);
      deleteChallenge(id, key);
    }
  }
}, 10 * 60 * 1000).unref();

// ─── Namespace → method mapping ───────────────────────────────────────────────

function methodForNamespace(namespace: string): ChallengeMethod {
  switch (namespace) {
    case 'twitter':
    case 'x':
    case 'moltbook':
      return 'tweet';
    case 'github':
      return 'gist';
    case 'erc8004':
    case 'eth':
    case 'wallet':
    case 'self':
      return 'wallet_signature';
    default:
      return 'tweet'; // sensible default for social namespaces
  }
}

// ─── Issue ────────────────────────────────────────────────────────────────────

/**
 * Issue a registration challenge for a subject.
 * The agent proves they control the subject identity by publishing or signing
 * the challenge string per the namespace's verification method.
 *
 * Optional link_to: if provided and already verified in the graph, a link
 * will be created on successful verification.
 */
export function issueChallenge(subject: SubjectRef, linkTo?: SubjectRef): Challenge {
  // Idempotency — return existing pending challenge for the same request
  const iKey       = idempotencyKey(subject, linkTo);
  const existingId = idempotencyIdx.get(iKey);
  if (existingId) {
    const existing = challenges.get(existingId);
    if (existing && existing.status === 'pending' && Date.now() < new Date(existing.expiresAt).getTime()) {
      return existing; // same challenge, same code — agent can reuse it
    }
    // Stale entry — clean up and issue fresh
    idempotencyIdx.delete(iKey);
  }

  const id  = crypto.randomUUID();
  const now = Date.now();

  const token           = id.slice(0, 8).toUpperCase();
  const challengeString = `trstlyr-verify:${token}`;
  const method          = methodForNamespace(subject.namespace);
  const instructions    = buildInstructions(subject, method, challengeString, id, linkTo);

  const challenge: Challenge = {
    id,
    subject,
    linkTo,
    method,
    challengeString,
    instructions,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    status:    'pending',
  };

  challenges.set(id, challenge);
  idempotencyIdx.set(iKey, id);
  return challenge;
}

// ─── Verify ───────────────────────────────────────────────────────────────────

/**
 * Verify a challenge. On success:
 *  - Marks the subject as verified in the identity graph (self-link)
 *  - If link_to was provided and is already verified, creates a link
 */
export async function verifyChallenge(
  challengeId: string,
  proof: VerifyProof,
): Promise<VerifyResult> {
  const challenge = challenges.get(challengeId);

  if (!challenge) {
    return { success: false, error: 'Challenge not found' };
  }
  if (challenge.status !== 'pending') {
    return { success: false, error: `Challenge is already ${challenge.status}` };
  }
  if (Date.now() > new Date(challenge.expiresAt).getTime()) {
    deleteChallenge(challengeId, idempotencyKey(challenge.subject, challenge.linkTo));
    return { success: false, error: 'Challenge expired (24h limit)' };
  }

  try {
    // ── Step 1: verify the subject identity ──────────────────────────────────
    let subjectVerified = false;

    switch (challenge.method) {
      case 'tweet':
        subjectVerified = await verifyTweet(challenge, proof.tweetUrl, proof.twitterUsername);
        break;
      case 'gist':
        subjectVerified = await verifyGist(challenge, proof.gistUrl);
        break;
      case 'wallet_signature':
        subjectVerified = await verifyWalletSignature(challenge, proof.signature);
        break;
    }

    if (!subjectVerified) {
      return { success: false, error: 'Subject proof not found — challenge string not detected at the provided URL or signature invalid' };
    }

    // ── Step 2: if link_to, verify that identity too ─────────────────────────
    // The SAME challenge string must appear in the link_to's medium.
    // This proves the same agent controls both identities simultaneously.
    if (challenge.linkTo) {
      const linkToMethod = methodForNamespace(challenge.linkTo.namespace);
      const linkToKey    = `${challenge.linkTo.namespace}:${challenge.linkTo.id}`;

      // Require link_to proof fields
      const hasLinkToProof = proof.linkToTweetUrl || proof.linkToGistUrl || proof.linkToSignature;
      if (!hasLinkToProof) {
        return {
          success: false,
          error:   `link_to proof required — you must also prove control of "${linkToKey}". ` +
                   `Post the same challenge string (${challenge.challengeString}) via ${linkToMethod} ` +
                   `and provide link_to_tweet_url, link_to_gist_url, or link_to_signature.`,
        };
      }

      // Verify link_to using a synthetic challenge scoped to that subject
      const linkToChallenge = { ...challenge, subject: challenge.linkTo, method: linkToMethod };
      let linkToVerified = false;

      switch (linkToMethod) {
        case 'tweet':
          linkToVerified = await verifyTweet(linkToChallenge as Challenge, proof.linkToTweetUrl);
          break;
        case 'gist':
          linkToVerified = await verifyGist(linkToChallenge as Challenge, proof.linkToGistUrl);
          break;
        case 'wallet_signature':
          linkToVerified = await verifyWalletSignature(linkToChallenge as Challenge, proof.linkToSignature);
          break;
      }

      if (!linkToVerified) {
        return {
          success: false,
          error:   `link_to proof failed — challenge string not found in "${linkToKey}" via ${linkToMethod}. ` +
                   `The same string must appear in both identities' proofs.`,
        };
      }
    }

    // ── Both proofs passed — commit to graph ──────────────────────────────────
    challenge.status = 'verified';
    deleteChallenge(challengeId, idempotencyKey(challenge.subject, challenge.linkTo));

    const evidenceBase = {
      challenge_id: challengeId,
      method:       challenge.method,
      verified_at:  new Date().toISOString(),
      proof:        sanitizeProof(proof),
    };

    const graphMethod: VerificationMethod =
      challenge.method === 'wallet_signature' ? 'wallet_signature' : 'tweet_challenge';

    // Register the subject as verified
    identityGraph.addLink(challenge.subject, challenge.subject, graphMethod, evidenceBase);

    if (challenge.linkTo) {
      const link = identityGraph.addLink(
        challenge.subject,
        challenge.linkTo,
        graphMethod,
        evidenceBase,
      );
      const linkToKey = `${challenge.linkTo.namespace}:${challenge.linkTo.id}`;
      return {
        success:    true,
        registered: `${challenge.subject.namespace}:${challenge.subject.id}`,
        linked:     linkToKey,
        confidence: link.confidence,
        method:     graphMethod,
      };
    }

    return {
      success:    true,
      registered: `${challenge.subject.namespace}:${challenge.subject.id}`,
      confidence: graphMethod === 'wallet_signature' ? 0.95 : 0.80,
      method:     graphMethod,
    };

  } catch (err) {
    challenge.status = 'failed';
    deleteChallenge(challengeId, idempotencyKey(challenge.subject, challenge.linkTo));
    return {
      success: false,
      error:   err instanceof Error ? err.message : 'Unknown verification error',
    };
  }
}

// ─── Get challenge ────────────────────────────────────────────────────────────

export function getChallenge(id: string): Challenge | undefined {
  return challenges.get(id);
}

// ─── Import (startup hydration) ───────────────────────────────────────────────

/** Load a persisted challenge back into the in-memory store (e.g. after restart). */
export function importChallenge(challenge: Challenge): void {
  if (challenges.has(challenge.id)) return; // already present
  challenges.set(challenge.id, challenge);
  const iKey = idempotencyKey(challenge.subject, challenge.linkTo);
  idempotencyIdx.set(iKey, challenge.id);
}

// ─── Tweet verification ───────────────────────────────────────────────────────

async function verifyTweet(
  challenge: Challenge,
  tweetUrl?: string,
  twitterUsername?: string,
): Promise<boolean> {
  if (tweetUrl) return verifyTweetByUrl(tweetUrl, challenge.challengeString);

  const bearerToken = process.env['TWITTER_BEARER_TOKEN'];
  if (bearerToken && twitterUsername) {
    return verifyTweetByBearerToken(twitterUsername, challenge.challengeString, bearerToken);
  }

  throw new Error('Provide tweet_url (URL of your verification tweet) — no API key required.');
}

function validateTweetUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Invalid tweet URL: must be a twitter.com or x.com URL');
  }
  const host = parsed.hostname.replace(/^www\./, '');
  if (host !== 'twitter.com' && host !== 'x.com') {
    throw new Error('Invalid tweet URL: must be a twitter.com or x.com URL');
  }
}

async function verifyTweetByUrl(tweetUrl: string, challengeString: string): Promise<boolean> {
  validateTweetUrl(tweetUrl);

  const normalised = tweetUrl.replace('x.com/', 'twitter.com/');

  // 1. Try oEmbed — public, no auth
  const controller1 = new AbortController();
  const timer1 = setTimeout(() => controller1.abort(), 10_000);
  try {
    const res = await globalThis.fetch(
      `https://publish.twitter.com/oembed?url=${encodeURIComponent(normalised)}&omit_script=true`,
      { headers: { 'User-Agent': 'TrstLyr/1.0 (+https://trstlyr.ai)' }, signal: controller1.signal },
    );
    if (res.ok) {
      const body = await res.json() as { html?: string };
      if (body.html) return body.html.includes(challengeString);
    }
  } catch {
    // oEmbed failed — fall through to HTML scrape only for rate-limit / temporary errors
  } finally {
    clearTimeout(timer1);
  }

  // 2. Fallback: HTML scrape — URL already domain-validated above
  const controller2 = new AbortController();
  const timer2 = setTimeout(() => controller2.abort(), 10_000);
  try {
    const res = await globalThis.fetch(normalised, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TrstLyrBot/1.0; +https://trstlyr.ai)' },
      redirect: 'follow',
      signal: controller2.signal,
    });
    if (!res.ok) return false;
    return (await res.text()).includes(challengeString);
  } catch {
    return false;
  } finally {
    clearTimeout(timer2);
  }
}

async function verifyTweetByBearerToken(
  username: string,
  challengeString: string,
  bearerToken: string,
): Promise<boolean> {
  const clean = username.replace(/^@/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await globalThis.fetch(
      `https://api.twitter.com/2/users/by/username/${encodeURIComponent(clean)}?user.fields=description`,
      { headers: { Authorization: `Bearer ${bearerToken}` }, signal: controller.signal },
    );
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) return false;
  const body = await res.json() as { data?: { description?: string; id?: string } };
  if ((body.data?.description ?? '').includes(challengeString)) return true;

  const userId = body.data?.id;
  if (userId) {
    const tweetsRes = await globalThis.fetch(
      `https://api.twitter.com/2/users/${userId}/tweets?max_results=10`,
      { headers: { Authorization: `Bearer ${bearerToken}` } },
    );
    if (tweetsRes.ok) {
      const t = await tweetsRes.json() as { data?: Array<{ text: string }> };
      if ((t.data ?? []).some(tw => tw.text.includes(challengeString))) return true;
    }
  }
  return false;
}

// ─── Gist verification (GitHub) ───────────────────────────────────────────────

function validateGistUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Invalid gist URL: must be a gist.github.com URL');
  }
  const host = parsed.hostname;
  if (host !== 'gist.github.com' && host !== 'gist.githubusercontent.com') {
    throw new Error('Invalid gist URL: must be a gist.github.com URL');
  }
}

async function verifyGist(challenge: Challenge, gistUrl?: string): Promise<boolean> {
  if (!gistUrl) {
    throw new Error('Provide gist_url (URL of your public GitHub gist containing the challenge string).');
  }

  validateGistUrl(gistUrl);

  // Accept gist.github.com/<user>/<id> or raw URL
  // Convert to raw URL for reliable text access
  const rawUrl = gistUrl.includes('/raw/')
    ? gistUrl
    : gistUrl.replace('gist.github.com/', 'gist.githubusercontent.com/') + '/raw';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await globalThis.fetch(rawUrl, {
      headers: { 'User-Agent': 'TrstLyr/1.0 (+https://trstlyr.ai)' },
      redirect: 'follow',
      signal: controller.signal,
    });
    if (!res.ok) return false;
    return (await res.text()).includes(challenge.challengeString);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Wallet signature verification (ERC-8004) ─────────────────────────────────

async function verifyWalletSignature(challenge: Challenge, signature?: string): Promise<boolean> {
  if (!signature) throw new Error('signature required for erc8004/wallet verification');

  const recovered = ethers.verifyMessage(challenge.challengeString, signature);

  if (challenge.subject.namespace === 'erc8004') {
    const id = challenge.subject.id;
    // If id looks like a wallet address (0x + 40 hex chars), verify directly
    if (/^0x[0-9a-fA-F]{40}$/.test(id)) {
      return recovered.toLowerCase() === id.toLowerCase();
    }
    // Otherwise treat as agent ID and look up owner
    const owner = await getERC8004Owner(id);
    return recovered.toLowerCase() === owner.toLowerCase();
  }

  // wallet / eth / self namespace: id IS the address
  if (
    challenge.subject.namespace === 'wallet' ||
    challenge.subject.namespace === 'eth' ||
    challenge.subject.namespace === 'self'
  ) {
    return recovered.toLowerCase() === challenge.subject.id.toLowerCase();
  }

  return recovered !== ethers.ZeroAddress;
}

async function getERC8004Owner(agentId: string): Promise<string> {
  const rpcUrl  = process.env['BASE_RPC_URL'] ?? 'https://mainnet.base.org';
  const registry = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
  const numericId = parseInt(agentId.split(':').pop() ?? agentId, 10);
  const padded    = numericId.toString(16).padStart(64, '0');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await globalThis.fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method:  'eth_call',
        params:  [{ to: registry, data: '0x6352211e' + padded }, 'latest'],
      }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new Error(`ERC-8004 owner lookup failed: HTTP ${res.status}`);
  }

  const json = await res.json() as { result?: string };
  return '0x' + (json.result ?? '0x').slice(-40);
}

// ─── Instructions ─────────────────────────────────────────────────────────────

function buildInstructions(
  subject:         SubjectRef,
  method:          ChallengeMethod,
  challengeString: string,
  challengeId:     string,
  linkTo?:         SubjectRef,
): string {
  const subjectProof  = proofInstructions(subject, method, challengeString, 'subject');
  const verifyPayload = buildVerifyPayload(challengeId, subject, method, linkTo);

  const lines = [
    `Registering ${subject.namespace}:${subject.id} on TrstLyr Protocol.`,
    ``,
    `Challenge string (publish this in BOTH steps if linking):`,
    `  ${challengeString}`,
    ``,
    `── Step 1: Prove you control ${subject.namespace}:${subject.id} ──`,
    subjectProof,
  ];

  if (linkTo) {
    const linkToMethod = methodForNamespace(linkTo.namespace);
    const linkToProof  = proofInstructions(linkTo, linkToMethod, challengeString, 'link_to');
    lines.push(
      ``,
      `── Step 2: Prove you also control ${linkTo.namespace}:${linkTo.id} ──`,
      `(Same challenge string — proves both identities belong to you.)`,
      linkToProof,
    );
  }

  lines.push(``, `── Submit ──`, verifyPayload, ``, `Challenge expires in 24 hours.`);
  return lines.join('\n');
}

function proofInstructions(subject: SubjectRef, method: ChallengeMethod, challengeString: string, _role: string): string {
  if (method === 'tweet') {
    const tweetText = [
      `Verifying my AI agent identity on TrstLyr Protocol.`,
      ``,
      challengeString,
      ``,
      `https://trstlyr.ai`,
    ].join('\n');
    return [
      `Post this tweet from @${subject.id}:`,
      `---`,
      tweetText,
      `---`,
    ].join('\n');
  }

  if (method === 'gist') {
    return [
      `Create a public gist at https://gist.github.com with this content:`,
      `---`,
      challengeString,
      `---`,
    ].join('\n');
  }

  // wallet_signature
  return [
    `Sign this message with the wallet that owns ${subject.id}:`,
    `  "${challengeString}"`,
    `  ethers.js: await wallet.signMessage("${challengeString}")`,
    `  cast:      cast wallet sign "${challengeString}" --interactive`,
  ].join('\n');
}

function buildVerifyPayload(
  challengeId: string,
  subject:     SubjectRef,
  method:      ChallengeMethod,
  linkTo?:     SubjectRef,
): string {
  const subjectField = method === 'tweet'             ? `"tweet_url": "https://x.com/${subject.id}/status/<id>"` :
                       method === 'gist'              ? `"gist_url": "https://gist.github.com/${subject.id}/<gist_id>"` :
                                                       `"signature": "<0x...>"`;

  if (!linkTo) {
    return [
      `POST /v1/identity/verify`,
      `{`,
      `  "challenge_id": "${challengeId}",`,
      `  ${subjectField}`,
      `}`,
    ].join('\n');
  }

  const linkToMethod = methodForNamespace(linkTo.namespace);
  const linkToField  = linkToMethod === 'tweet'          ? `"link_to_tweet_url": "https://x.com/${linkTo.id}/status/<id>"` :
                       linkToMethod === 'gist'           ? `"link_to_gist_url": "https://gist.github.com/${linkTo.id}/<gist_id>"` :
                                                          `"link_to_signature": "<0x...>"`;

  return [
    `POST /v1/identity/verify`,
    `{`,
    `  "challenge_id": "${challengeId}",`,
    `  ${subjectField},`,
    `  ${linkToField}`,
    `}`,
  ].join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sanitizeProof(proof: VerifyProof): Record<string, unknown> {
  return {
    tweet_url:           proof.tweetUrl ?? null,
    gist_url:            proof.gistUrl ?? null,
    twitter_username:    proof.twitterUsername ?? null,
    signature_present:   Boolean(proof.signature),
    link_to_tweet_url:   proof.linkToTweetUrl ?? null,
    link_to_gist_url:    proof.linkToGistUrl ?? null,
    link_to_sig_present: Boolean(proof.linkToSignature),
  };
}
