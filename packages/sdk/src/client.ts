import type {
  ClientConfig,
  TrustScore,
  Attestation,
  BehavioralOpts,
  BehavioralResult,
  BehavioralHistory,
  X402PaymentDetails,
} from './types.js';
import { TrstLyrError, PaymentRequiredError } from './types.js';

const DEFAULT_BASE_URL = 'https://api.trstlyr.ai';
const DEFAULT_TIMEOUT = 10_000;

const OUTCOME_MAP: Record<string, number> = { failed: 0, partial: 1, success: 2 };

/**
 * Lightweight HTTP client for the TrstLyr REST API.
 * Supports trust scoring, attestation, and behavioral attestation endpoints.
 */
export class TrstLyrClient {
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly apiKey?: string;
  private readonly strictMode: boolean;

  /** @param config - Client configuration (baseUrl, timeout, apiKey, strictMode). */
  constructor(config: ClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;
    this.apiKey = config.apiKey;
    this.strictMode = config.strictMode ?? false;
  }

  // ── Public API ──

  /**
   * Query the trust score for a subject.
   * @param subject - Subject identifier in namespace:id format (e.g. "github:tankcdr").
   * @returns Trust score result with score, confidence, risk level, and signals.
   * @throws {TrstLyrError} On non-402 HTTP errors.
   * @throws {PaymentRequiredError} On 402 responses with x402 payment details.
   */
  async score(subject: string): Promise<TrustScore> {
    return this.get<TrustScore>(`/v1/trust/score/${encodeURIComponent(subject)}`);
  }

  /**
   * Anchor a trust attestation on-chain via EAS on Base.
   * @param subject - Subject identifier to attest.
   * @returns Attestation result with UID.
   * @throws {PaymentRequiredError} After the first free attestation ($0.01 USDC via x402).
   */
  async attest(subject: string): Promise<Attestation> {
    return this.post<Attestation>('/v1/attest', { subject });
  }

  /**
   * Submit a post-interaction behavioral attestation.
   * @param opts - Behavioral attestation options (subject, outcome, rating, etc.).
   * @returns Behavioral attestation result.
   */
  async behavioral(opts: BehavioralOpts): Promise<BehavioralResult> {
    const body = {
      subject: opts.subject,
      interactionType: opts.interactionType ?? 'other',
      outcome: OUTCOME_MAP[opts.outcome] ?? 2,
      rating: opts.rating,
      evidenceURI: opts.evidenceURI,
      interactionAt: opts.interactionAt ?? Math.floor(Date.now() / 1000),
      valueUSDC: opts.value_usd ? Math.round(opts.value_usd * 100) : undefined,
    };
    return this.post<BehavioralResult>('/v1/attest/behavioral', body);
  }

  /**
   * Retrieve behavioral attestation history for a subject.
   * @param subject - Subject identifier to query history for.
   * @returns Behavioral history including attestations and summary.
   */
  async behaviorHistory(subject: string): Promise<BehavioralHistory> {
    return this.get<BehavioralHistory>(`/v1/trust/behavior/${encodeURIComponent(subject)}`);
  }

  // ── HTTP primitives ──

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h['Authorization'] = `Bearer ${this.apiKey}`;
    return h;
  }

  private async request<T>(url: string, init: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, { ...init, signal: controller.signal });

      if (res.status === 402) {
        // Try to parse x402 payment details from the header first, then body
        const payment = parseX402Header(res.headers.get('x-payment-required'));
        if (payment) {
          throw new PaymentRequiredError(payment);
        }
        // Fallback: try to parse body as x402 JSON
        const body = await res.text().catch(() => '');
        const bodyPayment = tryParseX402(body);
        throw new PaymentRequiredError(bodyPayment, body || undefined);
      }

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TrstLyrError(
          body || `HTTP ${res.status}`,
          res.status,
        );
      }

      return (await res.json()) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private async get<T>(path: string): Promise<T> {
    return this.request<T>(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
  }
}

// ── x402 parsing helpers ──────────────────────────────────────────────────────

/**
 * Parse the `X-Payment-Required` header.
 * The TrstLyr API sends the x402 payload as a base64-encoded JSON string in this header.
 */
function parseX402Header(header: string | null): X402PaymentDetails | null {
  if (!header) return null;
  try {
    // Try base64 decode first (TrstLyr API format)
    const decoded = Buffer
      ? Buffer.from(header, 'base64').toString('utf8')
      : atob(header);
    return tryParseX402(decoded);
  } catch {
    // Maybe it's raw JSON
    return tryParseX402(header);
  }
}

function tryParseX402(raw: string): X402PaymentDetails | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    if (obj && typeof obj === 'object' && 'accepts' in obj && Array.isArray(obj['accepts'])) {
      return obj as unknown as X402PaymentDetails;
    }
    return null;
  } catch {
    return null;
  }
}
