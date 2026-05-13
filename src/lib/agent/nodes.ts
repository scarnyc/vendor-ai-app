import { interrupt } from '@langchain/langgraph';
import {
  validateRequiredDocuments,
  lookupBudget,
  checkExistingVendor,
  calculateTotalContractValue,
  classifyDataSensitivity,
  determineRequiredApprovals,
  buildVendorFollowupDraft,
  escalateToHuman,
  recordToolCall,
  type ApprovalInputs,
} from './tools';
import { validateCitations, readPolicy } from './policies';
import { getMockOutput } from './mocks';
import { activeProvider, getLlm } from './llm';
import { buildSystemPrompt } from './prompts';
import {
  type AgentState,
  type DecisionPacket,
  type HumanDecision,
  type PolicyFlag,
  type RiskTier,
  type VendorFollowupDraft,
  DecisionPacketSchema,
} from './schemas';

type StateUpdate = Partial<AgentState>;

/* ─── Node 1: await_run ─────────────────────────────────────────────────── */
/* Operator presses Run to advance from this state. The graph entry point
 * sets run_status=await_run; this node only fires after the operator's
 * Command(resume) clears the gate. */
export async function awaitRunNode(state: AgentState): Promise<StateUpdate> {
  return {
    run_status: 'parsing',
    current_node: 'await_run',
  };
}

/* ─── Node 2: parse_inputs ──────────────────────────────────────────────── */
export async function parseInputsNode(state: AgentState): Promise<StateUpdate> {
  const startedAt = Date.now();
  const inventory = await validateRequiredDocuments(state.case_id);
  return {
    document_inventory: inventory,
    current_node: 'parse_inputs',
    run_status: 'validating',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'validate_required_documents',
        { case_id: state.case_id },
        {
          present: Object.entries(inventory)
            .filter(([k, v]) => k !== 'parsed_fields' && k !== 'missing' && v === true)
            .map(([k]) => k),
          missing: inventory.missing,
        },
        startedAt
      ),
    ],
  };
}

/* ─── Branch: package complete enough to triage? ───────────────────────── */
/* "Complete enough" = has the four intake fields needed to do tool math
 * (vendor_name, cost_center, ACV, term_months). Missing supporting docs like
 * SOC 2 II are *flags*, not parser blockers. */
export function isPackageComplete(state: AgentState): 'normalize_facts' | 'identify_missing' {
  const inv = state.document_inventory;
  if (!inv) return 'identify_missing';
  const blockingFields = inv.missing.filter((m) => m.startsWith('intake_field:'));
  return blockingFields.length === 0 ? 'normalize_facts' : 'identify_missing';
}

/* ─── Node 3: normalize_facts (yes branch) ─────────────────────────────── */
export async function normalizeFactsNode(state: AgentState): Promise<StateUpdate> {
  const inv = state.document_inventory!;
  const fields = inv.parsed_fields;

  // Coerce ACV — intake xlsx may store as string with $ + commas
  const acv = coerceMoney(fields.annual_contract_value);
  const oneTime = coerceMoney(fields.one_time_fees ?? 0);
  const termMonths = Number(fields.contract_term_months) || 12;
  const costCenter = String(fields.cost_center ?? '').trim();
  const vendorName = String(fields.vendor_name ?? '').trim();
  const paymentTerms = String(fields.payment_terms ?? 'Net 30');
  const dataDescription = String(
    fields.data_description ??
      fields.systems_or_data_in_scope ??
      fields.data_in_scope ??
      ''
  );

  return {
    current_node: 'normalize_facts',
    run_status: 'tooling',
    document_inventory: {
      ...inv,
      parsed_fields: {
        ...fields,
        _normalized: { acv, oneTime, termMonths, costCenter, vendorName, paymentTerms, dataDescription },
      },
    },
  };
}

/* ─── Node 4: run_deterministic_tools ──────────────────────────────────── */
export async function runDeterministicToolsNode(state: AgentState): Promise<StateUpdate> {
  const inv = state.document_inventory!;
  const norm = (inv.parsed_fields._normalized ?? {}) as {
    acv: number;
    oneTime: number;
    termMonths: number;
    costCenter: string;
    vendorName: string;
    paymentTerms: string;
    dataDescription: string;
  };

  const records = [...state.tools_called];

  // Run independent tools in parallel
  let bStart = Date.now();
  const budget = await lookupBudget(norm.costCenter, norm.acv);
  records.push(
    recordToolCall(
      'lookup_budget',
      { cost_center: norm.costCenter, acv: norm.acv },
      {
        found: budget.found,
        annual_budget_remaining: budget.annual_budget_remaining,
        sufficient_for_contract: budget.sufficient_for_contract,
        budget_owner: budget.budget_owner,
      },
      bStart
    )
  );

  bStart = Date.now();
  const dup = await checkExistingVendor(norm.vendorName);
  records.push(
    recordToolCall(
      'check_existing_vendor',
      { vendor_name: norm.vendorName },
      { match_type: dup.match_type, confidence: dup.confidence },
      bStart
    )
  );

  bStart = Date.now();
  const tcv = calculateTotalContractValue(norm.acv, norm.termMonths, norm.oneTime);
  records.push(
    recordToolCall(
      'calculate_total_contract_value',
      { acv: norm.acv, term_months: norm.termMonths, one_time: norm.oneTime },
      { tcv_usd: tcv.tcv_usd, formula: tcv.formula },
      bStart
    )
  );

  return {
    budget,
    duplicate_vendor: dup,
    tcv,
    tools_called: records,
    current_node: 'run_deterministic_tools',
  };
}

