import { z } from 'zod';

/* ─── Policy citations (SPEC §9 — verifiable, no hallucinated quotes) ──── */

export const POLICY_DOCS = [
  'procurement_policy',
  'vendor_risk_policy',
  'finance_approval_matrix',
  'legal_review_policy',
  'security_review_policy',
  'data_handling_policy',
  'communication_policy',
] as const;

export const PolicyDocSchema = z.enum(POLICY_DOCS);
export type PolicyDoc = z.infer<typeof PolicyDocSchema>;

/**
 * LLM-facing citation shape. Intentionally has NO `verified` field — the LLM
 * cannot mint a verified citation by emitting `verified: true` in its
 * structured-output JSON. `validateCitations` (policies.ts) is the only call
 * site that promotes an LlmPolicyCitation to a runtime PolicyCitation with
 * `verified: true`. This is the §9 "no hallucinated quotes" enforcement at
 * the type-system level.
 */
export const LlmPolicyCitationSchema = z.object({
  policy_doc: PolicyDocSchema,
  section: z.string().min(1),
  quote: z.string().min(1).max(500),
});
export type LlmPolicyCitation = z.infer<typeof LlmPolicyCitationSchema>;

/**
 * Runtime citation shape — includes the `verified` boolean. The factory
 * `unverifiedCitation()` is the only sanctioned constructor from an
 * LLM-emitted citation; `validateCitations` is the only writer that flips
 * `verified` to true.
 */
export const PolicyCitationSchema = LlmPolicyCitationSchema.extend({
  verified: z.boolean(),
});
export type PolicyCitation = z.infer<typeof PolicyCitationSchema>;

export function unverifiedCitation(c: LlmPolicyCitation): PolicyCitation {
  return { ...c, verified: false };
}

/* LLM-facing flag — uses LlmPolicyCitationSchema so the LLM can't forge a
 * verified citation in structured output. */
export const LlmPolicyFlagSchema = z.object({
  severity: z.enum(['info', 'warn', 'block']),
  issue: z.string().min(1),
  recipient: z.enum([
    'business_owner',
    'procurement_manager',
    'vp_finance',
    'cfo',
    'executive_sponsor',
    'legal',
    'security',
  ]),
  citations: z.array(LlmPolicyCitationSchema).min(1),
});
export type LlmPolicyFlag = z.infer<typeof LlmPolicyFlagSchema>;

export const PolicyFlagSchema = z.object({
  severity: z
    .enum(['info', 'warn', 'block'])
    .describe(
      'info = does NOT change which approvers route the case (paperwork only). ' +
        'warn = changes routing (legal/security pulled in). ' +
        'block = engagement cannot proceed. Match to the deterministic risk ' +
        'math in the system prompt — block forces risk=high, warn forces ' +
        'risk=medium, info stays low.'
    ),
  issue: z
    .string()
    .min(1)
    .describe(
      'One-sentence statement of the concern or follow-up. Specific and ' +
        'actionable; avoid restating the policy doc.'
    ),
  recipient: z
    .enum([
      'business_owner',
      'procurement_manager',
      'vp_finance',
      'cfo',
      'executive_sponsor',
      'legal',
      'security',
    ])
    .describe(
      'Who needs to act on this flag. Match to the required_approvers list ' +
        'when possible — flags routing to legal/security should set severity=warn.'
    ),
  citations: z
    .array(PolicyCitationSchema)
    .min(1)
    .describe(
      'At least one policy citation per flag. Quote MUST appear verbatim in ' +
        'the cited policy_doc — pre-extracted candidates are surfaced in the ' +
        'user message; prefer those.'
    ),
});
export type PolicyFlag = z.infer<typeof PolicyFlagSchema>;

/* ─── Tool result schemas (one per deterministic tool) ──────────────────── */

export const DocumentInventorySchema = z.object({
  intake_xlsx: z.boolean(),
  vendor_email_txt: z.boolean(),
  quote_csv: z.boolean(),
  security_questionnaire_md: z.boolean(),
  contract_pdf: z.boolean(),
  parsed_fields: z.record(z.string(), z.unknown()),
  missing: z.array(z.string()),
});
export type DocumentInventory = z.infer<typeof DocumentInventorySchema>;

export const BudgetCheckSchema = z.object({
  cost_center: z.string(),
  department: z.string().nullable(),
  annual_budget_remaining: z.number().nullable(),
  budget_owner: z.string().nullable(),
  found: z.boolean(),
  sufficient_for_contract: z.boolean().nullable(),
  headroom_after_contract: z.number().nullable(),
});
export type BudgetCheck = z.infer<typeof BudgetCheckSchema>;

