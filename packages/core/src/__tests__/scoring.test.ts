import { describe, it, expect } from 'vitest';
import {
  signalToOpinion,
  fuseTwo,
  fuseOpinions,
  projectScore,
  evTrustAdjust,
  mapRiskLevel,
  mapRecommendation,
  applyContextMultiplier,
  detectEntityType,
} from '../engine/scoring.js';
import { EV_TRUST, RISK, SL } from '../constants.js';
import type { Signal } from '../types/index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
const sig = (score: number, confidence: number): Signal => ({
  provider: 'test',
  signal_type: 'test',
  score,
  confidence,
  ttl: 300,
  evidence: {},
  timestamp: new Date().toISOString(),
});

// ── signalToOpinion ───────────────────────────────────────────────────────────
describe('signalToOpinion', () => {
  it('perfect signal (score=1, confidence=1) → belief=1, disbelief=0, uncertainty=0', () => {
    const op = signalToOpinion(sig(1, 1));
    expect(op.belief).toBeCloseTo(1);
    expect(op.disbelief).toBeCloseTo(0);
    expect(op.uncertainty).toBeCloseTo(0);
  });

  it('zero signal (score=0, confidence=1) → belief=0, disbelief=1, uncertainty=0', () => {
    const op = signalToOpinion(sig(0, 1));
    expect(op.belief).toBeCloseTo(0);
    expect(op.disbelief).toBeCloseTo(1);
    expect(op.uncertainty).toBeCloseTo(0);
  });

  it('vacuous signal (confidence=0) → full uncertainty regardless of score', () => {
    const op = signalToOpinion(sig(0.9, 0));
    expect(op.belief).toBeCloseTo(0);
    expect(op.uncertainty).toBeCloseTo(1);
  });

  it('mid-range signal (score=0.6, confidence=0.8)', () => {
    const op = signalToOpinion(sig(0.6, 0.8));
    expect(op.belief).toBeCloseTo(0.48);
    expect(op.disbelief).toBeCloseTo(0.32);
    expect(op.uncertainty).toBeCloseTo(0.2);
    expect(op.baseRate).toBe(SL.BASE_RATE);
  });

  it('clamps out-of-range inputs', () => {
    const op = signalToOpinion(sig(1.5, -0.2));
    expect(op.belief).toBeGreaterThanOrEqual(0);
    expect(op.uncertainty).toBeLessThanOrEqual(1);
  });

  it('opinion components sum to 1: b + d + u = 1', () => {
    for (const [s, c] of [[0.3, 0.7], [0.8, 0.5], [0.0, 1.0], [1.0, 0.1]] as [number,number][]) {
      const op = signalToOpinion(sig(s, c));
      expect(op.belief + op.disbelief + op.uncertainty).toBeCloseTo(1);
    }
  });
});

// ── fuseTwo ───────────────────────────────────────────────────────────────────
describe('fuseTwo', () => {
  it('fusing identical opinions stays consistent', () => {
    const op = signalToOpinion(sig(0.7, 0.8));
    const fused = fuseTwo(op, op);
    // After fusion, uncertainty should decrease
    expect(fused.uncertainty).toBeLessThan(op.uncertainty);
  });

  it('fusing with vacuous opinion is identity-like (uncertainty→1 is a no-op)', () => {
    const op = signalToOpinion(sig(0.8, 0.9));
    const vacuous = { belief: 0, disbelief: 0, uncertainty: 1, baseRate: SL.BASE_RATE };
    const fused = fuseTwo(op, vacuous);
    expect(fused.belief).toBeCloseTo(op.belief);
    expect(fused.uncertainty).toBeCloseTo(op.uncertainty);
  });

  it('dogmatic fusion (both u=0) averages belief/disbelief', () => {
    const a = { belief: 0.8, disbelief: 0.2, uncertainty: 0, baseRate: 0.5 };
    const b = { belief: 0.4, disbelief: 0.6, uncertainty: 0, baseRate: 0.5 };
    const fused = fuseTwo(a, b);
    expect(fused.belief).toBeCloseTo(0.6);
    expect(fused.disbelief).toBeCloseTo(0.4);
    expect(fused.uncertainty).toBeCloseTo(0);
  });

  it('fused opinion components sum to 1', () => {
    const a = signalToOpinion(sig(0.7, 0.6));
    const b = signalToOpinion(sig(0.4, 0.9));
    const fused = fuseTwo(a, b);
    expect(fused.belief + fused.disbelief + fused.uncertainty).toBeCloseTo(1);
  });
});

// ── fuseOpinions ──────────────────────────────────────────────────────────────
describe('fuseOpinions', () => {
  it('empty array → vacuous opinion', () => {
    const op = fuseOpinions([]);
    expect(op.uncertainty).toBe(1);
    expect(op.belief).toBe(0);
  });

  it('single opinion passthrough', () => {
    const op = signalToOpinion(sig(0.7, 0.8));
    expect(fuseOpinions([op])).toEqual(op);
  });

  it('more signals → lower uncertainty', () => {
    const ops = [0.7, 0.8, 0.75, 0.65].map(s => signalToOpinion(sig(s, 0.8)));
    const fused = fuseOpinions(ops);
    expect(fused.uncertainty).toBeLessThan(ops[0]!.uncertainty);
  });

  it('all high-confidence high-scoring signals → high projected score', () => {
    const ops = [0.9, 0.85, 0.92].map(s => signalToOpinion(sig(s, 0.95)));
    const fused = fuseOpinions(ops);
    expect(projectScore(fused)).toBeGreaterThan(0.8);
  });
});