/* ─── Node 5: classify_data_sensitivity ────────────────────────────────── */
/* Edit-and-re-run loop edge re-enters here. */
export async function classifyDataSensitivityNode(state: AgentState): Promise<StateUpdate> {
  const fields = state.document_inventory?.parsed_fields ?? {};
  const norm = fields._normalized as { dataDescription?: string } | undefined;
  const description = (norm?.dataDescription ?? '') +
    ' ' +
    String(fields.security_questionnaire ?? '');
  const startedAt = Date.now();
  const result = classifyDataSensitivity(description);
  return {
    data_sensitivity: result,
    current_node: 'classify_data_sensitivity',
    run_status: 'reasoning',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'classify_data_sensitivity',
        { description_length: description.length },
        { data_class: result.data_class, signal_count: result.signals.length },
        startedAt
      ),
    ],
  };
}

/* ─── Node 6: determine_required_approvals ─────────────────────────────── */
export async function determineRequiredApprovalsNode(state: AgentState): Promise<StateUpdate> {
  const inv = state.document_inventory!;
  const norm = inv.parsed_fields._normalized as {
    acv: number;
    termMonths: number;
    paymentTerms: string;
  };
  const tcv = state.tcv!.tcv_usd;
  const dataClass = state.data_sensitivity!.data_class;
  const sq = String(inv.parsed_fields.security_questionnaire ?? '').toLowerCase();

  const inputs: ApprovalInputs = {
    acv: norm.acv,
    tcv,
    term_months: norm.termMonths,
    payment_terms: norm.paymentTerms,
    data_class: dataClass,
    budget_sufficient: state.budget?.sufficient_for_contract ?? null,
    budget_found: state.budget?.found ?? false,
    has_personal_data: dataClass === 'restricted' || dataClass === 'confidential',
    has_foreign_subprocessor: /\b(eu|apac|emea|cross.border|subprocessor)\b/i.test(sq),
    uses_ai_on_company_data: /\b(ai|model|training|llm|ml)\b/i.test(sq),
    has_soc2_type_ii: /soc\s*2\s*type\s*ii/i.test(sq) && !/not\s*(yet|available)/i.test(sq),
    has_dpa: /\bdpa\b|\bdata\s+processing\s+agreement\b/i.test(sq) &&
      !/not\s*(yet|provided|available)/i.test(sq),
  };

  const startedAt = Date.now();
  const result = determineRequiredApprovals(inputs);
  return {
    required_approvals: result,
    current_node: 'determine_required_approvals',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'determine_required_approvals',
        inputs as unknown as Record<string, unknown>,
        { approvers: result.approvers },
        startedAt
      ),
    ],
  };
}

/* ─── Node 7: prepare_decision_packet (LLM-composed OR mocked) ─────────── */
export async function prepareDecisionPacketNode(state: AgentState): Promise<StateUpdate> {
  const provider = activeProvider();
  let llmOut;
  if (provider === 'mock') {
    llmOut = getMockOutput(state.case_id);
  } else {
    llmOut = await runLlmComposition(state);
  }

  const riskTier = computeRiskTier(state, llmOut.policy_flags);
  const draftEmail = buildDraftEmail(state, llmOut);

  const packet: DecisionPacket = {
    case_id: state.case_id,
    vendor_name: extractVendorName(state),
    intake_summary: llmOut.intake_summary,
    missing_items: state.document_inventory?.missing ?? [],
    risk_tier: riskTier,
    data_class: state.data_sensitivity!.data_class,
    budget: state.budget!,
    tcv: state.tcv!,
    duplicate_vendor: state.duplicate_vendor!,
    policy_flags: llmOut.policy_flags,
    required_approvers: state.required_approvals!.approvers,
    recommended_action: llmOut.recommended_action,
    draft_vendor_email: draftEmail,
    draft_internal_ticket: llmOut.draft_internal_ticket,
    tools_called: state.tools_called,
    human_decision: null,
    generated_at: new Date().toISOString(),
  };

  // Validate the assembled packet against the schema; fail loud if drift.
  const parsed = DecisionPacketSchema.safeParse(packet);
  if (!parsed.success) {
    return {
      error: `DecisionPacket schema validation failed: ${parsed.error.message}`,
      run_status: 'escalated',
    };
  }

  return {
    decision_packet: parsed.data,
    policy_flags: llmOut.policy_flags,
    current_node: 'prepare_decision_packet',
  };
}

