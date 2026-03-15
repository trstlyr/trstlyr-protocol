// EAS Attestation — write trust evaluation results to Ethereum Attestation Service
// SPEC §9.1 — on-chain attestation anchoring
//
// Schema (Base Mainnet): 0xfff1179b55bf0717c0a071da701b4f597a6bfe0669bcb1daca6a66f0e14d407d
// EAS Contract (Base):   0x4200000000000000000000000000000000000021
// Wallet:                0xAaa00Fef6CD6a7B41e30c25b8655D599f462Cc43
//
// Each attestation costs ~$0.01 on Base L2. Scores are scaled × 1e18.

import { ethers } from 'ethers';
import type { TrustResult } from '../types/index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
const DEFAULT_SCHEMA_UID = '0xfff1179b55bf0717c0a071da701b4f597a6bfe0669bcb1daca6a66f0e14d407d';
const DEFAULT_RPC = 'https://mainnet.base.org';
const SCALE = BigInt('1000000000000000000'); // 1e18

// Minimal EAS ABI — only the attest() function we need
const EAS_ABI = [
  {
    inputs: [
      {
        components: [
          { name: 'schema', type: 'bytes32' },
          {
            components: [
              { name: 'recipient', type: 'address' },
              { name: 'expirationTime', type: 'uint64' },
              { name: 'revocable', type: 'bool' },
              { name: 'refUID', type: 'bytes32' },
              { name: 'data', type: 'bytes' },
              { name: 'value', type: 'uint256' },
            ],
            name: 'data',
            type: 'tuple',
          },
        ],
        name: 'request',
        type: 'tuple',
      },
    ],
    name: 'attest',
    outputs: [{ name: '', type: 'bytes32' }],
    stateMutability: 'payable',
    type: 'function',
  },
];

// ─── Schema ABI coder ─────────────────────────────────────────────────────────
// Schema: string subject, uint256 trustScore, uint256 confidence,
//         uint8 riskLevel, string signalSummary, string queryId

const SCHEMA_TYPES = ['string', 'uint256', 'uint256', 'uint8', 'string', 'string'];

const RISK_LEVEL_UINT: Record<string, number> = {
  minimal:  0,
  low:      1,
  medium:   2,
  high:     3,
  critical: 4,
};

// ─── Attestation result ───────────────────────────────────────────────────────

export interface AttestationResult {
  uid: string;
  txHash: string;
  subject: string;
  timestamp: string;
}

// ─── EAS Writer ──────────────────────────────────────────────────────────────

export class EASWriter {
  private readonly contract: ethers.Contract;
  private readonly signer: ethers.Wallet;
  private readonly schemaUid: string;

  constructor(options: {
    privateKey: string;
    rpcUrl?: string;
    schemaUid?: string;
  }) {
    const provider = new ethers.JsonRpcProvider(options.rpcUrl ?? DEFAULT_RPC);
    this.signer    = new ethers.Wallet(options.privateKey, provider);
    this.contract  = new ethers.Contract(EAS_CONTRACT, EAS_ABI, this.signer);
    this.schemaUid = options.schemaUid ?? DEFAULT_SCHEMA_UID;
  }

  /**
   * Write a TrustResult as an on-chain EAS attestation.
   * Returns the attestation UID which can be stored on the TrustResult.
   */
  async attest(result: TrustResult, options?: { paymentProof?: string }): Promise<AttestationResult> {
    // Scale scores to uint256 (× 1e18)
    // trust_score is 0-100; scale to 0-1e18 for on-chain storage
    const trustScoreScaled  = BigInt(Math.round((result.trust_score / 100) * 1e9)) * BigInt(1e9);
    // confidence is 0-1; scale to 0-1e18
    const confidenceScaled  = BigInt(Math.round(result.confidence * 1e9)) * BigInt(1e9);
    const riskLevelUint     = RISK_LEVEL_UINT[result.risk_level] ?? 2;

    // Signal summary — include top signal types as a compact string
    // (full evidence stays off-chain; this gives on-chain visibility without PII)
    let signalSummary = result.signals
      .map(s => `${s.provider}:${s.signal_type}:${s.score.toFixed(2)}`)
      .join(',') || 'no_signals';

    // Append payment proof if x402 payment was made
    if (options?.paymentProof) {
      signalSummary += `,payment:${options.paymentProof}`;
    }

    const queryId = result.metadata?.query_id ?? 'unknown';

    // ABI-encode the schema data
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const schemaData = abiCoder.encode(SCHEMA_TYPES, [
      result.subject,
      trustScoreScaled,
      confidenceScaled,
      riskLevelUint,
      signalSummary,
      queryId,
    ]);

    const request = {
      schema: this.schemaUid,
      data: {
        recipient: ethers.ZeroAddress,
        expirationTime: BigInt(0),
        revocable: true,
        refUID: ethers.ZeroHash,
        data: schemaData,
        value: BigInt(0),
      },
    };

    const tx = await (this.contract['attest'] as (r: typeof request) => Promise<ethers.ContractTransactionResponse>)(request);
    const receipt = await tx.wait();

    if (!receipt) throw new Error('Transaction receipt null — tx may be pending');

    // Extract attestation UID from logs
    // EAS emits Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema)
    const uid = this.extractUid(receipt);

    return {
      uid,
      txHash: receipt.hash,
      subject: result.subject,
      timestamp: new Date().toISOString(),
    };
  }

  /** Wallet address of the attestation signer */
  get walletAddress(): string {
    return this.signer.address;
  }

  /** Check wallet balance */
  async balance(): Promise<string> {
    const bal = await this.signer.provider!.getBalance(this.signer.address);
    return ethers.formatEther(bal);
  }

  private extractUid(receipt: ethers.TransactionReceipt): string {
    // Attested event topic: keccak256("Attested(address,address,bytes32,bytes32)")
    const ATTESTED_TOPIC = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';

    // Attested event: Attested(address indexed recipient, address indexed attester, bytes32 uid, bytes32 indexed schema)
    // topics[0]=event sig, topics[1]=recipient, topics[2]=attester, topics[3]=schema (indexed)
    // uid is NON-indexed → lives in log.data (first 32 bytes)
    for (const log of receipt.logs) {
      // uid is non-indexed → in log.data (first 32 bytes); topics[3] is schema (indexed)
      if (log.topics[0] === ATTESTED_TOPIC && log.data && log.data.length >= 66) {
        return '0x' + log.data.slice(2, 66);
      }
    }

    // Fallback: return tx hash if we can't parse the UID
    return receipt.hash;
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/** Create an EASWriter from environment variables. Returns null if not configured. */
export function createEASWriter(): EASWriter | null {
  const privateKey = process.env['AEGIS_ATTESTATION_PRIVATE_KEY'];
  if (!privateKey) return null;

  return new EASWriter({
    privateKey,
    rpcUrl:    process.env['BASE_RPC_URL'],
    schemaUid: process.env['AEGIS_EAS_SCHEMA_UID'],
  });
}
