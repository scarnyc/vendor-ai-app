import { describe, it, expect } from 'vitest';
import { validateCitations } from '../policies';
import { PolicyCitationSchema, type PolicyCitation } from '../schemas';

/**
 * SPEC §9 / DESIGN §13 — validateCitations is the substring guard that
 * promotes an LLM-emitted citation to verified=true only when the quote
 * appears verbatim (whitespace-normalized) inside the cited policy doc.
 *
 * Inputs are PolicyCitation[] (verified: false from `unverifiedCitation()`),
 * outputs are { verified: PolicyCitation[]; unverified: PolicyCitation[] }.
 */

function unverified(c: Omit<PolicyCitation, 'verified'>): PolicyCitation {
  return PolicyCitationSchema.parse({ ...c, verified: false });
}

describe('validateCitations (substring guard)', () => {
  it('verbatim quote from procurement_policy.md → verified: true', async () => {
    const citation = unverified({
      policy_doc: 'procurement_policy',
      section: 'Approval routing',
      quote:
        'The agent must not approve a vendor, commit spend, accept contract terms, or send external communications without human approval.',
    });

    const { verified, unverified: unv } = await validateCitations([citation]);

    expect(verified).toHaveLength(1);
    expect(unv).toHaveLength(0);
    expect(verified[0].verified).toBe(true);
    expect(verified[0].quote).toBe(citation.quote);
  });

  it('paraphrased (non-substring) quote → verified: false, surfaced as unverified', async () => {
    const citation = unverified({
      policy_doc: 'procurement_policy',
      section: 'Approval routing',
      quote:
        'The agent is not allowed to approve vendors or commit company spend on its own.',
    });

    const { verified, unverified: unv } = await validateCitations([citation]);

    expect(verified).toHaveLength(0);
    expect(unv).toHaveLength(1);
    expect(unv[0].verified).toBe(false);
    expect(unv[0].policy_doc).toBe('procurement_policy');
  });

  it('whitespace-tolerant: extra internal whitespace normalizes to a verbatim match → verified: true', async () => {
    const citation = unverified({
      policy_doc: 'procurement_policy',
      section: 'Approval routing',
      quote:
        'Procurement   owns\tinitial    triage\nfor all\n\nnew vendors.',
    });

    const { verified, unverified: unv } = await validateCitations([citation]);

    expect(verified).toHaveLength(1);
    expect(unv).toHaveLength(0);
    expect(verified[0].verified).toBe(true);
  });

  it('mixed batch: one verbatim, one paraphrased — each lands on its own side', async () => {
    const good = unverified({
      policy_doc: 'procurement_policy',
      section: 'Approval routing',
      quote: 'Procurement owns initial triage for all new vendors.',
    });
    const bad = unverified({
      policy_doc: 'procurement_policy',
      section: 'Escalation triggers',
      quote: 'The procurement team must always handle the initial review.',
    });

    const { verified, unverified: unv } = await validateCitations([good, bad]);

    expect(verified).toHaveLength(1);
    expect(unv).toHaveLength(1);
    expect(verified[0].quote).toBe(good.quote);
    expect(verified[0].verified).toBe(true);
    expect(unv[0].quote).toBe(bad.quote);
    expect(unv[0].verified).toBe(false);
  });
});
