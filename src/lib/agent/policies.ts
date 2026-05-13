import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  POLICY_DOCS,
  type PolicyCitation,
  type PolicyDoc,
} from './schemas';

const ROOT = process.cwd();
const DOCS_DIR = path.join(ROOT, 'docs');

const POLICY_FILE: Record<PolicyDoc, string> = {
  procurement_policy: 'procurement_policy.md',
  vendor_risk_policy: 'vendor_risk_policy.md',
  finance_approval_matrix: 'finance_approval_matrix.md',
  legal_review_policy: 'legal_review_policy.md',
  security_review_policy: 'security_review_policy.md',
  data_handling_policy: 'data_handling_policy.md',
  communication_policy: 'communication_policy.md',
};

let cache: Record<PolicyDoc, string> | null = null;

export async function loadAllPolicies(): Promise<Record<PolicyDoc, string>> {
  if (cache) return cache;
  const out = {} as Record<PolicyDoc, string>;
  await Promise.all(
    POLICY_DOCS.map(async (doc) => {
      out[doc] = await fs.readFile(path.join(DOCS_DIR, POLICY_FILE[doc]), 'utf8');
    })
  );
  cache = out;
  return out;
}

export async function readPolicy(doc: PolicyDoc): Promise<string> {
  const all = await loadAllPolicies();
  return all[doc];
}

/**
 * SPEC §9 / DESIGN §13 finding #2 — every PolicyCitation.quote must be a
 * verbatim substring of the cited policy doc. Anything that isn't is flagged
 * as unverified — the citation isn't dropped (the operator can still see it),
 * but the agent loses the right to claim it as authority.
 */
export async function validateCitations(
  citations: PolicyCitation[]
): Promise<{ verified: PolicyCitation[]; unverified: PolicyCitation[] }> {
  const all = await loadAllPolicies();
  const verified: PolicyCitation[] = [];
  const unverified: PolicyCitation[] = [];
  for (const c of citations) {
    const text = all[c.policy_doc];
    if (text && normalize(text).includes(normalize(c.quote))) {
      verified.push({ ...c, verified: true });
    } else {
      unverified.push({ ...c, verified: false });
    }
  }
  return { verified, unverified };
}

function normalize(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

export async function buildPolicyContext(): Promise<string> {
  const all = await loadAllPolicies();
  return POLICY_DOCS.map(
    (doc) => `\n=== ${doc} ===\n${all[doc]}\n`
  ).join('\n');
}
