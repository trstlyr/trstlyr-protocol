# TrstLyr /discover Endpoint — Design Spec v0.1
*Drafted: 2026-03-06*

---

## The Problem

"90% of AI agents never get used because there's no discovery layer."
— Humayun Sheikh, CEO Fetch.ai

Current protocols answer "what can this agent do?" (A2A cards, MCP metadata, ERC-8004 identity). None answer "should I trust this agent?" with quantified, multi-source evidence. No system today combines cross-registry search with composite trust scoring.

---

## Our Position

TrstLyr sits above the protocol wars. We are not a registry — we are the trust layer on top of all registries. Agents declare themselves via A2A, MCP, ERC-8004, ClawHub, Moltbook, or any protocol. We score them. Consumers query us.

**The integration layer the market is waiting for.**

---

## Architecture

### Data Sources (what we crawl/index)

| Source | Type | What we get |
|---|---|---|
| ERC-8004 Identity Registry | Web3 | On-chain identity, declared services, wallet address |
| ERC-8004 Reputation Registry | Web3 | Raw feedback signals (score, tags, content hashes) |
| EAS attestations (Base) | Web3 | Verifiable attestations about agent behavior |
| A2A Agent Cards (`/.well-known/agent-card.json`) | Web2 | Capabilities, skills, endpoints, auth requirements |
| MCP server cards (SEP-2127 draft) | Web2 | Tool descriptions, server metadata |
| hol.org index | Aggregator | 72,000+ agents across 14 registries — consume don't rebuild |
| ClawHub | Web2 | Skills, stars, downloads, semantic descriptions |
| Moltbook | Web2 | Karma, followers, community activity, claimed status |
| GitHub | Web2 | Repo health, stars, commits, contributor count, issue resolution |

### Trust Scoring (what we compute)

Same Subjective Logic engine as existing TrstLyr scoring — extended with:
- **Trade performance provider** (for trading agents): Brier score, win rate, Sharpe ratio from on-chain resolved trades
- **API uptime provider**: availability signal for agents with declared endpoints
- **Dynamic signals**: continuous monitoring, not point-in-time snapshots — the gap nobody else fills

### Competitive Differentiation

| System | Cross-registry | Web2+Web3 | Composite score | Discovery API |
|---|---|---|---|---|
| OASF/ADS | ✅ | ❌ | ❌ | ✅ |
| hol.org | ✅ | Partial | Rudimentary | ✅ |
| Fetch.ai Almanac | ❌ (Cosmos only) | ❌ | Token stake only | ✅ |
| Mnemom | ❌ | ❌ | ✅ zkVM | ❌ |
| **TrstLyr /discover** | **✅** | **✅** | **✅ Subjective Logic** | **✅** |

---

## API Spec

### `GET /v1/discover`

Find agents by capability, filtered and ranked by trust score.

**Query Parameters**

| Param | Type | Description |
|---|---|---|
| `q` | string | Free-text capability search (semantic, not keyword) |
| `min_score` | number | Minimum trust score 0–100 |
| `max_score` | number | Maximum trust score |
| `protocol` | string | Filter by protocol: `a2a`, `mcp`, `erc8004`, `acp` |
| `provider` | string | Filter by signal source: `github`, `moltbook`, `clawhub`, `erc8004`, `twitter` |
| `claimed` | boolean | Only return claimed/verified agents |
| `capability` | string | Structured capability tag (e.g. `forecasting`, `trading`, `yield`) |
| `min_confidence` | number | Minimum scoring confidence 0–1 |
| `limit` | number | Max results (default 20, max 100) |
| `offset` | number | Pagination offset |

**Response**

```json
{
  "agents": [
    {
      "id": "erc8004:42",
      "name": "erebus",
      "trust_score": 84.2,
      "confidence": 0.88,
      "claimed": true,
      "protocols": ["erc8004", "a2a"],
      "capabilities": ["forecasting", "trading", "polymarket"],
      "providers": {
        "moltbook": { "karma": 33, "followers": 28, "claimed": true },
        "github": { "stars": 12, "repos": 4, "commit_frequency": "high" },
        "erc8004": { "registry_id": "42", "services": ["forecasting"] }
      },
      "endpoints": {
        "a2a_card": "https://erebus.ai/.well-known/agent-card.json",
        "trust_gate": "https://api.trstlyr.ai/v1/trust/gate",
        "trust_score": "https://api.trstlyr.ai/v1/trust/score/erc8004:42"
      },
      "last_updated": "2026-03-06T18:00:00Z"
    }
  ],
  "total": 47,
  "limit": 20,
  "offset": 0,
  "query_ms": 84
}
```

---

### `GET /v1/discover/protocols`

List all indexed protocols and agent counts.

### `GET /v1/discover/capabilities`

List all known capability tags with agent counts — helps consumers know what to search for.

---

## Implementation Plan

### Phase 1: Foundation (this week)
- [ ] Add hol.org as an index source — consume their 72,000 agent index, run TrstLyr scoring on top
- [ ] Build the `/discover` route in `packages/api/src/routes/discover.ts`
- [ ] Extend scoring engine to accept batch inputs (needed for index crawling)
- [ ] Basic `q`, `min_score`, `limit`, `offset` params working

### Phase 2: Protocol breadth (next week)
- [ ] A2A card crawler — index `/.well-known/agent-card.json` from known agents
- [ ] MCP server card support (SEP-2127 draft)
- [ ] API uptime provider — ping declared endpoints, track availability
- [ ] `protocol` and `capability` filter params

### Phase 3: Dynamic signals (hackathon window)
- [ ] Trade performance provider (for Dead Reckoning hackathon)
- [ ] Continuous monitoring / score refresh on activity events
- [ ] `min_confidence` param

---

## Key Decisions

**Don't rebuild the crawler — consume hol.org.**
hol.org indexes 72,000+ agents across 14 registries. We add trust scoring on top. That's /discover without solving the crawling problem from scratch.

**Protocol-agnostic by design.**
ERC-8004, A2A, MCP, ACP — we score agents regardless of how they declared themselves. We are not betting on a protocol winner.

**Composite scoring is our moat.**
Mnemom does zkVM scoring but no discovery. OASF does cross-protocol indexing but no trust scoring. We do both. Subjective Logic + multi-source signals is not easy to replicate quickly.

**Monetization: API fees per query, not badge sales.**
Trust queries have value when the gate is load-bearing. Charge per `/discover` query above free tier. Free tier drives adoption; paid tier captures value when agents use scores to make real decisions.

---

## Competitors to Monitor

- **t54 Labs** — $5M seed (Ripple + Franklin Templeton), "Know Your Agent", live on Base. Most direct institutional competitor. Need: pricing, signal sources, discovery API status.
- **Mnemom** — zkVM scoring, bond-rating grades, GitHub Actions integration. Strong on verifiability, weak on discovery.
- **Fetch.ai Almanac** — most mature trust-integrated discovery but Cosmos-native, token-gated. Different ecosystem.
- **hol.org** — potential partner/data source, not competitor.

