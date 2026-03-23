// Behavioral EAS Attestation — write post-interaction attestations to EAS on Base
//
// Schema: string subject, string attester, string interactionType, uint8 outcome,
//         uint8 rating, string evidenceURI, uint64 interactionAt, uint64 valueUSDC, bool disputed

import { ethers } from 'ethers';

const EAS_CONTRACT = '0x4200000000000000000000000000000000000021';
const DEFAULT_RPC = 'https://mainnet.base.org';

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

const BEHAVIORAL_SCHEMA_TYPES = [
  'string',  // subject
  'string',  // attester
  'string',  // interactionType
  'uint8',   // outcome
  'uint8',   // rating
  'string',  // evidenceURI
  'uint64',  // interactionAt
  'uint64',  // valueUSDC
  'bool',    // disputed
];

export interface BehavioralAttestationData {
  subject: string;
  attester: string;
  interactionType: string;
  outcome: number;   // 0=failed, 1=partial, 2=success
  rating: number;    // 1-5
  evidenceURI: string;
  interactionAt: number; // unix timestamp
  valueUSDC: number;     // USDC cents
  disputed: boolean;
}

export interface BehavioralAttestationResult {
  uid: string | null;
  txHash: string;
  subject: string;
  timestamp: string;
}

export class BehavioralEASWriter {
  private readonly contract: ethers.Contract;
  private readonly signer: ethers.Wallet;
  private readonly schemaUid: string;

  constructor(options: {
    privateKey: string;
    rpcUrl?: string;
    schemaUid: string;
  }) {
    if (!options.privateKey) {
      throw new Error('BehavioralEASWriter requires a non-empty privateKey');
    }
    const provider = new ethers.JsonRpcProvider(options.rpcUrl ?? DEFAULT_RPC);
    this.signer = new ethers.Wallet(options.privateKey, provider);
    this.contract = new ethers.Contract(EAS_CONTRACT, EAS_ABI, this.signer);
    this.schemaUid = options.schemaUid;
  }

  async attest(data: BehavioralAttestationData): Promise<BehavioralAttestationResult> {
    const abiCoder = ethers.AbiCoder.defaultAbiCoder();
    const schemaData = abiCoder.encode(BEHAVIORAL_SCHEMA_TYPES, [
      data.subject,
      data.attester,
      data.interactionType,
      data.outcome,
      data.rating,
      data.evidenceURI,
      BigInt(data.interactionAt),
      BigInt(data.valueUSDC),
      data.disputed,
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

    const uid = this.extractUid(receipt);
    if (!uid) {
      console.warn('[behavioral-eas] Could not extract attestation UID from tx logs:', receipt.hash);
    }

    return {
      uid,
      txHash: receipt.hash,
      subject: data.subject,
      timestamp: new Date().toISOString(),
    };
  }

  get walletAddress(): string {
    return this.signer.address;
  }

  extractUid(receipt: { logs: ReadonlyArray<{ topics: ReadonlyArray<string>; data: string }>; hash: string }): string | null {
    const ATTESTED_TOPIC = '0x8bf46bf4cfd674fa735a3d63ec1c9ad4153f033c290341f3a588b75685141b35';
    for (const log of receipt.logs) {
      if (log.topics[0] === ATTESTED_TOPIC && log.data && log.data.length >= 66) {
        return '0x' + log.data.slice(2, 66);
      }
    }
    return null;
  }
}

/** Create a BehavioralEASWriter from environment variables. Returns null if not configured. */
export function createBehavioralEASWriter(): BehavioralEASWriter | null {
  const privateKey = process.env['AEGIS_ATTESTATION_PRIVATE_KEY'];
  const schemaUid = process.env['AEGIS_BEHAVIORAL_SCHEMA_UID'];
  if (!privateKey || !schemaUid) return null;

  return new BehavioralEASWriter({
    privateKey,
    rpcUrl: process.env['BASE_RPC_URL'],
    schemaUid,
  });
}
