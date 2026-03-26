import { parseArgs } from 'node:util';
import {
  score as sdkScore,
  attest as sdkAttest,
  behavioral as sdkBehavioral,
  gate as sdkGate,
  configure,
  TrustGateError,
  TrstLyrError,
} from '@trstlyr/sdk';
import type { TrustScore, Attestation, BehavioralResult } from '@trstlyr/sdk';

// ── Color helpers (TTY-only) ──

const isTTY = process.stdout.isTTY ?? false;

const c = {
  bold:    (s: string) => isTTY ? `\x1b[1m${s}\x1b[0m` : s,
  dim:     (s: string) => isTTY ? `\x1b[2m${s}\x1b[0m` : s,
  green:   (s: string) => isTTY ? `\x1b[32m${s}\x1b[0m` : s,
  yellow:  (s: string) => isTTY ? `\x1b[33m${s}\x1b[0m` : s,
  red:     (s: string) => isTTY ? `\x1b[31m${s}\x1b[0m` : s,
  cyan:    (s: string) => isTTY ? `\x1b[36m${s}\x1b[0m` : s,
};

// ── Formatters ──

function riskIndicator(score: number, riskLevel: string, recommendation: string): string {
  if (score >= 60) return `${c.green('✅')} ${c.bold(String(score))}/100 · ${c.green(riskLevel)} · ${recommendation}`;
  if (score >= 30) return `${c.yellow('⚠️')}  ${c.bold(String(score))}/100 · ${c.yellow(riskLevel)} · ${recommendation}`;
  return `${c.red('🚫')} ${c.bold(String(score))}/100 · ${c.red(riskLevel)} · ${recommendation}`;
}

function formatScore(result: TrustScore): string {
  const lines = [
    riskIndicator(result.trust_score, result.risk_level, result.recommendation),
    '',
    `  Subject:      ${c.cyan(result.subject)}`,
    `  Entity type:  ${result.entity_type}`,
    `  Confidence:   ${result.confidence}`,
    `  Signals used: ${result.signals.length}`,
    `  Evaluated:    ${result.evaluated_at}`,
  ];
  if (result.fraud_signals.length > 0) {
    lines.push(`  ${c.red('Fraud signals:')} ${result.fraud_signals.length}`);
  }
  return lines.join('\n');
}

function scoreJson(result: TrustScore): object {
  return {
    subject: result.subject,
    trust_score: result.trust_score,
    risk_level: result.risk_level,
    recommendation: result.recommendation,
    confidence: result.confidence,
    signals_used: result.signals.length,
  };
}

function formatAttestation(result: Attestation): string {
  const lines = [
    riskIndicator(result.trust_score, result.risk_level, result.recommendation),
    '',
    `  Subject:          ${c.cyan(result.subject)}`,
    `  On-chain:         ${result.on_chain ? c.green('yes') : 'no'}`,
    `  Attestation UID:  ${result.attestation_uid ?? c.dim('none')}`,
    `  Attestation URL:  ${result.attestation_url ?? c.dim('none')}`,
    `  Signals used:     ${result.signals_used}`,
  ];
  return lines.join('\n');
}

function formatBehavioral(result: BehavioralResult): string {
  const lines = [
    `  Subject:          ${c.cyan(result.subject)}`,
    `  Outcome:          ${result.outcome}`,
    `  Attestation UID:  ${result.attestationUID ?? c.dim('none')}`,
    `  Tx hash:          ${result.txHash ?? c.dim('none')}`,
  ];
  if (result.eas_error) {
    lines.push(`  ${c.yellow('EAS error:')}       ${result.eas_error}`);
  }
  return lines.join('\n');
}

// ── Help ──

const USAGE = `
${c.bold('trstlyr')} — CLI for checking agent trust scores via TrstLyr

${c.bold('USAGE')}
  trstlyr <command> [options]

${c.bold('COMMANDS')}
  score <subject>          Query trust score (exit 0 always)
  gate <subject>           Trust gate — exit 0 if pass, exit 1 if fail
  attest <subject>         Score + anchor EAS attestation on Base
  behavioral <subject>     Post behavioral attestation after interaction
  help                     Show this help

${c.bold('GLOBAL OPTIONS')}
  --json                   Output raw JSON instead of human-readable
  --help, -h               Show this help

${c.bold('GATE OPTIONS')}
  --min-score <N>          Minimum trust score (default: 60)
  --strict                 Exit 2 on API error (default: fail-open)

${c.bold('BEHAVIORAL OPTIONS')}
  --outcome <value>        success | failure | dispute  (required)
  --rating <N>             1-5  (required)
  --value <N>              USD value of interaction
  --attestor <subject>     Who is attesting

${c.bold('SUBJECT FORMATS')}
  erc8004:<id>             ERC-8004 agent
  github:<user>            GitHub user
  moltbook:<handle>        Moltbook handle
  clawhub:<skill>          ClawHub skill
  twitter:<handle>         Twitter handle

${c.bold('EXAMPLES')}
  trstlyr score github:vbuterin
  trstlyr gate erc8004:31977 --min-score 60
  trstlyr attest erc8004:31977
  trstlyr behavioral erc8004:31977 --outcome success --rating 5 --value 100

${c.bold('EXIT CODES')}
  0  Success / gate passed
  1  Gate failed (score below threshold)
  2  API error with --strict
`;

