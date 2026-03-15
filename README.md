# TrstLyr Protocol

**Before your agent trusts another agent with money, code, or data — it checks TrstLyr.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/API-live-brightgreen)](https://api.trstlyr.ai)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-compatible-green)](https://eips.ethereum.org/EIPS/eip-8004)
[![EAS](https://img.shields.io/badge/attestation-EAS%20on%20Base-purple)](https://attest.org)

TrstLyr is the trust layer for the agent internet. It aggregates signals from GitHub, ERC-8004, Twitter/X, Self Protocol ZK proof-of-human, ClawHub, and Moltbook into verifiable trust scores — anchored on-chain via EAS on Base. Open source, Apache 2.0, free to query.

---

## Try it now

```bash
curl https://api.trstlyr.ai/v1/trust/score/github:yourusername
```

```json
{
  "subject": "github:yourusername",
  "trust_score": 50.1,
  "confidence": 0.72,
  "risk_level": "medium",
  "recommendation": "review",
  "signals": [ "..." ]
}
```

No API key. No wallet. No signup.

---

## Why it matters

- **Agents are making real decisions with real money.** A credential stealer disguised as a weather skill sat on ClawHub for weeks before accidental discovery. There is no trust infrastructure — until now.
- **No single signal is enough.** A fresh GitHub account can have an on-chain ERC-8004 token. A high-karma Moltbook agent can be a Sybil. TrstLyr fuses signals from 6 providers and makes honest behavior the mathematically dominant strategy (Ev-Trust, [arXiv:2512.16167](https://arxiv.org/abs/2512.16167)).
- **Trust should be infrastructure, not a product.** Like DNS or SSL, trust is a public good. Free core API. Self-hostable. Apache 2.0 forever.

---

## Quick start

### REST API

```bash
# Trust score (free, no key)
curl https://api.trstlyr.ai/v1/trust/score/github:tankcdr

# Pre-action trust gate — should my agent proceed?
curl -X POST https://api.trstlyr.ai/v1/trust/gate \
  -H "Content-Type: application/json" \
  -d '{"subject":"github:tankcdr","action":"delegate"}'

# Anchor score on-chain (1st free, then $0.01 USDC via x402)
curl -X POST https://api.trstlyr.ai/v1/attest \
  -H "Content-Type: application/json" \
  -d '{"subject":"github:tankcdr"}'
```

### MCP (Claude Desktop / any MCP runtime)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "trstlyr": {
      "command": "npx",
      "args": ["-y", "@aegis-protocol/mcp"]
    }
  }
}
```

Gives your agent three tools: `trust_query`, `should_proceed`, `trust_explain`.

---

## Providers

| Provider | What it measures | Example subject |
|----------|-----------------|-----------------|
| **GitHub** | Author reputation, repo health, contribution age | `github:tankcdr` |
| **ERC-8004** | On-chain agent identity, registered services | `erc8004:32051` |
| **Twitter/X** | Social presence, account age, verification | `twitter:@handle` |
| **Self Protocol** | ZK proof-of-human (soulbound NFT on Celo) | `self:0xWallet` |
| **ClawHub** | Skill installs, stars, author portfolio | `clawhub:author/handle` |
| **Moltbook** | Agent community karma, followers, activity | `moltbook:agentname` |

All providers run in parallel. One query fans out to every applicable provider.

---

## On-chain anchoring

Trust scores are anchored as **EAS attestations on Base Mainnet**.

| Detail | Value |
|--------|-------|
| EAS contract | `0x4200000000000000000000000000000000000021` |
| Schema UID | `0xfff1179b...14d407d` ([view on EASScan](https://base.easscan.org)) |
| Cost | 1st attestation per subject **free**, then **$0.01 USDC** via [x402](https://x402.org) |
| Payment | Non-custodial — agent wallets sign EIP-3009 `transferWithAuthorization` |

**How it works:** Call `POST /v1/attest` with a subject. TrstLyr computes the trust score, serializes it (subject, score, confidence, risk level, signal summary), and submits an on-chain EAS attestation. The attestation UID is returned immediately. After the first free attestation, subsequent calls return HTTP 402 with x402 payment instructions — your agent pays $0.01 USDC and the attestation is created automatically.

---

## Architecture

```
Agent / CLI / Platform
        │
        ▼
   REST API (Fastify)           MCP Server
        │                           │
        ▼                           ▼
   Trust Aggregation Engine
   ├── Identity Resolver (cross-namespace linking)
   ├── Signal Dispatcher (parallel fan-out, 10s timeout)
   ├── Scoring Engine (Subjective Logic + Ev-Trust)
   └── Cache (TTL per signal type)
        │
        ▼
   6 Signal Providers ──► EAS Attestation Bridge (Base L2)
```

Self-host: `git clone https://github.com/tankcdr/aegis && docker compose up -d`

Full details: [Architecture](docs/ARCHITECTURE.md) | [Specification](docs/SPEC.md) | [Provider Guide](docs/PROVIDERS.md)

---

## Contributing

Apache 2.0 — PRs welcome.

**Add a new provider:**
1. Implement the `SignalProvider` interface ([docs](docs/PROVIDERS.md))
2. Register it in the provider index
3. Open a PR with tests and example subjects

Issues, edge cases, signal provider proposals: [GitHub Issues](https://github.com/tankcdr/aegis/issues)

Discussion: [OpenClaw Discord](https://discord.com/invite/clawd)

---

## Status

**Live.** Deployed on Railway. Serving trust queries now.

| | |
|---|---|
| API | [api.trstlyr.ai](https://api.trstlyr.ai) |
| Website | [trstlyr.ai](https://trstlyr.ai) |
| MCP | `@aegis-protocol/mcp` |
| ERC-8004 Agent ID | `32051` (Base Mainnet) |
| License | Apache 2.0 |

Built by [Chris Madison](https://github.com/tankcdr) · Powered by Charon
