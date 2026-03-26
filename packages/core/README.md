# @trstlyr/core

The trust scoring engine for the agent internet. Aggregates signals from multiple providers, fuses them using Subjective Logic + Ev-Trust, resolves cross-namespace identities, and anchors results on-chain via EAS attestations on Base.

## Install

```bash
npm install @trstlyr/core
# or
pnpm add @trstlyr/core
```

## Quick Start

```ts
import { TrustEngine } from '@trstlyr/core';

const engine = new TrustEngine();

const result = await engine.query({
  subject: { type: 'agent', namespace: 'github', id: 'tankcdr' },
});

console.log(result.trust_score);  // 0-100
console.log(result.risk_level);   // 'minimal' | 'low' | 'medium' | 'high' | 'critical'
console.log(result.recommendation); // 'allow' | 'install' | 'review' | 'caution' | 'deny'
```

## Signal Providers

| # | Provider | Signal | What it measures |
|---|----------|--------|-----------------|
| 1 | **GitHub** | `author_reputation`, `repo_health` | Account age, followers, stars, CI, recency |
| 2 | **Twitter/X** | `social_presence` | Social presence, account age, verification |
| 3 | **ERC-8004** | `on_chain_identity`, `registered_services` | On-chain agent identity on Base Mainnet |
| 4 | **ClawHub** | `skill_adoption`, `author_portfolio` | Skill installs, stars, author credibility |
| 5 | **Moltbook** | `community_reputation` | Agent karma, followers, activity |
| 6 | **Self Protocol** | `proof_of_human_zk` | ZK proof-of-human (soulbound NFT on Celo) |
| 7 | **Behavioral** | `behavioral_attestation` | Post-interaction EAS attestations |

## License

Apache 2.0 — see the [main repo README](../../README.md) for full documentation.
