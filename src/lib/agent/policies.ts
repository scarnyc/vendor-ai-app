import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  POLICY_DOCS,
  type AgentState,
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

/* ─── v0.10 Item 9 — citation pre-extraction ──────────────────────────── */

/**
 * Trigger keys map a flag-archetype to the regex patterns that identify
 * relevant policy clauses. Heuristic — runs in <50ms — and feeds top-K
 * matches into the LLM's user message so it can quote verbatim rather
 * than improvise. Pushes citation `verified` ratio toward ≥99% (the v0.9
 * baseline floats around 60-80%) and reduces flag fabrication.
 */
export type FlagTrigger =
  | 'tax-w9'
  | 'data-handling'
  | 'security-questionnaire'
  | 'ai-governance'
  | 'hipaa-baa'
  | 'subprocessor'
  | 'approval-threshold'
  | 'communication';

const FLAG_KEYWORDS: Record<FlagTrigger, RegExp[]> = {
  'tax-w9': [/\bW-?9\b/i, /\b1099\b/i, /taxpayer\s+identification/i],
  'data-handling': [
    /data\s+processing\s+agreement/i,
    /\bDPA\b/i,
    /\bPII\b/i,
    /personal\s+(data|information)/i,
  ],
  'security-questionnaire': [
    /SOC\s*2/i,
    /penetration\s+test/i,
    /security\s+questionnaire/i,
  ],
  'ai-governance': [
    /training\s+on\s+customer\s+data/i,
    /\bAI\s+(model|training|vendor)/i,
    /opt[-\s]?out/i,
    /no\s+training/i,
  ],
  'hipaa-baa': [
    /business\s+associate\s+agreement/i,
    /\bBAA\b/i,
    /\bPHI\b/i,
    /HIPAA/i,
  ],
  'subprocessor': [
    /sub-?processor/i,
    /EU\s+data\s+transfer/i,
    /\bSCC\b/i,
    /standard\s+contractual\s+clauses/i,
    /cross[-\s]?border/i,
  ],
  'approval-threshold': [
    /approval\s+threshold/i,
    /CFO/i,
    /VP\s+Finance/i,
    /executive\s+sponsor/i,
  ],
  'communication': [/follow[-\s]?up/i, /\[DRAFT\]/i, /vendor\s+email/i],
};

/**
 * Pick the FlagTriggers that apply to a given AgentState. Uses signals
 * already computed by deterministic tools so we don't re-do that work.
 */
function decideTriggers(state: AgentState): FlagTrigger[] {
  const dataClass = state.data_sensitivity?.data_class ?? 'internal';
  const tcv = state.tcv?.tcv_usd ?? 0;
  const approvers = state.required_approvals?.approvers ?? [];
  const parsed = state.document_inventory?.parsed_fields ?? {};
  const sq = String(parsed.security_questionnaire ?? '');

  // v0.10.2 Item 19b — route from materialized intake fields first (set
  // by `add-ai-involvement.mjs`), fall back to SQ-regex when absent.
  // Deterministic intake routing avoids keyword-fishing through prose
  // and keeps candidate clauses anchored on what the case actually
  // declared.
  const aiInvolvement = String(parsed.ai_involvement ?? '').toLowerCase();
  const subprocessorRegion = String(parsed.subprocessor_region ?? '').toLowerCase();
  const dataSensitivity = String(parsed.data_sensitivity ?? '').toLowerCase();

  const triggers: FlagTrigger[] = ['tax-w9'];
  if (dataClass === 'confidential' || dataClass === 'restricted') {
    triggers.push('data-handling', 'security-questionnaire');
  }
  if (
    aiInvolvement === 'training_on_customer_data' ||
    aiInvolvement === 'general' ||
    /\b(ai|model|training|llm|ml)\b/i.test(sq)
  ) {
    triggers.push('ai-governance');
  }
  if (
    dataSensitivity === 'restricted_phi' ||
    (dataClass === 'restricted' && /\b(phi|hipaa|health|medical)\b/i.test(sq))
  ) {
    triggers.push('hipaa-baa');
  }
  if (
    ['eu', 'emea', 'apac', 'cross-border', 'multi-region'].some(
      (r) => subprocessorRegion.includes(r)
    ) ||
    /\b(eu|emea|apac|cross[-\s]?border|subprocessor|scc)\b/i.test(sq)
  ) {
    triggers.push('subprocessor');
  }
  if (
    ['pii', 'restricted_pii', 'restricted_phi'].includes(dataSensitivity)
  ) {
    // Ensure data-handling + SQ candidates surface even when the
    // classifier flattens `pii` to `confidential` (which it now does
    // after Item 18) but the original intake-declared sensitivity is
    // still load-bearing for clause selection.
    triggers.push('data-handling', 'security-questionnaire');
  }
  if (tcv > 100_000 || approvers.includes('cfo') || approvers.includes('vp_finance')) {
    triggers.push('approval-threshold');
  }
  // Always include a comms anchor for the draft-email flagging.
  triggers.push('communication');
  return [...new Set(triggers)];
}

/**
 * Return a small map of trigger → up to 6 candidate clauses (verbatim lines
 * from the relevant policy docs) for the LLM to anchor citations on. The
 * candidate format is `(<policy_doc>) <line>` so the model knows which
 * policy_doc to use in its citation.
 */
export async function extractCandidateClauses(
  state: AgentState
): Promise<Record<string, string[]>> {
  const policies = await loadAllPolicies();
  const triggers = decideTriggers(state);
  const out: Record<string, string[]> = {};
  for (const trigger of triggers) {
    const keywords = FLAG_KEYWORDS[trigger] ?? [];
    // v0.10.2 Item 19a — score by match density instead of doc-walk
    // order. `match_count * 100 - length_penalty` favors lines that
    // hit multiple keywords (denser anchor for the LLM citation) and
    // mildly prefers shorter clauses (fewer extraneous tokens to
    // anchor on). Length penalty is capped at 200 so a very long
    // 3-keyword line still beats a 1-keyword line.
    const scored: Array<{ line: string; score: number; doc: PolicyDoc }> = [];
    for (const doc of POLICY_DOCS) {
      const text = policies[doc];
      if (!text) continue;
      for (const line of text.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length < 20) continue;
        const matchCount = keywords.reduce(
          (n, re) => n + (re.test(trimmed) ? 1 : 0),
          0
        );
        if (matchCount === 0) continue;
        const score = matchCount * 100 - Math.min(trimmed.length, 200);
        scored.push({ line: trimmed, score, doc });
      }
    }
    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score);
    out[trigger] = scored
      .slice(0, 6)
      .map(({ doc, line }) => `(${doc}) ${line}`);
  }
  return out;
}