/* ─── Node 8: validate_citations (deterministic gate) ──────────────────── */
export async function validateCitationsNode(state: AgentState): Promise<StateUpdate> {
  if (!state.decision_packet) return {};
  const allCitations = state.decision_packet.policy_flags.flatMap((f) => f.citations);
  const startedAt = Date.now();
  const { unverified } = await validateCitations(allCitations);

  let updatedFlags = state.decision_packet.policy_flags;
  if (unverified.length > 0) {
    updatedFlags = [
      ...updatedFlags,
      {
        severity: 'warn',
        issue: `${unverified.length} policy citation(s) could not be verified as a verbatim quote of the cited doc; the operator should treat them as suggestive rather than authoritative.`,
        recipient: 'procurement_manager',
        citations: [
          {
            policy_doc: 'communication_policy',
            section: 'Citation policy',
            quote: 'verified',
            verified: false,
          },
        ],
      },
    ];
  }

  return {
    decision_packet: {
      ...state.decision_packet,
      policy_flags: updatedFlags,
    },
    policy_flags: updatedFlags,
    current_node: 'validate_citations',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'validate_citations',
        { citations: allCitations.length },
        { verified: allCitations.length - unverified.length, unverified: unverified.length },
        startedAt
      ),
    ],
  };
}

/* ─── No-branch: identify_missing → draft_followup → escalate ──────────── */
export async function identifyMissingNode(state: AgentState): Promise<StateUpdate> {
  return {
    current_node: 'identify_missing',
    missing_items: state.document_inventory?.missing ?? [],
  } as StateUpdate;
}

export async function draftFollowupNode(state: AgentState): Promise<StateUpdate> {
  const inv = state.document_inventory!;
  const vendorName =
    String(inv.parsed_fields.vendor_name ?? 'the vendor');
  const startedAt = Date.now();
  const draft = buildVendorFollowupDraft(vendorName, null, inv.missing);
  return {
    current_node: 'draft_vendor_followup',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'draft_vendor_followup',
        { vendor_name: vendorName, missing_count: inv.missing.length },
        { is_draft: draft.is_draft, missing_items: draft.missing_items.length },
        startedAt
      ),
    ],
    decision_packet: assembleEscalationPacket(state, draft),
  };
}

export async function escalateNode(state: AgentState): Promise<StateUpdate> {
  const reason = `Case ${state.case_id} could not be triaged automatically — intake incomplete. Routed for human follow-up.`;
  const startedAt = Date.now();
  const ticket = escalateToHuman(reason, 'warn', ['procurement_manager']);
  return {
    current_node: 'escalate_to_human',
    run_status: 'escalated',
    tools_called: [
      ...state.tools_called,
      recordToolCall(
        'escalate_to_human',
        { reason, severity: 'warn' },
        { routed_to: ticket.routed_to, created_at: ticket.created_at },
        startedAt
      ),
    ],
  };
}

/* ─── HITL interrupt + resume ──────────────────────────────────────────── */
export async function humanApprovalNode(state: AgentState): Promise<StateUpdate> {
  if (!state.decision_packet) return { run_status: 'escalated' };

  const verdict = interrupt({
    type: 'human_approval_required',
    case_id: state.case_id,
    decision_packet: state.decision_packet,
  }) as HumanDecision;

  return {
    human_decision: verdict,
    decision_packet: { ...state.decision_packet, human_decision: verdict },
    current_node: 'human_approval',
    run_status: verdict.verdict === 'edit_and_rerun' ? 'reasoning' : 'decided',
  };
}

/* HITL → next-node router. Edit-and-re-run loops back to data classification
 * (LLM-driven nodes only); deterministic tools have already memoized. */
export function postHumanRouter(state: AgentState): 'classify_data_sensitivity' | 'emit_final' {
  return state.human_decision?.verdict === 'edit_and_rerun'
    ? 'classify_data_sensitivity'
    : 'emit_final';
}

/* ─── Final emission ───────────────────────────────────────────────────── */
export async function emitFinalNode(state: AgentState): Promise<StateUpdate> {
  return {
    current_node: 'emit_final',
    run_status: 'decided',
  };
}

/* ─── helpers ──────────────────────────────────────────────────────────── */

