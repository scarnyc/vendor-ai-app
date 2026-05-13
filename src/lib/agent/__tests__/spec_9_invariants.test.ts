import { describe, it, expect } from 'vitest';
import {
  DecisionPacketSchema,
  HumanDecisionSchema,
  LlmPolicyCitationSchema,
  LlmPolicyFlagSchema,
  PolicyCitationSchema,
  PolicyFlagSchema,
} from '../schemas';

/**
 * SPEC §9 hard product lines, expressed at the schema layer:
 *
 *   The agent never approves spend, never sends external messages, never
 *   accepts contract language, never makes the final security/privacy
 *   decision.
 *
 * These tests pin the type-system protections that hold §9 — they fail loud
 * if a future change reopens any of these surfaces.
 */

describe('SPEC §9 — schema-layer invariants', () => {
  it('DecisionPacketSchema does NOT expose any agent-writable "sent" or "accepted" or "approved" key', () => {
    const keys = Object.keys(DecisionPacketSchema.shape);
    const forbidden = ['sent_email', 'accepted_terms', 'approved', 'sent', 'agent_approved'];
    for (const key of forbidden) {
      expect(keys, `DecisionPacketSchema must not include '${key}'`).not.toContain(key);
    }
  });

  it('LlmPolicyCitationSchema has NO `verified` field — the LLM cannot forge it', () => {
    // Compile-time guard: `LlmPolicyCitationSchema.shape.verified` does not
    // exist on the type — TypeScript proves the absence. The runtime check
    // (via `as Record<...>` indirection) covers the case where someone bypasses
    // the type by adding `.extend({ verified: ... })` to the LLM-facing schema.
    expect(
      (LlmPolicyCitationSchema.shape as Record<string, unknown>).verified
    ).toBeUndefined();
    expect(Object.keys(LlmPolicyCitationSchema.shape)).toEqual(
      expect.arrayContaining(['policy_doc', 'section', 'quote'])
    );
  });

  it('PolicyCitationSchema (runtime form) DOES have `verified` — set only by validateCitations', () => {
    expect(PolicyCitationSchema.shape.verified).toBeDefined();
  });

  it('LlmPolicyFlagSchema.citations is an array of LLM-facing citations — structurally cannot carry `verified: true`', () => {
    // Constructing an LLM-facing flag with `verified: true` on a citation
    // must either be silently stripped (Zod default) or rejected — either
    // way, the parsed value cannot expose `verified` since the schema's
    // citation shape has no such key.
    const parsed = LlmPolicyFlagSchema.parse({
      severity: 'warn',
      issue: 'test',
      recipient: 'procurement_manager',
      citations: [
        {
          policy_doc: 'procurement_policy',
          section: 'Approval routing',
          quote: 'verbatim quote',
          // forged — must not survive
          verified: true,
        },
      ],
    });

    expect(parsed.citations).toHaveLength(1);
    expect((parsed.citations[0] as Record<string, unknown>).verified).toBeUndefined();
  });

  it('HumanDecisionSchema is the only verdict-bearing schema — `verdict` lives only on the human side', () => {
    expect(HumanDecisionSchema.shape.verdict).toBeDefined();
    expect((DecisionPacketSchema.shape as Record<string, unknown>).verdict).toBeUndefined();
    expect((PolicyFlagSchema.shape as Record<string, unknown>).verdict).toBeUndefined();
    expect((LlmPolicyFlagSchema.shape as Record<string, unknown>).verdict).toBeUndefined();
  });

  it('DecisionPacketSchema.human_decision is nullable — packets exist in a pre-HITL state', () => {
    // A packet with `human_decision: null` MUST parse cleanly — represents
    // the pre-operator-click state where the agent has produced its
    // recommendation but no human has decided.
    const fieldSchema = DecisionPacketSchema.shape.human_decision;
    // The Zod schema reports the wrapped/nullable shape via safeParse on null.
    const result = fieldSchema.safeParse(null);
    expect(result.success).toBe(true);
  });
});
