---
name: trstlyr-cli
description: Use the `trstlyr` CLI binary to check agent trust scores, run trust gates, anchor on-chain attestations, and post behavioral attestations from the shell. Use when an agent needs to verify counterparty trust before transactions, add trust gates to CI pipelines, or perform agent-to-agent trust checks in shell workflows.
---

# @trstlyr/cli

Standalone CLI binary wrapping `@trstlyr/sdk`. Zero dependencies beyond the SDK.

## Install

```bash
npm install -g @trstlyr/cli
# or
npx @trstlyr/cli score github:vbuterin
```

## Commands

### score — Query trust score

```bash
trstlyr score github:vbuterin
trstlyr score erc8004:31977 --json
```

Exit 0 always (score is informational). Output includes trust_score, risk_level, recommendation, confidence, and signals_used.

### gate — Trust gate

```bash
trstlyr gate erc8004:31977 --min-score 60
trstlyr gate github:vbuterin               # default threshold: 60
trstlyr gate erc8004:31977 --strict         # exit 2 on API error
```

Use in CI or scripts to block on low trust:

```bash
trstlyr gate erc8004:31977 --min-score 70 || exit 1
```

### attest — On-chain attestation

```bash
trstlyr attest erc8004:31977
```

Scores the subject and anchors an EAS attestation on Base. Prints attestation_uid and attestation_url.

### behavioral — Post behavioral attestation

```bash
trstlyr behavioral erc8004:31977 --outcome success --rating 5 --value 100
trstlyr behavioral erc8004:31977 --outcome failure --rating 1
```

Required flags: `--outcome` (success|failure|dispute), `--rating` (1-5).
Optional: `--value` (USD value), `--attestor` (attesting subject).

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success / gate passed |
| 1 | Gate failed — score below threshold |
| 2 | API error with `--strict` flag |

## Global Options

| Flag | Effect |
|------|--------|
| `--json` | Output raw JSON instead of human-readable |
| `--help`, `-h` | Show usage |

## Environment

| Variable | Purpose |
|----------|---------|
| `TRSTLYR_API_KEY` | Optional API key for higher rate limits |

## Notes

- **Fail-open by default**: if the API is unreachable, `gate` passes silently. Use `--strict` to exit 2 instead.
- Human-readable output includes color and risk indicators (✅ ⚠️ 🚫) when stdout is a TTY. Piped output is plain text.
- `--json` is ideal for parsing in scripts: `trstlyr score github:vbuterin --json | jq .trust_score`