function coerceMoney(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v !== 'string') return 0;
  const cleaned = v.replace(/[$,\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function computeRiskTier(state: AgentState, flags: PolicyFlag[]): RiskTier {
  const dataClass = state.data_sensitivity?.data_class;
  if (flags.some((f) => f.severity === 'block') || dataClass === 'restricted') return 'high';
  if (
    flags.some((f) => f.severity === 'warn') ||
    dataClass === 'confidential' ||
    (state.tcv?.tcv_usd ?? 0) > 100_000
  ) {
    return 'medium';
  }
  return 'low';
}

function extractVendorName(state: AgentState): string {
  return String(state.document_inventory?.parsed_fields?.vendor_name ?? state.case_id);
}

function buildDraftEmail(
  state: AgentState,
  llmOut: { vendor_followup_body_lines: string[] }
): VendorFollowupDraft | null {
  if (state.document_inventory?.missing?.length === 0 && !needsFollowup(state)) {
    return null;
  }
  const vendorName = extractVendorName(state);
  const body = `Hello,

${llmOut.vendor_followup_body_lines.join('\n\n')}

Best,
Procurement
[DRAFT — pending procurement-owner review before send]`;
  return {
    subject: `[Vendor onboarding] Additional materials needed — ${vendorName}`,
    body,
    missing_items: state.document_inventory?.missing ?? [],
    is_draft: true,
  };
}

function needsFollowup(state: AgentState): boolean {
  return Boolean(
    state.document_inventory?.missing?.length ||
      (state.required_approvals?.approvers ?? []).includes('legal') ||
      (state.required_approvals?.approvers ?? []).includes('security')
  );
}

function assembleEscalationPacket(
  state: AgentState,
  draft: VendorFollowupDraft
): DecisionPacket {
  return {
    case_id: state.case_id,
    vendor_name: extractVendorName(state),
    intake_summary:
      'Intake package incomplete — required fields are missing. Cannot run full triage; routed to procurement for follow-up.',
    missing_items: state.document_inventory?.missing ?? [],
    risk_tier: 'low',
    data_class: 'internal',
    budget: state.budget ?? {
      cost_center: '',
      department: null,
      annual_budget_remaining: null,
      budget_owner: null,
      found: false,
      sufficient_for_contract: null,
      headroom_after_contract: null,
    },
    tcv: state.tcv ?? {
      acv_usd: 0,
      term_months: 12,
      one_time_usd: 0,
      tcv_usd: 0,
      formula: 'TCV not computed — intake incomplete.',
    },
    duplicate_vendor: state.duplicate_vendor ?? {
      vendor_name: extractVendorName(state),
      match_type: 'none',
      matched_vendor: null,
      confidence: 0,
    },
    policy_flags: [],
    required_approvers: ['procurement_manager'],
    recommended_action: 'escalate',
    draft_vendor_email: draft,
    draft_internal_ticket:
      'Intake incomplete — drafted vendor follow-up; awaiting procurement to send.',
    tools_called: state.tools_called,
    human_decision: null,
    generated_at: new Date().toISOString(),
  };
}

/* Real-LLM composition path — only invoked when LLM_PROVIDER !== 'mock'.
 * Deliberately strict: prompt the model for the LLM-composed parts only,
 * then validate each piece. Failure falls back to a minimal escalation. */
async function runLlmComposition(state: AgentState): Promise<{
  intake_summary: string;
  policy_flags: PolicyFlag[];
  recommended_action: DecisionPacket['recommended_action'];
  draft_internal_ticket: string;
  vendor_followup_body_lines: string[];
}> {
  const llm = getLlm({ temperature: 0, jsonMode: true });
  const sys = await buildSystemPrompt();
  const userMsg = JSON.stringify(
    {
      case_id: state.case_id,
      document_inventory: state.document_inventory,
      budget: state.budget,
      duplicate_vendor: state.duplicate_vendor,
      tcv: state.tcv,
      data_sensitivity: state.data_sensitivity,
      required_approvals: state.required_approvals,
    },
    null,
    2
  );

  const response = await llm.invoke([
    { role: 'system', content: sys },
    {
      role: 'user',
      content: `Compose the LLM-only fields of the DecisionPacket as a single JSON object with these keys exactly:
{
  "intake_summary": string (<120 words),
  "policy_flags": PolicyFlag[],
  "recommended_action": "approve_with_followup" | "escalate" | "block",
  "draft_internal_ticket": string,
  "vendor_followup_body_lines": string[]  // sentences/paragraphs to be assembled into the [DRAFT] vendor email body
}

Inputs:
${userMsg}

Return JSON only.`,
    },
  ]);

  const raw = typeof response.content === 'string' ? response.content : JSON.stringify(response.content);
  const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '');
  return JSON.parse(cleaned);
}

// Surface `readPolicy` for ad-hoc agent use later — not on the critical path
// today, but exposing it now so the citation lookup is a single import.
export { readPolicy };