export const DuplicateCheckResultSchema = z.object({
  vendor_name: z.string(),
  match_type: z.enum(['exact', 'fuzzy', 'none']),
  matched_vendor: z
    .object({
      vendor_name: z.string(),
      vendor_id: z.string(),
      status: z.string(),
      category: z.string(),
      owner: z.string(),
    })
    .nullable(),
  confidence: z.number().min(0).max(1),
});
export type DuplicateCheckResult = z.infer<typeof DuplicateCheckResultSchema>;

export const TotalContractValueSchema = z.object({
  acv_usd: z.number().nonnegative(),
  term_months: z.number().int().positive(),
  one_time_usd: z.number().nonnegative(),
  tcv_usd: z.number().nonnegative(),
  formula: z.string(),
});
export type TotalContractValue = z.infer<typeof TotalContractValueSchema>;

export const DataClassSchema = z.enum(['public', 'internal', 'confidential', 'restricted']);
export type DataClass = z.infer<typeof DataClassSchema>;

export const DataSensitivityResultSchema = z.object({
  data_class: DataClassSchema,
  rationale: z.string(),
  signals: z.array(z.string()),
});
export type DataSensitivityResult = z.infer<typeof DataSensitivityResultSchema>;

export const RequiredApproverSchema = z.enum([
  'business_owner',
  'procurement_manager',
  'vp_finance',
  'cfo',
  'executive_sponsor',
  'legal',
  'security',
]);
export type RequiredApprover = z.infer<typeof RequiredApproverSchema>;

export const RequiredApprovalsSchema = z.object({
  approvers: z.array(RequiredApproverSchema),
  // partialRecord: only triggered approvers have rationales; non-triggered keys are absent.
  rationale_per_approver: z.partialRecord(RequiredApproverSchema, z.string()),
});
export type RequiredApprovals = z.infer<typeof RequiredApprovalsSchema>;

export const VendorFollowupDraftSchema = z.object({
  subject: z.string(),
  body: z.string(),
  missing_items: z.array(z.string()),
  is_draft: z.literal(true),
});
export type VendorFollowupDraft = z.infer<typeof VendorFollowupDraftSchema>;

export const EscalationTicketSchema = z.object({
  reason: z.string(),
  severity: z.enum(['warn', 'block', 'critical']),
  routed_to: z.array(RequiredApproverSchema),
  created_at: z.string(),
});
export type EscalationTicket = z.infer<typeof EscalationTicketSchema>;

/* ─── Audit trail ───────────────────────────────────────────────────────── */

export const ToolCallRecordSchema = z.object({
  tool_name: z.enum([
    'validate_required_documents',
    'lookup_budget',
    'check_existing_vendor',
    'calculate_total_contract_value',
    'classify_data_sensitivity',
    'determine_required_approvals',
    'draft_vendor_followup',
    'escalate_to_human',
    'read_policy',
    'validate_citations',
  ]),
  display_label: z.string(),
  args_summary: z.record(z.string(), z.unknown()),
  result_summary: z.record(z.string(), z.unknown()),
  ran_at: z.string(),
  duration_ms: z.number().nonnegative(),
});
export type ToolCallRecord = z.infer<typeof ToolCallRecordSchema>;

/* ─── Human-in-the-loop verdict (set ONLY after operator click) ─────────── */

/**
 * SPEC §9 enforcement model — read this before changing the verdict enum.
 *
 * §9 forbids the AGENT from approving spend, NOT the operator. The operator's
 * 'approved' verdict here is the entire purpose of the HITL gate. The §9
 * line is held by these structural protections, not the field name:
 *
 *   1. `HumanDecision` is only written by `humanApprovalNode` (nodes.ts),
 *      which consumes the value returned by LangGraph's `interrupt()` call.
 *      The interrupt resume comes from `/api/resume` (route.ts), which Zod-
 *      parses the body against `HumanDecisionSchema` before invoking the
 *      graph with `Command({ resume: decision })`.
 *   2. The LLM has no tool that returns a `HumanDecision`; the agent cannot
 *      forge an "approved by the operator" record because no LLM call site
 *      writes to this field.
 *   3. The graph entry state is `await_run` — the agent does not auto-run.
 *      The operator's Run button is the first §9 gate; the Approve button
 *      is the second.
 *
 * If you ever add a new code path that writes `human_decision`, it must
 * originate from a Command-resume sourced through `/api/resume`. Anything
 * else is a §9 violation.
 */
