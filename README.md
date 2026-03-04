# TrstLyr Protocol

**The trust layer for the agent internet.**

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![Live](https://img.shields.io/badge/status-live-brightgreen)](https://trstlyr.ai)
[![ERC-8004](https://img.shields.io/badge/ERC--8004-compatible-green)](https://eips.ethereum.org/EIPS/eip-8004)
[![EAS](https://img.shields.io/badge/attestation-EAS%20on%20Base-purple)](https://attest.org)

---

TrstLyr answers one question: **"How much should I trust this agent or skill?"**

It is the **Gitcoin Passport for agents** — aggregating trust signals from GitHub, Twitter/X, ClawHub, ERC-8004 (on-chain), and Moltbook into a single, portable, evidence-backed trust score. No wallet required to start. Progressive security as stakes increase.

```bash
curl https://api.trstlyr.ai/v1/trust/score/github:tankcdr
```

```json
{
  "subject": "github:tankcdr",
  "trust_score": 50.1,
  "confidence": 0.72,
  "risk_level": "medium",
  "recommendation": "review",
  "signals": [...]
}
```

---

## The Problem

A credential stealer was discovered on ClawHub in January 2026 disguised as a weather skill. It read agent credentials from `~/.clawdbot/.env` and exfiltrated them to an external webhook. Detection was accidental.

This is not a ClawHub problem. It is an ecosystem problem:

- **Skills are unsigned.** Anyone can publish. No identity verification, no audit trail.
- **Agents have no reputation.** MCP tool calls, A2A task delegations, ClawHub installs — none build verifiable history.
- **There is no cross-platform standard.** A high-reputation Moltbook agent is unknown to ClawHub. An ERC-8004 registered agent is invisible to Twitter.

The agent internet is growing faster than its trust infrastructure. TrstLyr is that infrastructure.

---

## Why Not Just Use ERC-8004?

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) is excellent — TrstLyr consumes it as a signal source. But ERC-8004 itself states: *"We expect reputation systems around reviewers/clientAddresses to emerge."*

**TrstLyr is that system.**

| | ERC-8004 | TrstLyr |
|---|---|---|
| Web2 signals (GitHub, Twitter) | ❌ | ✅ |
| No wallet required | ❌ | ✅ |
| Pluggable signal providers | ❌ | ✅ |
| Fraud detection | ❌ | ✅ |
| Context-aware scoring | ❌ | ✅ |
| EAS attestation anchoring | ❌ | ✅ |
| Identity verification flow | ❌ | ✅ |

TrstLyr is the aggregation layer above ERC-8004 — not a replacement.

---

## How It Works

```
┌──────────────────────────────────────────────┐
│              Trust Query API                 │
│   POST /v1/trust/query   ·   Anonymous OK    │
└──────────────────┬───────────────────────────┘
                   │
┌──────────────────▼───────────────────────────┐
│          Trust Aggregation Engine            │
│                                              │
│  Subjective Logic opinion fusion             │
│  (belief, disbelief, uncertainty)            │
│                                              │
│  Ev-Trust evolutionary stability penalty     │
│  Context-aware weight adjustment             │
└──────────────────┬───────────────────────────┘
                   │
      ┌────────────┼─────────────┐
      ▼            ▼             ▼
 ┌─────────┐  ┌─────────┐  ┌──────────┐
 │  Web2   │  │  Web3   │  │ Identity │
 │ Signals │  │ Signals │  │  Graph   │
 ├─────────┤  ├─────────┤  ├──────────┤
 │ GitHub  │  │ERC-8004 │  │ Twitter  │
 │ ClawHub │  │  EAS    │  │ GitHub   │
 │Moltbook │  │  x402   │  │ Wallet   │
 │ Twitter │  │         │  │          │
 └─────────┘  └─────────┘  └──────────┘
                   │
┌──────────────────▼───────────────────────────┐
│           EAS Attestation (Base L2)          │
│   On-chain anchor · ~$0.01 per attestation   │
└──────────────────────────────────────────────┘
```

### Trust is not a number — it is an opinion

TrstLyr uses **Subjective Logic** (Jøsang, 2001) internally. Trust is expressed as `(belief, disbelief, uncertainty)` — distinguishing "no data yet" from "conflicting evidence." The API surfaces this as `trust_score` + `confidence`.

### Honest behavior is the dominant strategy

The scoring model incorporates **Ev-Trust** dynamics (Wang et al., arXiv:2512.16167): an evolutionary stability penalty makes gaming the system mathematically unprofitable compared to consistent honest behavior.

---

## Key Features

- **One API, all signal sources** — GitHub, ClawHub, ERC-8004, Twitter, Moltbook. Query once; TrstLyr fans out.
- **Identity verification** — Agents prove ownership of Twitter, GitHub, or on-chain identities. Verified identities get richer signals.
- **Progressive trust** — Low-stakes interactions use web2 signals. High-stakes require on-chain attestations.
- **MCP native** — Drop-in trust oracle for Claude Desktop and any MCP-compatible runtime.
- **EAS attestations** — Anchor any trust score on Base Mainnet. First one free, then $0.01 USDC via x402.
- **Protocol, not product** — Open spec (Apache 2.0). Embed it; extend it; run your own instance.

---

## Quick Start

```bash
# Query a trust score (free, no key needed)
curl https://api.trstlyr.ai/v1/trust/score/github:tankcdr

# Register your agent identity (no API key required)
curl -X POST https://api.trstlyr.ai/v1/identity/register \
  -H "Content-Type: application/json" \
  -d '{ "subject": { "namespace": "github", "id": "your-handle" } }'

# Anchor a score on-chain — 1 free per subject, $0.01 USDC via x402 after
curl -X POST https://api.trstlyr.ai/v1/attest \
  -H "Content-Type: application/json" \
  -d '{ "subject": "github:tankcdr" }'

# Self-host
git clone https://github.com/tankcdr/aegis && cd aegis
cp .env.example .env
docker compose up -d
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [**skill.md**](skill.md) | Agent-readable docs — start here if you're an agent |
| [**Protocol Specification**](docs/SPEC.md) | Full spec — scoring model, fraud detection, governance |
| [Architecture](docs/ARCHITECTURE.md) | Component design, data flow, deployment models |
| [Signal Providers](docs/PROVIDERS.md) | How to build and register a provider |

---

## Project Status

| Phase | Milestone | Status |
|-------|-----------|--------|
| 1 | Core API · GitHub · ERC-8004 · ClawHub · EAS · MCP · Identity verification · x402 | ✅ Live |
| 2 | Disputes · Behavioral signals · EigenTrust · Twitter · Persistent graph | 🔜 Next |
| 3 | Decentralized signals · Cross-chain · zkProofs · Governance | Planned |

Built for the [Synthesis Hackathon](https://nsb.dev/synthesis-updates) (March 2026).

---

## Related Work

- [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) — On-chain agent identity. TrstLyr is the aggregation layer above it.
- [EAS](https://attest.org) — Ethereum Attestation Service. Used for on-chain trust anchoring on Base L2.
- [x402](https://www.x402.org) — HTTP-native payments. Used for pay-per-attestation.
- [Ev-Trust](https://arxiv.org/abs/2512.16167) — Wang et al. (2025). Evolutionary stable trust for LLM-based agent economies.
- [OpenClaw](https://github.com/openclaw/openclaw) — Agent runtime. TrstLyr is a proposed foundation project.
- [ClawHub](https://clawhub.com) — Skill marketplace. Signal provider.
- [Moltbook](https://moltbook.com) — Agent social network. Signal provider.

---

## Contributing

- Open an issue with feedback, edge cases, or new signal provider proposals
- Submit a PR for fixes or clarifications
- Implement a signal provider (see [Signal Providers](docs/PROVIDERS.md))

**Discussion:** [OpenClaw Discord](https://discord.com/invite/clawd)

---

## Known Gotchas

### ERC-8004 Token Ownership When Registered via a Platform

If your agent is registered on ERC-8004 **through a third-party platform** (e.g. a hackathon, an onboarding service), the platform wallet — not your agent's wallet — owns the token. This means:

- You **cannot** call `setAgentURI(tokenId, newURI)` directly to update your services, metadata, or endpoints.
- Your `service_diversity` score in TrstLyr will be `0` until services are registered, even if you publish an A2A card or MCP endpoint off-chain.

**How to check who owns your token:**
```bash
# ownerOf(uint256) — selector 0x6352211e
cast call 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432 \
  "ownerOf(uint256)(address)" <YOUR_AGENT_ID> \
  --rpc-url https://mainnet.base.org
```

**Options:**
1. Ask the platform to add a metadata update API endpoint or transfer token ownership to your wallet.
2. Self-register a new ERC-8004 token from your own wallet using the registry directly — you will own it and can call `setAgentURI` freely.
3. If using TrstLyr for scoring, register your A2A endpoint (`/.well-known/agent.json`) and MCP endpoint (`/skill.md`) — TrstLyr will detect them as service signals regardless of on-chain registration.

**Self-registration example** (ethers.js):
```js
const ABI = ['function register(string uri) returns (uint256)'];
const registry = new ethers.Contract('0x8004A169FB4a3325136EB29fA0ceB6D2e539a432', ABI, wallet);
const tokenId = await registry.register('data:application/json;base64,...');
```

> Note: The exact register function signature may vary by registry deployment. Check the contract ABI on Basescan.

## License

**Open Core** — two tiers:

| Component | License |
|-----------|---------|
| `packages/core`, `packages/mcp`, `apps/api`, `apps/web` | [Apache 2.0](LICENSE) — free forever, self-hostable |
| `packages/core-ee`, `apps/api-ee` | [BSL 1.1](LICENSE-EE) — converts to Apache 2.0 after 4 years |

Enterprise licensing: chris@trstlyr.ai — see [LICENSE](LICENSE).

Built by [Chris Madison](https://github.com/tankcdr) · Powered by Charon ⛵
