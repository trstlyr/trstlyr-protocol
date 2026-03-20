import { describe, it, expect, beforeEach } from 'vitest';
import { IdentityGraph } from '../identity/graph.js';
import type { SubjectRef, VerificationMethod } from '../identity/graph.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const gh    = (id: string): SubjectRef => ({ namespace: 'github',  id });
const tw    = (id: string): SubjectRef => ({ namespace: 'twitter', id });
const erc   = (id: string): SubjectRef => ({ namespace: 'erc8004', id });
const molt  = (id: string): SubjectRef => ({ namespace: 'moltbook', id });

// ── addLink / basic retrieval ─────────────────────────────────────────────────

describe('IdentityGraph — addLink and retrieval', () => {
  let g: IdentityGraph;
  beforeEach(() => { g = new IdentityGraph(); });

  it('starts empty', () => {
    expect(g.size()).toBe(0);
    expect(g.getLinked(gh('tankcdr'))).toEqual([]);
  });

  it('addLink stores a link and returns it', () => {
    const link = g.addLink(gh('tankcdr'), tw('tankcdr'), 'tweet_challenge');
    expect(link.from).toEqual(gh('tankcdr'));
    expect(link.to).toEqual(tw('tankcdr'));
    expect(link.method).toBe('tweet_challenge');
    expect(link.confidence).toBeCloseTo(0.80);
  });

  it('size() increments per unique link', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    g.addLink(gh('a'), erc('1'), 'wallet_signature');
    expect(g.size()).toBe(2);
  });

  it('addLink is idempotent — re-adding same link keeps size=1', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    expect(g.size()).toBe(1);
  });

  it('re-adding with different method updates the link', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    g.addLink(gh('a'), tw('a'), 'wallet_signature');
    const link = g.getLink(gh('a'), tw('a'));
    expect(link?.method).toBe('wallet_signature');
    expect(link?.confidence).toBeCloseTo(0.95);
  });
});

// ── Confidence by method ──────────────────────────────────────────────────────

describe('IdentityGraph — confidence levels', () => {
  let g: IdentityGraph;
  beforeEach(() => { g = new IdentityGraph(); });

  const cases: [VerificationMethod, number][] = [
    ['wallet_signature', 0.95],
    ['tweet_challenge',  0.80],
    ['erc8004_services', 0.70],
    ['manual',           0.90],
  ];

  it.each(cases)('method %s → confidence %f', (method, expected) => {
    const link = g.addLink(gh('x'), tw('x'), method);
    expect(link.confidence).toBeCloseTo(expected);
  });
});

// ── Order-independence (A↔B === B↔A) ─────────────────────────────────────────

describe('IdentityGraph — order-independent links', () => {
  let g: IdentityGraph;
  beforeEach(() => { g = new IdentityGraph(); });

  it('areLinked(a,b) === areLinked(b,a)', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    expect(g.areLinked(gh('alice'), tw('alice'))).toBe(true);
    expect(g.areLinked(tw('alice'), gh('alice'))).toBe(true);
  });

  it('getLink(a,b) and getLink(b,a) return the same link', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    const fwd = g.getLink(gh('alice'), tw('alice'));
    const rev = g.getLink(tw('alice'), gh('alice'));
    expect(fwd?.id).toBe(rev?.id);
  });

  it('addLink(a,b) and addLink(b,a) count as one link', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    g.addLink(tw('a'), gh('a'), 'tweet_challenge');
    expect(g.size()).toBe(1);
  });
});

// ── getLinked ─────────────────────────────────────────────────────────────────

describe('IdentityGraph — getLinked (one hop)', () => {
  let g: IdentityGraph;
  beforeEach(() => {
    g = new IdentityGraph();
    g.addLink(gh('tankcdr'), tw('tankcdr'), 'tweet_challenge');
    g.addLink(gh('tankcdr'), erc('31977'), 'wallet_signature');
  });

  it('returns all directly linked identifiers', () => {
    const links = g.getLinked(gh('tankcdr'));
    expect(links).toHaveLength(2);
  });

  it('getLinked is bidirectional — works from either end', () => {
    const fromTwitter = g.getLinked(tw('tankcdr'));
    expect(fromTwitter).toHaveLength(1);
    expect(fromTwitter[0]!.from).toEqual(gh('tankcdr'));
  });

  it('unlinked subject returns empty array', () => {
    expect(g.getLinked(gh('nobody'))).toEqual([]);
  });
});