// ── projectScore ──────────────────────────────────────────────────────────────
describe('projectScore', () => {
  it('perfect belief → score = 1', () => {
    expect(projectScore({ belief: 1, disbelief: 0, uncertainty: 0, baseRate: 0.5 })).toBeCloseTo(1);
  });

  it('vacuous opinion → score = baseRate (0.5)', () => {
    expect(projectScore({ belief: 0, disbelief: 0, uncertainty: 1, baseRate: 0.5 })).toBeCloseTo(0.5);
  });

  it('total disbelief → score = 0', () => {
    expect(projectScore({ belief: 0, disbelief: 1, uncertainty: 0, baseRate: 0.5 })).toBeCloseTo(0);
  });

  it('output is always in [0, 1]', () => {
    const extremes = [
      { belief: 1.5, disbelief: 0, uncertainty: 0, baseRate: 0.5 },
      { belief: 0, disbelief: 1.5, uncertainty: 0, baseRate: 0.5 },
    ];
    for (const op of extremes) {
      const s = projectScore(op);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });
});

// ── evTrustAdjust ─────────────────────────────────────────────────────────────
describe('evTrustAdjust', () => {
  it('single signal → no adjustment', () => {
    expect(evTrustAdjust(0.8, [sig(0.8, 0.9)])).toBe(0.8);
  });

  it('agreeing signals (range < threshold) → no penalty', () => {
    const signals = [sig(0.7, 0.8), sig(0.75, 0.9)]; // range = 0.05
    expect(evTrustAdjust(0.72, signals)).toBeCloseTo(0.72);
  });

  it('disagreeing signals (range > 0.4) → score is reduced', () => {
    const signals = [sig(0.1, 0.9), sig(0.9, 0.9)]; // range = 0.8
    const adjusted = evTrustAdjust(0.5, signals);
    expect(adjusted).toBeLessThan(0.5);
  });

  it('Ev-Trust penalty formula: score * (1 - λ * range)', () => {
    const signals = [sig(0.0, 0.9), sig(1.0, 0.9)]; // range = 1.0
    const score = 0.5;
    const expected = score * (1 - EV_TRUST.LAMBDA * 1.0); // 0.5 * 0.85 = 0.425
    expect(evTrustAdjust(score, signals)).toBeCloseTo(expected);
  });

  it('penalty never makes score negative', () => {
    const signals = [sig(0.0, 1.0), sig(1.0, 1.0)];
    expect(evTrustAdjust(0.01, signals)).toBeGreaterThanOrEqual(0);
  });
});

// ── mapRiskLevel ──────────────────────────────────────────────────────────────
describe('mapRiskLevel', () => {
  const cases: [number, string][] = [
    [1.0,            'minimal'],
    [RISK.MINIMAL,   'minimal'],
    [0.79,           'low'],
    [RISK.LOW,       'low'],
    [0.59,           'medium'],
    [RISK.MEDIUM,    'medium'],
    [0.39,           'high'],
    [RISK.HIGH,      'high'],
    [0.19,           'critical'],
    [0.0,            'critical'],
  ];

  it.each(cases)('score %f → %s', (score, expected) => {
    expect(mapRiskLevel(score)).toBe(expected);
  });
});

// ── mapRecommendation ─────────────────────────────────────────────────────────
describe('mapRecommendation', () => {
  it('minimal risk → allow', () => expect(mapRecommendation('minimal', 0.9)).toBe('allow'));
  it('low risk, high score → install', () => expect(mapRecommendation('low', 0.75)).toBe('install'));
  it('low risk, low score → allow', () => expect(mapRecommendation('low', 0.65)).toBe('allow'));
  it('medium risk → review', () => expect(mapRecommendation('medium', 0.5)).toBe('review'));
  it('high risk → caution', () => expect(mapRecommendation('high', 0.3)).toBe('caution'));
  it('critical risk → deny', () => expect(mapRecommendation('critical', 0.1)).toBe('deny'));
});

// ── applyContextMultiplier ────────────────────────────────────────────────────
describe('applyContextMultiplier', () => {
  it('non-sensitive action → no change', () => {
    expect(applyContextMultiplier('minimal', 'query')).toBe('minimal');
    expect(applyContextMultiplier('low', undefined)).toBe('low');
  });

  it('transact escalates risk by one step', () => {
    expect(applyContextMultiplier('minimal',  'transact')).toBe('low');
    expect(applyContextMultiplier('low',      'transact')).toBe('medium');
    expect(applyContextMultiplier('medium',   'transact')).toBe('high');
    expect(applyContextMultiplier('high',     'transact')).toBe('critical');
  });

  it('delegate escalates risk by one step', () => {
    expect(applyContextMultiplier('low', 'delegate')).toBe('medium');
  });

  it('critical stays critical under any action', () => {
    expect(applyContextMultiplier('critical', 'transact')).toBe('critical');
    expect(applyContextMultiplier('critical', 'delegate')).toBe('critical');
  });
});

// ── detectEntityType ──────────────────────────────────────────────────────────
describe('detectEntityType', () => {
  it('erc8004 → agent', () => expect(detectEntityType('erc8004', '19077')).toBe('agent'));
  it('twitter → agent', () => expect(detectEntityType('twitter', 'handle')).toBe('agent'));
  it('moltbook → agent', () => expect(detectEntityType('moltbook', 'agent-x')).toBe('agent'));
  it('github owner/repo → repo', () => expect(detectEntityType('github', 'owner/repo')).toBe('repo'));
  it('github owner only → developer', () => expect(detectEntityType('github', 'tankcdr')).toBe('developer'));
  it('clawhub skill/weather → skill', () => expect(detectEntityType('clawhub', 'skill/weather')).toBe('skill'));
  it('clawhub author → developer', () => expect(detectEntityType('clawhub', 'tankcdr')).toBe('developer'));
  it('unknown namespace → unknown', () => expect(detectEntityType('foobar', 'anything')).toBe('unknown'));
});
