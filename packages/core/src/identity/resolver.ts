// Identity Resolver — expands a subject to all linked identifiers (SPEC §8)
//
// When evaluating `github:tankcdr`, the resolver checks if tankcdr has
// linked any other identifiers (twitter, erc8004, clawhub, etc.) and returns
// ALL of them so the engine can fan out to every relevant provider.
//
// Also handles auto-extraction from ERC-8004 services arrays.

import { identityGraph } from './graph.js';
import type { SubjectRef } from './graph.js';
import { ERC8004Provider } from '../providers/index.js';

const erc8004Provider = new ERC8004Provider();

export interface ResolvedIdentity {
  canonical: SubjectRef;         // the subject originally queried
  linked: SubjectRef[];          // all verified linked identifiers
  all: SubjectRef[];             // canonical + linked
}

/**
 * Resolve a subject to all its linked identifiers.
 * Performs ERC-8004 auto-extraction on first encounter.
 */
export async function resolveIdentity(subject: SubjectRef): Promise<ResolvedIdentity> {
  // If this is an ERC-8004 subject, auto-extract linked identifiers
  // from the services array (one-time, cached via the graph)
  if (subject.namespace === 'erc8004') {
    await maybeExtractERC8004Links(subject);
  }

  const linked = identityGraph.resolveAll(subject);

  return {
    canonical: subject,
    linked,
    all: [subject, ...linked],
  };
}

/**
 * Given an ERC-8004 subject, fetch its registration and add any declared
 * service endpoints to the identity graph as erc8004_services links.
 * Skips if already done (graph already has links for this subject).
 */
async function maybeExtractERC8004Links(subject: SubjectRef): Promise<void> {
  // Already have links for this subject — don't re-fetch
  const existing = identityGraph.getLinked(subject);
  if (existing.length > 0) return;

  try {
    const agentId = parseInt(subject.id.split(':').pop() ?? subject.id, 10);
    if (isNaN(agentId)) return;

    const linked = await erc8004Provider.getLinkedIdentifiers(agentId);
    for (const linkedId of linked) {
      identityGraph.addLink(
        subject,
        { namespace: linkedId.namespace, id: linkedId.id },
        'erc8004_services',
        { source: 'erc8004_services_auto_extract', agent_id: agentId },
      );
    }
  } catch (err) {
    console.warn('[trstlyr] maybeExtractERC8004Links:', err);
  }
}

/**
 * Quick check: what namespaces does a subject have linked identifiers in?
 * Useful for deciding which providers to invoke.
 */
export function linkedNamespaces(subject: SubjectRef): string[] {
  const linked = identityGraph.resolveAll(subject);
  return [...new Set(linked.map(s => s.namespace))];
}
