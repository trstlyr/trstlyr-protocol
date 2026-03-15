# AgentCash x402 Integration

## TrstLyr as an x402-Native API

TrstLyr's attestation endpoint (`POST /v1/attest`) is an x402-native API. The first attestation per subject is free; every subsequent attestation costs $0.01 USDC on Base Mainnet, paid via the x402 micropayment protocol. This means any agent with an x402-compatible wallet — including AgentCash — can autonomously pay for and receive on-chain trust attestations without human intervention.

The endpoint is listed among the 200+ bundled routes on the AgentCash MCP server at [agentcash.dev](https://agentcash.dev), making TrstLyr attestations natively accessible to any AgentCash-powered agent.

## How AgentCash Agents Pay for Attestations

AgentCash provides AI agents with a non-custodial USDC wallet and an MCP server that handles x402 payment flows. When an agent calls TrstLyr's attest endpoint and receives a 402 response, AgentCash can automatically:

1. Parse the `X-PAYMENT-REQUIRED` header to extract payment requirements
2. Sign an EIP-3009 `transferWithAuthorization` for the required amount
3. Return a base64-encoded `X-Payment` header containing the signed authorization
4. The agent retries the original request with the payment header attached

The Coinbase x402 facilitator verifies the payment on-chain and TrstLyr settles it asynchronously.

## Payment Flow Step by Step

1. **Query trust score** — `GET /v1/trust/score/{subject}` (free, no payment needed)
2. **Request attestation** — `POST /v1/attest` with `{"subject": "github:tankcdr"}`
3. **Receive 402** — Server returns HTTP 402 with `X-PAYMENT-REQUIRED` header containing base64 JSON:
   - `network`: `eip155:8453` (Base Mainnet)
   - `maxAmountRequired`: `10000` (0.01 USDC, 6 decimals)
   - `payTo`: TrstLyr's attestation wallet
   - `asset`: USDC contract on Base
4. **AgentCash pays** — Agent's wallet signs an EIP-3009 authorization and returns an `X-Payment` header
5. **Retry with proof** — Agent retries `POST /v1/attest` with the `X-Payment` header
6. **Attestation anchored** — TrstLyr writes the EAS attestation on Base Mainnet, embedding the payment nonce in the on-chain `signalSummary` field

## Why Payment-as-Trust-Signal Matters

The x402 payment isn't just a monetization mechanism — it's a trust signal. When an agent pays $0.01 USDC to anchor a trust score on-chain, that payment receipt becomes cryptographic proof of commitment. The payment nonce is embedded directly in the EAS attestation's `signalSummary` field (e.g., `payment:0x{nonce}`), creating an immutable on-chain record that ties the trust evaluation to a verified economic action.

This creates a Sybil-resistant attestation system: spamming fake attestations has a real cost. Each payment proves the requester controlled a funded wallet and deliberately chose to anchor this specific trust evaluation. The on-chain attestation becomes stronger evidence precisely because it required economic skin-in-the-game.

For agent-to-agent commerce, this pattern is powerful: Agent A can verify that Agent B's trust score was not only computed but *paid for* — someone valued that evaluation enough to commit real capital to it.

## Demo Script Usage

```bash
# Dry-run: shows trust score + x402 payment requirements (no payment made)
npx tsx scripts/agentcash-demo.ts github:tankcdr

# Live mode: pays via AgentCash wallet and completes the attestation
AGENTCASH_API_KEY=ak_... npx tsx scripts/agentcash-demo.ts github:tankcdr

# Custom API endpoint (e.g., local dev)
TRSTLYR_API_URL=http://localhost:3000 npx tsx scripts/agentcash-demo.ts
```

The demo script walks through each step of the flow, printing clear output at every stage: trust score retrieval, 402 response parsing, payment details, and (in live mode) the final EAS attestation UID with its EASScan link.
