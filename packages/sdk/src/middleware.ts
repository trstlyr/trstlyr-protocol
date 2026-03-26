import { TrstLyrClient } from './client.js';
import type { ClientConfig, TrustScore } from './types.js';

// ── Minimal type shims for Express/Fastify ──
// Avoids any framework dependency while remaining type-compatible.

interface Req {
  headers: Record<string, string | string[] | undefined>;
  [key: string]: unknown;
}

interface Res {
  status?: (code: number) => Res;
  statusCode?: number;
  json?: (body: unknown) => void;
  send?: (body: string) => void;
  end?: (chunk?: string) => void;
  [key: string]: unknown;
}

type NextFn = (err?: unknown) => void;

export interface TrustGateOptions {
  /** Extract the subject identifier from the incoming request. */
  subjectFrom: (req: Req) => string | undefined;
  /** Minimum trust score to pass the gate. Default: 60. */
  minScore?: number;
  /** Custom response when the gate blocks a request. */
  onBlock?: (subject: string, score: TrustScore | null) => { status?: number; message?: string; body?: unknown };
  /** TrstLyrClient config overrides. */
  client?: ClientConfig;
  /** If true, block when the API is unreachable. Default: false (fail open). */
  strictMode?: boolean;
}

/**
 * Express/Connect-style middleware that gates requests on trust score.
 * Blocks requests below the threshold with 403; attaches `trustScore` to `req` on pass.
 * @param opts - Gate options: subject extraction, threshold, custom block response.
 * @returns Async middleware function `(req, res, next) => Promise<void>`.
 *
 * @example
 * ```ts
 * app.use(trustGate({
 *   subjectFrom: (req) => req.headers['x-agent-id'] as string,
 *   minScore: 60,
 * }));
 * ```
 */
export function trustGate(opts: TrustGateOptions) {
  const client = new TrstLyrClient(opts.client);
  const threshold = opts.minScore ?? 60;

  return async (req: Req, res: Res, next: NextFn): Promise<void> => {
    const subject = opts.subjectFrom(req);
    if (!subject) {
      next();
      return;
    }

    let result: TrustScore | null = null;

    try {
      result = await client.score(subject);
    } catch {
      if (opts.strictMode) {
        respond(res, opts, subject, null, 503, 'Trust check unavailable');
        return;
      }
      // Fail open
      next();
      return;
    }

    if (result.trust_score < threshold) {
      respond(res, opts, subject, result, 403, `Agent ${subject} blocked: score ${result.trust_score}`);
      return;
    }

    // Attach score to request for downstream handlers
    (req as Record<string, unknown>)['trustScore'] = result;
    next();
  };
}

/**
 * Fastify onRequest hook that gates requests on trust score.
 * Blocks requests below the threshold; attaches `trustScore` to `request` on pass.
 * @param opts - Gate options: subject extraction, threshold, custom block response.
 * @returns Async hook function `(request, reply) => Promise<void>`.
 *
 * @example
 * ```ts
 * server.addHook('onRequest', trustGateHook({
 *   subjectFrom: (req) => req.headers['x-agent-id'] as string,
 *   minScore: 60,
 * }));
 * ```
 */
export function trustGateHook(opts: TrustGateOptions) {
  const client = new TrstLyrClient(opts.client);
  const threshold = opts.minScore ?? 60;

  return async (request: Req, reply: Res): Promise<void> => {
    const subject = opts.subjectFrom(request);
    if (!subject) return;

    let result: TrustScore | null = null;

    try {
      result = await client.score(subject);
    } catch {
      if (opts.strictMode) {
        replyFastify(reply, 503, { error: 'Trust check unavailable' });
        return;
      }
      // Fail open
      return;
    }

    if (result.trust_score < threshold) {
      const custom = opts.onBlock?.(subject, result);
      const status = custom?.status ?? 403;
      const body = custom?.body ?? { error: custom?.message ?? `Agent ${subject} blocked: score ${result.trust_score}` };
      replyFastify(reply, status, body);
      return;
    }

    (request as Record<string, unknown>)['trustScore'] = result;
  };
}

// ── Helpers ──

function respond(
  res: Res,
  opts: TrustGateOptions,
  subject: string,
  result: TrustScore | null,
  defaultStatus: number,
  defaultMessage: string,
): void {
  const custom = opts.onBlock?.(subject, result);
  const status = custom?.status ?? defaultStatus;
  const body = custom?.body ?? { error: custom?.message ?? defaultMessage };

  if (res.status) {
    const r = res.status(status);
    if (r.json) r.json(body);
    else r.end?.(JSON.stringify(body));
  } else if (res.end) {
    res.statusCode = status;
    res.end(JSON.stringify(body));
  }
}

function replyFastify(reply: Res, status: number, body: unknown): void {
  const r = reply as Record<string, unknown>;
  if (typeof r['code'] === 'function') {
    const coded = (r['code'] as (s: number) => Res)(status);
    // Pass object directly so Fastify serializes as application/json
    if (coded.send) coded.send(body as string);
  } else if (reply.status && reply.send) {
    reply.status(status);
    reply.send(body as string);
  }
}