export const HumanDecisionSchema = z.object({
  // Four-button operator model.
  // - approved: vendor submitted everything; no flags.
  // - rejected: red flags; vendor must resubmit required paperwork.
  // - escalated: CEO approval is needed (out-of-band executive routing).
  // - follow_up: pending — vendor must submit additional paperwork before approval.
  // The agent's recommended_action enum (RecommendedActionSchema) is separate
  // and unchanged — the agent recommends, the human decides.
  verdict: z.enum(['approved', 'rejected', 'escalated', 'follow_up']),
  notes: z.string().nullable(),
  decided_at: z.string(),
  decided_by: z.string(),
  edits_applied: z.record(z.string(), z.unknown()).nullable(),
});
export type HumanDecision = z.infer<typeof HumanDecisionSchema>;

/* ─── DecisionPacket — single artifact returned to the operator ─────────── */

export const RecommendedActionSchema = z.enum([
  'approve_with_followup',
  'escalate',
  'block',
]);
export type RecommendedAction = z.infer<typeof RecommendedActionSchema>;

export const RiskTierSchema = z.enum(['low', 'medium', 'high']);
export type RiskTier = z.infer<typeof RiskTierSchema>;

export const DecisionPacketSchema = z.object({
  case_id: z.string(),
  vendor_name: z.string(),
  intake_summary: z.string().max(2000),
  missing_items: z.array(z.string()),
  risk_tier: RiskTierSchema,
  data_class: DataClassSchema,
  budget: BudgetCheckSchema,
  tcv: TotalContractValueSchema,
  duplicate_vendor: DuplicateCheckResultSchema,
  policy_flags: z.array(PolicyFlagSchema),
  required_approvers: z.array(RequiredApproverSchema),
  recommended_action: RecommendedActionSchema,
  draft_vendor_email: VendorFollowupDraftSchema.nullable(),
  draft_internal_ticket: z.string(),
  tools_called: z.array(ToolCallRecordSchema),
  human_decision: HumanDecisionSchema.nullable(),
  generated_at: z.string(),
  // v0.10 Item 11: 2-3 sentence internal rationale from the LLM. Surfaced in
  // logs + LangSmith traces; not rendered in the UI or vendor email. Optional
  // because deterministic-only paths (assembleEscalationPacket, mock outputs)
  // don't have an LLM-emitted rationale.
  rationale: z.string().max(1200).optional(),
  // Set true when the packet was assembled from the deterministic-only
  // fallback (LLM composition failed or schema parse rejected the LLM JSON).
  // Surfaced in the UI so the operator can tell a degraded packet from a
  // full LLM run without reading logs. Defaults to false for normal runs.
  degraded_mode: z.boolean().default(false),
  degraded_reason: z.string().nullable().optional(),
});
export type DecisionPacket = z.infer<typeof DecisionPacketSchema>;

/* ─── Agent state (LangGraph channels) ──────────────────────────────────── */

export const RunStatusSchema = z.enum([
  'await_run',
  'parsing',
  'validating',
  'tooling',
  'reasoning',
  'awaiting_human',
  'decided',
  'escalated',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AgentStateSchema = z.object({
  case_id: z.string(),
  run_status: RunStatusSchema,
  current_node: z.string().nullable(),
  document_inventory: DocumentInventorySchema.nullable(),
  budget: BudgetCheckSchema.nullable(),
  duplicate_vendor: DuplicateCheckResultSchema.nullable(),
  tcv: TotalContractValueSchema.nullable(),
  data_sensitivity: DataSensitivityResultSchema.nullable(),
  required_approvals: RequiredApprovalsSchema.nullable(),
  policy_flags: z.array(PolicyFlagSchema),
  decision_packet: DecisionPacketSchema.nullable(),
  tools_called: z.array(ToolCallRecordSchema),
  human_decision: HumanDecisionSchema.nullable(),
  error: z.string().nullable(),
  // v0.10 Item 9: heuristic top-K policy clauses per flag-trigger, written by
  // the extract_candidate_clauses node and consumed by runLlmComposition's
  // user-message payload. Keyed by FlagTrigger; values are up to 6 verbatim
  // policy lines prefixed with their doc name.
  candidate_clauses: z.record(z.string(), z.array(z.string())).nullable(),
});
export type AgentState = z.infer<typeof AgentStateSchema>;