// ── resolveAll (transitive) ───────────────────────────────────────────────────

describe('IdentityGraph — resolveAll (transitive)', () => {
  let g: IdentityGraph;
  beforeEach(() => { g = new IdentityGraph(); });

  it('no links → returns empty array', () => {
    expect(g.resolveAll(gh('nobody'))).toEqual([]);
  });

  it('single hop: A→B, resolveAll(A) returns [B]', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    const resolved = g.resolveAll(gh('alice'));
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toEqual(tw('alice'));
  });

  it('two hops: A→B→C, resolveAll(A) returns [B, C]', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    g.addLink(tw('alice'), erc('99'), 'wallet_signature');
    const resolved = g.resolveAll(gh('alice'));
    const keys = resolved.map(s => `${s.namespace}:${s.id}`);
    expect(keys).toContain('twitter:alice');
    expect(keys).toContain('erc8004:99');
  });

  it('resolveAll from any node in chain finds all others', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    g.addLink(tw('alice'), erc('99'), 'wallet_signature');
    // Starting from erc should still reach gh and tw
    const resolved = g.resolveAll(erc('99'));
    const keys = resolved.map(s => `${s.namespace}:${s.id}`);
    expect(keys).toContain('twitter:alice');
    expect(keys).toContain('github:alice');
  });

  it('does not include the subject itself in results', () => {
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    const resolved = g.resolveAll(gh('alice'));
    const keys = resolved.map(s => `${s.namespace}:${s.id}`);
    expect(keys).not.toContain('github:alice');
  });

  it('cycle resistance: A↔B does not loop forever', () => {
    // IdentityGraph links are already bidirectional, but explicit cycles shouldn't hang
    g.addLink(gh('alice'), tw('alice'), 'tweet_challenge');
    g.addLink(tw('alice'), gh('alice'), 'tweet_challenge');
    // Should return exactly one result, not infinite
    const resolved = g.resolveAll(gh('alice'));
    expect(resolved.length).toBeLessThanOrEqual(2);
  });

  it('large web: star topology — hub linked to 5 spokes', () => {
    const spokes = ['tw', 'erc', 'moltbook', 'clawhub', 'self']
      .map((ns, i) => ({ namespace: ns, id: `spoke-${i}` }));
    for (const spoke of spokes) {
      g.addLink(gh('hub'), spoke, 'wallet_signature');
    }
    const resolved = g.resolveAll(gh('hub'));
    expect(resolved).toHaveLength(5);
  });

  it('maxHops limits traversal depth', () => {
    // Chain: A→B→C→D→E (4 hops deep)
    g.addLink(gh('a'), tw('b'), 'tweet_challenge');
    g.addLink(tw('b'), erc('c'), 'wallet_signature');
    g.addLink(erc('c'), molt('d'), 'manual');
    g.addLink(molt('d'), gh('e'), 'tweet_challenge');
    // maxHops=1 — only direct neighbor
    const shallow = g.resolveAll(gh('a'), 1);
    expect(shallow.map(s => `${s.namespace}:${s.id}`)).toContain('twitter:b');
    expect(shallow.map(s => `${s.namespace}:${s.id}`)).not.toContain('github:e');
  });
});

// ── allLinks / size ───────────────────────────────────────────────────────────

describe('IdentityGraph — allLinks and size', () => {
  let g: IdentityGraph;
  beforeEach(() => { g = new IdentityGraph(); });

  it('allLinks() returns every stored link', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge');
    g.addLink(gh('a'), erc('1'), 'wallet_signature');
    g.addLink(gh('b'), tw('b'), 'tweet_challenge');
    expect(g.allLinks()).toHaveLength(3);
  });

  it('attestationUid is stored on the link', () => {
    g.addLink(gh('a'), tw('a'), 'wallet_signature', {}, '0xdeadbeef');
    const link = g.getLink(gh('a'), tw('a'));
    expect(link?.attestationUid).toBe('0xdeadbeef');
  });

  it('attestationUid preserved when re-adding without new uid', () => {
    g.addLink(gh('a'), tw('a'), 'tweet_challenge', {}, '0xabc');
    g.addLink(gh('a'), tw('a'), 'wallet_signature', {}); // no uid this time
    const link = g.getLink(gh('a'), tw('a'));
    expect(link?.attestationUid).toBe('0xabc');
  });
});
