#!/usr/bin/env npx tsx
/**
 * Autonomous Trust Scoring Loop
 *
 * Fetches agents from HOL.org API (or uses hardcoded fallback list),
 * scores each via AegisEngine, and logs attestation-eligibility decisions.
 *
 * Usage:
 *   npx tsx scripts/autonomous-loop.ts            # live run
 *   npx tsx scripts/autonomous-loop.ts --dry-run   # no writes to agent_log.json
 */

import { AegisEngine } from '@aegis-protocol/core';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// ── Config ──────────────────────────────────────────────────────────────────

const HOL_API = 'https://hol.org/registry/api/v1/search?limit=20&sort=newest';
const LOG_PATH = resolve(import.meta.dirname ?? '.', '..', 'agent_log.json');
const DRY_RUN = process.argv.includes('--dry-run');

/** Known ERC-8004 agent IDs — fallback when HOL.org is unreachable */
const FALLBACK_AGENTS: string[] = [
  'erc8004:31977',   // TrstLyr / Charon
  'erc8004:19077',   // TrstLyr (legacy Synthesis-custodied)
  'erc8004:1',
  'erc8004:42',
  'erc8004:100',
  'erc8004:256',
  'erc8004:500',
  'erc8004:1000',
  'erc8004:2000',
  'erc8004:5000',
];

// ── Types ───────────────────────────────────────────────────────────────────

interface HolAgent {
  id?: string;
  agentId?: number;
  name?: string;
  protocol?: string;
}

interface LoopDecision {
  timestamp: string;
  subject: string;
  trust_score: number;
  confidence: number;
  risk_level: string;
  decision: 'attest_eligible' | 'skipped';
  reason: string;
  dry_run: boolean;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function fetchAgentSubjects(): Promise<string[]> {
  try {
    const res = await fetch(HOL_API, {
      signal: AbortSignal.timeout(8_000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`HOL API ${res.status}`);
    const body = (await res.json()) as { agents?: HolAgent[]; data?: HolAgent[] };
    const agents = body.agents ?? body.data ?? [];
    const subjects = agents
      .map((a) => {
        if (a.protocol === 'erc8004' && a.agentId != null) return `erc8004:${a.agentId}`;
        if (a.id) return a.id;
        return null;
      })
      .filter((s): s is string => s !== null);

    if (subjects.length > 0) {
      console.log(`✓ Fetched ${subjects.length} agents from HOL.org`);
      return subjects;
    }
    throw new Error('Empty agent list from HOL');
  } catch (err) {
    console.log(`⚠ HOL.org unavailable (${err instanceof Error ? err.message : err}), using fallback list`);
    return FALLBACK_AGENTS;
  }
}

function parseSubject(raw: string): { namespace: string; id: string } {
  const colon = raw.indexOf(':');
  if (colon === -1) return { namespace: 'erc8004', id: raw };
  return { namespace: raw.slice(0, colon), id: raw.slice(colon + 1) };
}

function appendToLog(decisions: LoopDecision[]): void {
  if (DRY_RUN) return;

  let log: Record<string, unknown> & { entries?: unknown[] } = { entries: [] };
  if (existsSync(LOG_PATH)) {
    try {
      log = JSON.parse(readFileSync(LOG_PATH, 'utf-8'));
    } catch {
      log = { entries: [] };
    }
  }

  const entry = {
    timestamp: new Date().toISOString(),
    type: 'autonomous_loop',
    title: `Autonomous scoring loop — ${decisions.length} agents evaluated`,
    description: `Scored ${decisions.length} agents. ` +
      `${decisions.filter((d) => d.decision === 'attest_eligible').length} attest-eligible, ` +
      `${decisions.filter((d) => d.decision === 'skipped').length} skipped.`,
    tools_used: ['AegisEngine.query', 'HOL.org API'],
    outcome: decisions.map((d) => `${d.subject}: ${d.decision} (${d.trust_score})`).join('; '),
    autonomous: true,
    decisions,
  };

  if (!Array.isArray(log.entries)) log.entries = [];
  log.entries.push(entry);
  writeFileSync(LOG_PATH, JSON.stringify(log, null, 2) + '\n');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n🔄 TrstLyr Autonomous Scoring Loop${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const subjects = await fetchAgentSubjects();
  const engine = new AegisEngine();
  const decisions: LoopDecision[] = [];

  for (const raw of subjects) {
    const { namespace, id } = parseSubject(raw);
    try {
      const result = await engine.query({
        subject: { type: 'agent', namespace, id },
        context: { action: 'transact' },
      });

      const eligible =
        result.trust_score >= 65 &&
        result.risk_level !== 'high' &&
        result.risk_level !== 'critical';

      const decision: LoopDecision = {
        timestamp: new Date().toISOString(),
        subject: raw,
        trust_score: result.trust_score,
        confidence: result.confidence,
        risk_level: result.risk_level,
        decision: eligible ? 'attest_eligible' : 'skipped',
        reason: eligible
          ? `score=${result.trust_score} risk=${result.risk_level}`
          : result.trust_score < 65
            ? `score ${result.trust_score} < 65`
            : `risk_level=${result.risk_level}`,
        dry_run: DRY_RUN,
      };

      decisions.push(decision);
      const icon = eligible ? '✅' : '⏭️';
      console.log(
        `  ${icon} ${raw.padEnd(20)} score=${result.trust_score.toFixed(1).padStart(5)}  ` +
        `risk=${result.risk_level.padEnd(8)}  → ${decision.decision}`
      );
    } catch (err) {
      console.log(`  ❌ ${raw.padEnd(20)} error: ${err instanceof Error ? err.message : err}`);
      decisions.push({
        timestamp: new Date().toISOString(),
        subject: raw,
        trust_score: 0,
        confidence: 0,
        risk_level: 'unknown',
        decision: 'skipped',
        reason: `error: ${err instanceof Error ? err.message : err}`,
        dry_run: DRY_RUN,
      });
    }
  }

  // Persist
  appendToLog(decisions);

  // Summary
  const eligible = decisions.filter((d) => d.decision === 'attest_eligible');
  const skipped = decisions.filter((d) => d.decision === 'skipped');
  console.log(`\n── Summary ──────────────────────────────`);
  console.log(`  Total evaluated : ${decisions.length}`);
  console.log(`  Attest-eligible : ${eligible.length}`);
  console.log(`  Skipped         : ${skipped.length}`);
  if (DRY_RUN) console.log(`  Mode            : DRY RUN (no log writes)`);
  else console.log(`  Log written to  : ${LOG_PATH}`);
  console.log('');
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
