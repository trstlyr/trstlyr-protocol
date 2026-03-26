import { providerFetch } from './http.js';
import { ERC8004, TTL } from '../constants.js';
// ERC-8004 Provider — on-chain agent identity signals (SPEC §9.2)
//
// Reads from the ERC-8004 Identity Registry on Base Mainnet.
// Contract: 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432
//
// Subject formats accepted:
//   erc8004:19077                                        — agentId on Base Mainnet
//   erc8004:eip155:8453:0x8004....:19077                 — fully qualified
//   erc8004:0xOwnerAddress                               — lookup by owner wallet

import type {
  EvaluateRequest,
  HealthStatus,
  Provider,
  ProviderMetadata,
  Signal,
  Subject,
} from '../types/index.js';

// ─── ERC-8004 constants ───────────────────────────────────────────────────────

const REGISTRY_ADDRESS = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
const BASE_RPC = 'https://mainnet.base.org';

// Function selectors
const TOKEN_URI_SELECTOR = '0xc87b56dd';      // tokenURI(uint256)
const OWNER_OF_SELECTOR  = '0x6352211e';      // ownerOf(uint256)
const TOKEN_OF_OWNER_SELECTOR = '0x2f745c59'; // tokenOfOwnerByIndex(address,uint256)

// ─── Registration file types ──────────────────────────────────────────────────

interface ServiceEntry {
  name: string;
  endpoint: string;
  version?: string;
}

interface RegistrationFile {
  type: string;
  name: string;
  description?: string;
  image?: string;
  services?: ServiceEntry[];
  active?: boolean;
  registrations?: Array<{ agentId: number; agentRegistry: string }>;
  supportedTrust?: string[];
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export class ERC8004Provider implements Provider {
  private readonly rpcUrl: string;

  constructor(rpcUrl?: string) {
    this.rpcUrl = rpcUrl ?? process.env['BASE_RPC_URL'] ?? BASE_RPC;
  }

  metadata(): ProviderMetadata {
    return {
      name: 'erc8004',
      version: '1.0.0',
      description: 'ERC-8004 on-chain agent identity registry signals (Base Mainnet)',
      supported_subjects: ['agent', 'skill'],
      supported_namespaces: ['erc8004'],
      signal_types: [
        {
          type: 'identity_on_chain',
          description: 'Agent has a verified on-chain ERC-8004 identity — active status, registration completeness',
        },
        {
          type: 'service_diversity',
          description: 'Number and variety of registered service endpoints (A2A, MCP, ENS, DID, etc.)',
        },
      ],
      rate_limit: { requests_per_minute: 300, burst: 50 },
    };
  }

  supported(subject: Subject): boolean {
    return subject.namespace === 'erc8004';
  }

  async evaluate(request: EvaluateRequest): Promise<Signal[]> {
    const { subject } = request;
    if (!this.supported(subject)) return [];

    const timestamp = new Date().toISOString();
    const agentId = this.parseAgentId(subject.id);

    if (agentId === null) {
      return [{
        provider: 'erc8004',
        signal_type: 'identity_on_chain',
        score: 0,
        confidence: 0.5,
        evidence: { error: `Cannot parse agentId from "${subject.id}"` },
        timestamp,
        ttl: 300,
      }];
    }

    try {
      const registration = await this.fetchRegistration(agentId);
      const signals: Signal[] = [];

      // ── identity_on_chain signal ──────────────────────────────────────────
      const isActive = registration.active !== false;
      const hasDescription = Boolean(registration.description?.trim());
      const hasName = Boolean(registration.name?.trim());
      const hasSupportedTrust = (registration.supportedTrust?.length ?? 0) > 0;

      const completenessScore =
        (isActive        ? ERC8004.REGISTRATION.ACTIVE_WEIGHT      : 0) +
        (hasName         ? ERC8004.REGISTRATION.NAME_WEIGHT        : 0) +
        (hasDescription  ? ERC8004.REGISTRATION.DESCRIPTION_WEIGHT : 0) +
        (hasSupportedTrust ? ERC8004.REGISTRATION.TRUST_WEIGHT     : 0);

      signals.push({
        provider: 'erc8004',
        signal_type: 'identity_on_chain',
        score: completenessScore,
        confidence: 0.95, // on-chain = very high confidence
        evidence: {
          agent_id: agentId,
          name: registration.name,
          active: isActive,
          has_description: hasDescription,
          supported_trust: registration.supportedTrust ?? [],
          registry: `eip155:8453:${REGISTRY_ADDRESS}`,
        },
        timestamp,
        ttl: 3600,
      });

      // ── service_diversity signal ──────────────────────────────────────────
      const services = registration.services ?? [];
      const serviceNames = services.map(s => s.name.toLowerCase());
      const hasA2A   = serviceNames.some(n => n.includes('a2a'));
      const hasMCP   = serviceNames.some(n => n.includes('mcp'));
      const hasENS   = serviceNames.some(n => n.includes('ens'));
      const hasDID   = serviceNames.some(n => n.includes('did'));
      const hasWeb   = serviceNames.some(n => n.includes('web') || n.includes('http'));
      const hasEmail = serviceNames.some(n => n.includes('email'));

      const diversityScore = Math.min(
        (hasA2A   ? ERC8004.SERVICE_DIVERSITY.A2A_WEIGHT   : 0) +
        (hasMCP   ? ERC8004.SERVICE_DIVERSITY.MCP_WEIGHT   : 0) +
        (hasENS   ? ERC8004.SERVICE_DIVERSITY.ENS_WEIGHT   : 0) +
        (hasDID   ? ERC8004.SERVICE_DIVERSITY.DID_WEIGHT   : 0) +
        (hasWeb   ? ERC8004.SERVICE_DIVERSITY.WEB_WEIGHT   : 0) +
        (hasEmail ? ERC8004.SERVICE_DIVERSITY.EMAIL_WEIGHT : 0) +
        Math.min(services.length / ERC8004.SERVICE_DIVERSITY.COUNT_MAX, 1.0) * ERC8004.SERVICE_DIVERSITY.COUNT_WEIGHT,
        1.0,
      );

      // Only emit if there are any services (otherwise vacuous)
      signals.push({
        provider: 'erc8004',
        signal_type: 'service_diversity',
        score: services.length > 0 ? diversityScore : 0,
        confidence: services.length > 0 ? ERC8004.SERVICE_DIVERSITY.WITH_SERVICES_CONFIDENCE : ERC8004.SERVICE_DIVERSITY.WITHOUT_SERVICES_CONFIDENCE,
        evidence: {
          service_count: services.length,
          services: services.map(s => s.name),
          has_a2a: hasA2A,
          has_mcp: hasMCP,
          has_ens: hasENS,
          has_did: hasDID,
        },
        timestamp,
        ttl: 3600,
      });

      return signals;

    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not found') || message.includes('0x')) {
        return []; // agentId doesn't exist — not a fraud signal, just not registered
      }
      return [{
        provider: 'erc8004',
        signal_type: 'identity_on_chain',
        score: 0,
        confidence: 0.3,
        evidence: { error: message, agent_id: agentId },
        timestamp,
        ttl: 120,
      }];
    }
  }

