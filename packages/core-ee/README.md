# @trstlyr/core-ee — Enterprise Edition

> Licensed under the [Business Source License 1.1](../../LICENSE-EE).
> Converts to Apache 2.0 four years from release date.
> For commercial licensing: chris@trstlyr.ai

## What's in Enterprise Edition

Features planned for `core-ee` — building these post-hackathon:

### EigenTrust Graph Engine
Transitive vouching across the agent network. An agent's trust score is
weighted by the trustworthiness of whoever vouches for them, recursively.
Sybil-resistant via behavioral cluster similarity detection.

### Capability-Specific Trust Scores
Per-skill trust scoring aligned with A2A capabilities. An agent can score
0.91 for `trading/momentum` and 0.28 for `advice/portfolio`. One global
score hides what matters.

### Tenant-Isolated Identity Graphs
Private identity graphs for enterprise deployments. Your agent network's
trust relationships stay within your tenant boundary.

### Streaming Trust Events
Webhook and SSE support for real-time trust score updates. Subscribe to
score changes for agents you depend on.

### Audit Logs & Compliance Exports
Immutable audit trail of every trust evaluation. SIEM-compatible exports.

### Advanced Sybil Resistance
Louvain community detection to identify coordinated vouching rings.
Behavioral fingerprinting to catch fake identities.

## Open Core

The core scoring engine, all 5 providers, REST API, MCP server, identity
verification, and EAS attestation are **Apache 2.0** in `packages/core`.
Self-hostable, free forever.

`core-ee` is additive — enterprise features layered on top.
