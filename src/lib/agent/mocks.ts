import type { DecisionPacket, PolicyFlag } from './schemas';

/**
 * Deterministic LLM-output fixtures keyed by case_id. Used when LLM_PROVIDER=mock.
 * Hand-curated to produce the exact §2c expected verdicts from the plan:
 *   case_001 (Northstar Analytics)  → Medium risk, approve_with_followup
 *   case_002 (Workspace Depot)      → Low risk, approve_with_followup
 *   case_003 (TalentPulse AI)       → High risk, escalate
 *
 * These are the *LLM-composed* parts only — intake summary, policy flags,
 * recommended action, and draft email body. Deterministic tool outputs
 * (budget, TCV, approvers) come from tools.ts and are real even in mock mode.
 */

export interface MockLlmOutput {
  intake_summary: string;
  policy_flags: PolicyFlag[];
  recommended_action: DecisionPacket['recommended_action'];
  draft_internal_ticket: string;
  vendor_followup_body_lines: string[];
}

export const MOCK_LLM_OUTPUT: Record<string, MockLlmOutput> = {
  case_001: {
    intake_summary:
      'Northstar Analytics — predictive analytics overlay on Salesforce CRM data. ACV $85k + $10k one-time, 24mo term, Net 30. Customer PII in scope (CRM opportunity history, named-user analytics). SOC 2 Type II not provided (Type I available). EU-based subprocessor handles analytics compute. DPA proposed but not yet executed. Cost center REVOPS-042 (Maya Patel).',
    policy_flags: [
      {
        severity: 'warn',
        issue:
          'SOC 2 Type II not provided (Type I available per security questionnaire). Security review must verify equivalent controls or request Type II before contract signature.',
        recipient: 'security',
        citations: [
          {
            policy_doc: 'security_review_policy',
            section: 'Vendor evidence requirements',
            quote: 'SOC 2 Type II',
            verified: false,
          },
        ],
      },
      {
        severity: 'warn',
        issue:
          'EU subprocessor handles regulated personal data — Legal must confirm DPA covers cross-border transfer mechanism (SCCs or equivalent) before signature.',
        recipient: 'legal',
        citations: [
          {
            policy_doc: 'legal_review_policy',
            section: 'Data processing agreements',
            quote: 'data processing agreement',
            verified: false,
          },
        ],
      },
      {
        severity: 'info',
        issue:
          'Annual contract value $85k crosses VP Finance approval threshold — finance routing required.',
        recipient: 'vp_finance',
        citations: [
          {
            policy_doc: 'finance_approval_matrix',
            section: 'Approval thresholds',
            quote: '> $50,000',
            verified: false,
          },
        ],
      },
    ],
    recommended_action: 'approve_with_followup',
    draft_internal_ticket:
      'Vendor: Northstar Analytics. Risk: Medium. ACV $85k, 24mo term. Route to: Procurement Manager, VP Finance, Legal, Security. Outstanding: SOC 2 Type II evidence, executed DPA with EU-subprocessor SCC clause. Recommended: approve_with_followup pending follow-up email to vendor for the two missing items.',
    vendor_followup_body_lines: [
      "Thanks for the materials submitted for Northstar Analytics — the package is complete on intake.",
      'Before our internal review can finalize, we need two additional items:',
      '  • Most recent SOC 2 Type II report (or, if not yet available, the SOC 2 Type I report and a written timeline for Type II).',
      '  • Executed Data Processing Agreement covering the EU-based analytics subprocessor, including standard contractual clauses for cross-border transfer.',
      'Please reply with attachments or a shared link.',
    ],
  },

  case_002: {
    intake_summary:
      'Workspace Depot — annual office-supplies renewal. ACV $12k, 12mo term, Net 30. No system access, no data of any classification. Existing vendor (renewal). Missing: tax form (W-9) and updated vendor setup form. Cost center G&A-OPS.',
    policy_flags: [
      {
        severity: 'info',
        issue:
          'Renewal of an existing vendor at $12k ACV — sits at business-owner approval tier, no Finance escalation required.',
        recipient: 'business_owner',
        citations: [
          {
            policy_doc: 'finance_approval_matrix',
            section: 'Approval thresholds',
            quote: 'Business owner',
            verified: false,
          },
        ],
      },
      {
        severity: 'warn',
        issue:
          'Intake form missing W-9 and updated vendor setup details — required for any payment release per procurement policy.',
        recipient: 'procurement_manager',
        citations: [
          {
            policy_doc: 'procurement_policy',
            section: 'Intake completeness',
            quote: 'intake',
            verified: false,
          },
        ],
      },
    ],
    recommended_action: 'approve_with_followup',
    draft_internal_ticket:
      'Vendor: Workspace Depot (renewal). Risk: Low. ACV $12k, 12mo term. No data, no system access. Route to: Business Owner. Outstanding: W-9, updated vendor setup form. Recommended: approve_with_followup once vendor returns the two missing intake items.',
    vendor_followup_body_lines: [
      'Thanks for the renewal paperwork — we have most of what we need.',
      'To finalize the renewal on our side, please send:',
      '  • A current W-9 form.',
      '  • The updated vendor setup form (banking + contact details).',
      'Once received we can move the renewal forward immediately.',
    ],
  },

  case_003: {
    intake_summary:
      'TalentPulse AI — HR analytics platform processing employee personal data and compensation, integrated with HRIS and Slack. ACV $120k + $20k one-time, 36mo term, Net 60. AI training opt-out clause is NOT present in the quote (blocking — restricted data category requires written opt-out). APAC subprocessor for model training. SOC 2 Type II not provided. DPA not provided. Cost center HR-PEOPLE.',
    policy_flags: [
      {
        severity: 'block',
        issue:
          'AI training opt-out clause missing from quote — required by data_handling_policy whenever vendor processes restricted data with AI/ML systems. This is blocking; cannot recommend approval.',
        recipient: 'legal',
        citations: [
          {
            policy_doc: 'data_handling_policy',
            section: 'AI training opt-out',
            quote: 'opt-out',
            verified: false,
          },
        ],
      },
      {
        severity: 'block',
        issue:
          'SOC 2 Type II report not provided for a vendor processing employee personal data and compensation — Security cannot complete review without it.',
        recipient: 'security',
        citations: [
          {
            policy_doc: 'security_review_policy',
            section: 'Restricted data vendors',
            quote: 'SOC 2 Type II',
            verified: false,
          },
        ],
      },
      {
        severity: 'block',
        issue:
          'Data Processing Agreement not provided. Required before any contract involving employee PII can move forward.',
        recipient: 'legal',
        citations: [
          {
            policy_doc: 'legal_review_policy',
            section: 'DPA requirement',
            quote: 'data processing agreement',
            verified: false,
          },
        ],
      },
      {
        severity: 'warn',
        issue:
          'APAC subprocessor for model training introduces cross-border transfer risk — Legal must confirm transfer mechanism. Combined with missing DPA this compounds the legal blockers.',
        recipient: 'legal',
        citations: [
          {
            policy_doc: 'legal_review_policy',
            section: 'Cross-border transfers',
            quote: 'subprocessor',
            verified: false,
          },
        ],
      },
      {
        severity: 'warn',
        issue:
          'ACV $120k crosses CFO threshold AND term > 24 months — Finance routing required.',
        recipient: 'cfo',
        citations: [
          {
            policy_doc: 'finance_approval_matrix',
            section: 'Approval thresholds',
            quote: '> $100,000',
            verified: false,
          },
        ],
      },
      {
        severity: 'warn',
        issue:
          'Net 60 payment terms exceed standard Net 30. Requires VP Finance review per finance policy.',
        recipient: 'vp_finance',
        citations: [
          {
            policy_doc: 'finance_approval_matrix',
            section: 'Payment terms',
            quote: 'Net 60',
            verified: false,
          },
        ],
      },
    ],
    recommended_action: 'escalate',
    draft_internal_ticket:
      'Vendor: TalentPulse AI. Risk: HIGH. ACV $120k + $20k OT, 36mo term, Net 60. Restricted data (employee PII + comp). Multiple blocking issues: missing AI training opt-out clause, missing SOC 2 Type II, missing DPA, APAC subprocessor cross-border risk. Recommended: ESCALATE to Executive Sponsor + Legal + Security. Cannot proceed to approve_with_followup; vendor must remediate blockers before re-review.',
    vendor_followup_body_lines: [
      'Thanks for the proposal for TalentPulse AI. Before we can move into formal review, we need the following items resolved — these are blockers for any contract involving employee personal data:',
      '  • A written AI training opt-out clause confirming our data is not used to train your models.',
      '  • A current SOC 2 Type II report covering the production environment.',
      '  • An executed Data Processing Agreement that includes a transfer mechanism (Standard Contractual Clauses or equivalent) covering the APAC subprocessor.',
      '  • Confirmation of the named APAC subprocessor and a description of what data they process and where.',
      'Once these are addressed we can begin the Legal and Security review. Until then we cannot move the contract forward on our side.',
    ],
  },
};

export function getMockOutput(caseId: string): MockLlmOutput {
  const m = MOCK_LLM_OUTPUT[caseId];
  if (!m) {
    throw new Error(
      `No mock fixture for case_id="${caseId}". Add an entry in mocks.ts or run with LLM_PROVIDER=openrouter.`
    );
  }
  return m;
}