  async health(): Promise<HealthStatus> {
    const lastCheck = new Date().toISOString();
    try {
      // Call eth_blockNumber as a lightweight health check
      const res = await this.rpcCall('eth_blockNumber', []);
      const block = parseInt(res as string, 16);
      return {
        status: block > 0 ? 'healthy' : 'degraded',
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 0,
        dependencies: { 'base-mainnet-rpc': 'healthy' },
      };
    } catch (err: unknown) {
      console.warn(`[${"erc8004"}] health check failed:`, err instanceof Error ? err.message : err);
      return {
        status: 'unhealthy',
        last_check: lastCheck,
        avg_response_ms: 0,
        error_rate_1h: 1,
        dependencies: { 'base-mainnet-rpc': 'unhealthy' },
      };
    }
  }

  // ── Identity graph helper ─────────────────────────────────────────────────
  // Call this to extract linked identifiers from an ERC-8004 registration.
  // Used by the identity resolver (SPEC §8) to build the cross-namespace graph.
  async getLinkedIdentifiers(agentId: number): Promise<Array<{ namespace: string; id: string }>> {
    try {
      const reg = await this.fetchRegistration(agentId);
      const linked: Array<{ namespace: string; id: string }> = [];

      for (const svc of reg.services ?? []) {
        const name = svc.name.toLowerCase();
        const ep = svc.endpoint;

        if (name === 'ens' && ep) linked.push({ namespace: 'ens', id: ep });
        if (name === 'did' && ep) linked.push({ namespace: 'did', id: ep });
        if (name === 'github' && ep) {
          // Extract github.com/username or github:username
          const match = ep.match(/github\.com\/([^/\s]+)/i);
          if (match) linked.push({ namespace: 'github', id: match[1]! });
        }
        if ((name === 'twitter' || name === 'x') && ep) {
          const match = ep.match(/(?:twitter\.com|x\.com)\/([^/\s]+)/i) ??
                        ep.match(/@?([A-Za-z0-9_]+)/);
          if (match) linked.push({ namespace: 'twitter', id: match[1]! });
        }
      }

      return linked;
    } catch (err: unknown) {
      console.warn(`[provider] fetch failed, returning empty:`, err instanceof Error ? err.message : err);
      return [];
    }
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private parseAgentId(id: string): number | null {
    // "19077" or "0x4a85"
    const numeric = id.split(':').pop() ?? id;
    if (/^\d+$/.test(numeric)) return parseInt(numeric, 10);
    if (/^0x[0-9a-f]+$/i.test(numeric)) return parseInt(numeric, 16);
    return null;
  }

  private async fetchRegistration(agentId: number): Promise<RegistrationFile> {
    const paddedId = agentId.toString(16).padStart(64, '0');
    const data = TOKEN_URI_SELECTOR + paddedId;

    const raw = await this.rpcCall('eth_call', [
      { to: REGISTRY_ADDRESS, data },
      'latest',
    ]) as string;

    if (!raw || raw === '0x') {
      throw new Error(`agentId ${agentId} not found in registry`);
    }

    // Decode ABI-encoded string
    const bytes = Buffer.from(raw.slice(2), 'hex');
    const length = parseInt(bytes.slice(32, 64).toString('hex'), 16);
    const uri = bytes.slice(64, 64 + length).toString('utf8');

    return this.parseTokenUri(uri);
  }

  private parseTokenUri(uri: string): RegistrationFile {
    if (uri.startsWith('data:application/json;base64,')) {
      const b64 = uri.slice('data:application/json;base64,'.length);
      return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as RegistrationFile;
    }
    if (uri.startsWith('data:application/json,')) {
      return JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length))) as RegistrationFile;
    }
    if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('ipfs://')) {
      throw new Error(`Remote URI not yet supported: ${uri}`);
    }
    return JSON.parse(uri) as RegistrationFile;
  }

  private async rpcCall(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    let res: Response;
    try {
      res = await globalThis.fetch(this.rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) throw new Error(`RPC HTTP ${res.status}`);
    const json = await res.json() as { result?: unknown; error?: { message: string } };
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }
}