// ── Command handlers ──

async function cmdScore(subject: string, json: boolean): Promise<void> {
  const result = await sdkScore(subject);
  if (json) {
    console.log(JSON.stringify(scoreJson(result), null, 2));
  } else {
    console.log(formatScore(result));
  }
}

async function cmdGate(subject: string, minScore: number, strict: boolean, json: boolean): Promise<void> {
  try {
    const result = await sdkGate(subject, { minScore, strictMode: strict });
    if (json) {
      console.log(JSON.stringify(scoreJson(result), null, 2));
    } else {
      console.log(formatScore(result));
    }
  } catch (err) {
    if (err instanceof TrustGateError) {
      const msg = `Trust gate failed: ${subject} scored ${err.trustScore}, threshold ${err.threshold}`;
      if (json) {
        console.error(JSON.stringify({ error: msg, subject, score: err.trustScore, threshold: err.threshold }));
      } else {
        console.error(c.red(msg));
      }
      process.exit(1);
    }
    if (strict && err instanceof TrstLyrError) {
      const msg = `API error: ${err.message}`;
      if (json) {
        console.error(JSON.stringify({ error: msg }));
      } else {
        console.error(c.red(msg));
      }
      process.exit(2);
    }
    throw err;
  }
}

async function cmdAttest(subject: string, json: boolean): Promise<void> {
  const result = await sdkAttest(subject);
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatAttestation(result));
  }
}

async function cmdBehavioral(
  subject: string,
  outcome: string,
  rating: number,
  value: number | undefined,
  _attestor: string | undefined,
  json: boolean,
): Promise<void> {
  const result = await sdkBehavioral({
    subject,
    outcome: outcome as 'success' | 'partial' | 'failed',
    rating,
    value_usd: value,
  });
  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(formatBehavioral(result));
  }
}

// ── Main ──

export async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      json:       { type: 'boolean', default: false },
      help:       { type: 'boolean', short: 'h', default: false },
      'min-score': { type: 'string' },
      strict:     { type: 'boolean', default: false },
      outcome:    { type: 'string' },
      rating:     { type: 'string' },
      value:      { type: 'string' },
      attestor:   { type: 'string' },
    },
    allowPositionals: true,
  });

  const jsonOutput = values.json as boolean;
  const command = positionals[0];
  const subject = positionals[1];

  // Configure SDK from env
  const apiKey = process.env['TRSTLYR_API_KEY'];
  if (apiKey) configure({ apiKey });

  if (values.help || command === 'help' || !command) {
    console.log(USAGE);
    return;
  }

  if (!subject && command !== 'help') {
    console.error('Error: <subject> is required. Run `trstlyr help` for usage.');
    process.exit(1);
  }

  switch (command) {
    case 'score':
      await cmdScore(subject, jsonOutput);
      break;

    case 'gate': {
      const minScore = values['min-score'] ? parseInt(values['min-score'] as string, 10) : 60;
      await cmdGate(subject, minScore, values.strict as boolean, jsonOutput);
      break;
    }

    case 'attest':
      await cmdAttest(subject, jsonOutput);
      break;

    case 'behavioral': {
      const outcome = values.outcome as string | undefined;
      const ratingStr = values.rating as string | undefined;
      if (!outcome || !ratingStr) {
        console.error('Error: --outcome and --rating are required for behavioral command.');
        process.exit(1);
      }
      const rating = parseInt(ratingStr, 10);
      const value = values.value ? parseFloat(values.value as string) : undefined;
      await cmdBehavioral(subject, outcome, rating, value, values.attestor as string | undefined, jsonOutput);
      break;
    }

    default:
      console.error(`Unknown command: ${command}. Run \`trstlyr help\` for usage.`);
      process.exit(1);
  }
}
