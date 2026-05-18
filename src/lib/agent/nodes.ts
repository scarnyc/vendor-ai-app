import { interrupt } from '@langchain/langgraph';
import { z } from 'zod';
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
import { extractCandidateClauses, validateCitations, readPolicy } from './policies';
import { getMockOutput } from './mocks';
import {
  activeProvider,
  composeWithSelfConsistency,
  getStructuredCompositionLlm,
  noteThreeStepDormantIfActive,
} from './llm';
import { buildSystemPrompt } from './prompts';
import {
  type AgentState,
  type DecisionPacket,
  type HumanDecision,
  type PolicyFlag,
  type RiskTier,
  type VendorFollowupDraft,
  DecisionPacketSchema,
  LlmPolicyFlagSchema,
  unverifiedCitation,
} from './schemas';

/**
 * Schema for the 5 LLM-composed fields of the DecisionPacket. Reuses
 * PolicyFlagSchema so structured-output forces the model to honor the
 * exact enum values (severity, recipient, citation.policy_doc) — closes
 * the silent failure where free-form JSON drifted off-schema and Zod
 * validation downstream nulled the whole packet.
 *
 * v0.8: `.min(1).max(8)` on policy_flags is the deterministic floor/ceiling.
 *   - .min(1): catches the silent no-flag emission (every case has at least
 *     routing-critical info worth surfacing).
 *   - .max(8): catches case_003-class runaway over-flagging. When the model
 *     emits >8 flags the schema parse fails, the v0.7 fallback packet path
 *     fires, and the operator sees a single-flag degraded packet rather
 *     than a wall of noise.
 */
const LlmCompositionSchema = z.object({
  intake_summary: z
    .string()
    .max(900)
    .describe(
      'One-paragraph executive summary of the vendor and the engagement. ' +
        '≤120 words. Plain English; assume the reader sees the packet without ' +
        'reading the intake docs.'
    ),
  policy_flags: z
    .array(LlmPolicyFlagSchema)
    .min(1)
    .max(8)
    .describe(
      'Concrete policy concerns or follow-ups. 2 flags (mostly info) for ' +
        'low-risk paperwork renewals; EXACTLY 3 (2 warn + 1 info) for ' +
        'medium-risk new-vendor + PII; 6 (mix with ≥1 block) for high-risk ' +
        'restricted-data or AI-training cases. Each flag MUST cite a ' +
        'verbatim policy quote — see CITATION RULES in the system prompt.'
    ),
  recommended_action: z
    .enum(['approve_with_followup', 'escalate', 'block'])
    .describe(
      'approve_with_followup = procurement signs off pending paperwork. ' +
        'escalate = decision lifts to CFO/CISO/executive sponsor. ' +
        'block = engagement cannot proceed at any approval level (rare; ' +
        'reserve for hard policy violations like training on restricted ' +
        'PII with no contractual opt-out).'
    ),
  draft_internal_ticket: z
    .string()
    .max(4000)
    .describe(
      'Markdown body of the internal Jira/Linear ticket procurement will ' +
        'file. ≤500 words. Lead with the recommended action; follow with the 2-3 ' +
        'highest-leverage flags; close with the named approvers. No ' +
        'vendor-facing language here — this is the procurement-team-internal view. ' +
        'DO NOT append "End of document", "*(End.)*", separators, or any ' +
        'trailing padding markers — stop after the approvers line.'
    ),
  vendor_followup_body_lines: z
    .array(z.string())
    .describe(
      'BODY PARAGRAPHS ONLY of the vendor follow-up email — one paragraph ' +
        'per array element. The system wraps the output with greeting + signoff; ' +
        'do NOT include "Hi <name>", "Hello", "Best", "Regards", signatures, ' +
        'or the [DRAFT] marker yourself. Empty/whitespace-only entries are ' +
        'not allowed.'
    ),
  rationale: z
    .string()
    .max(1200)
    .describe(
      '2-4 sentences explaining the chosen recommended_action AND the chosen ' +
        'severity mix. Keep concise — under ~800 chars. Internal-only — ' +
        'surfaced in the agent log and LangSmith trace, not in the UI or vendor ' +
        'email. Forces the model to articulate the trade-off so wrong answers ' +
        'are debuggable in seconds.'
    ),
});
type LlmComposition = z.infer<typeof LlmCompositionSchema>;

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
  // v0.10.2: prefer the deterministic ai_involvement intake field over a
  // regex on the security questionnaire prose. The old `\b(ai|model|...)\b`
  // pattern fired on the questionnaire's `## AI/model training` section
  // header regardless of whether the content was a positive or negative
  // assertion, which routed false positives to security review.
  const aiInvolvement = String(inv.parsed_fields.ai_involvement ?? '').toLowerCase();

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
    uses_ai_on_company_data:
      aiInvolvement === 'training_on_customer_data' ||
      (aiInvolvement === '' && /\btraining\s+on\s+customer\s+data\b/i.test(sq)),
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

/* ─── Node 6.5: extract_candidate_clauses (Item 9b) ─────────────────────
 * Heuristic top-K policy-clause pre-extraction. Runs in <50ms, populates
 * state.candidate_clauses keyed by FlagTrigger, then runLlmComposition's
 * user-message payload surfaces those clauses so the LLM can quote them
 * verbatim. Pushes citation `verified` ratio toward ≥99% and reduces
 * fabrication of policy quotes.
 */
export async function extractCandidateClausesNode(state: AgentState): Promise<StateUpdate> {
  const startedAt = Date.now();
  const candidates = await extractCandidateClauses(state);
  if (process.env.LLM_DEBUG_CANDIDATES === '1') {
    const summary = Object.entries(candidates)
      .map(([k, v]) => `${k}=${v.length}`)
      .join(' ');
    console.log(`[extract_candidate_clauses] ${summary || '(no triggers fired)'}`);
  }
  void startedAt;
  return {
    candidate_clauses: candidates,
    current_node: 'extract_candidate_clauses',
  };
}

/* ─── Node 7: prepare_decision_packet (LLM-composed OR mocked) ─────────── */
export async function prepareDecisionPacketNode(state: AgentState): Promise<StateUpdate> {
  const provider = activeProvider();
  let llmOut: LlmComposition;
  let llmFailed = false;
  let llmFailureReason: string | null = null;

  // Item 12 scaffold notification (default off — single-shot continues to run).
  noteThreeStepDormantIfActive();

  if (provider === 'mock') {
    const mock = getMockOutput(state.case_id);
    // Mock fixtures pre-date the schema split — strip the runtime-only
    // `verified` field off citations so the shape matches LlmPolicyFlag, and
    // synthesize a rationale (mocks don't carry one).
    llmOut = {
      intake_summary: mock.intake_summary,
      policy_flags: mock.policy_flags.map((f) => ({
        severity: f.severity,
        issue: f.issue,
        recipient: f.recipient,
        citations: f.citations.map((c) => ({
          policy_doc: c.policy_doc,
          section: c.section,
          quote: c.quote,
        })),
      })),
      recommended_action: mock.recommended_action,
      draft_internal_ticket: mock.draft_internal_ticket,
      vendor_followup_body_lines: mock.vendor_followup_body_lines,
      rationale: 'Mock fixture — deterministic output for dev/CI; rationale not synthesized.',
    };
  } else {
    try {
      const initial = await runLlmComposition(state);
      // Item 10 borderline detector: if the LLM's emitted recommended_action
      // disagrees with the deterministic risk math (block-severity → high,
      // warn → medium, else low), resample 3× and pick the median flag count.
      // Happy-path stays single-shot; only triggers on the cases where the
      // model and the post-LLM normalization disagree.
      const initialRisk = computeRiskTier(state, initial.policy_flags);
      const llmRiskFromAction =
        initial.recommended_action === 'block'
          ? 'high'
          : initial.recommended_action === 'escalate'
            ? 'high'
            : initialRisk === 'low'
              ? 'low'
              : 'medium';
      const borderline = initialRisk !== llmRiskFromAction;
      if (borderline) {
        console.log(
          `[prepare_decision_packet] borderline detected (det=${initialRisk}, llm=${llmRiskFromAction}) — running 3-sample self-consistency`
        );
        llmOut = await composeWithSelfConsistency(
          () => runLlmComposition(state),
          (s) => s.policy_flags.length,
          3
        );
      } else {
        llmOut = initial;
      }
      console.log(`[prepare_decision_packet] success — case=${state.case_id} action=${llmOut.recommended_action}`);
    } catch (err) {
      console.error('[prepare_decision_packet] LLM composition failed:', err);
      llmOut = buildLlmCompositionFallback(state, err);
      llmFailed = true;
      llmFailureReason =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : `LLM composition failed: ${String(err).slice(0, 200)}`;
    }
  }

  // Promote each LLM-emitted flag to a runtime PolicyFlag by wrapping its
  // citations through unverifiedCitation(). The LLM JSON schema has no
  // `verified` field; validateCitationsNode is the only writer that flips
  // verified→true after a verbatim substring check against the policy doc.
  const runtimeFlags: PolicyFlag[] = llmOut.policy_flags.map((f) => ({
    ...f,
    citations: f.citations.map(unverifiedCitation),
  }));

  const riskTier = computeRiskTier(state, runtimeFlags);
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
    policy_flags: runtimeFlags,
    required_approvers: state.required_approvals!.approvers,
    recommended_action: llmOut.recommended_action,
    draft_vendor_email: draftEmail,
    draft_internal_ticket: llmOut.draft_internal_ticket,
    tools_called: state.tools_called,
    human_decision: null,
    generated_at: new Date().toISOString(),
    rationale: llmOut.rationale,
    degraded_mode: llmFailed,
    ...(llmFailed && llmFailureReason ? { degraded_reason: llmFailureReason } : {}),
  };

  // Belt-and-suspenders: validate the assembled packet against the schema.
  // After structured-output + the always-emit fallback, this should only fire
  // on a bug in the deterministic merge — never on LLM output drift.
  const parsed = DecisionPacketSchema.safeParse(packet);
  if (!parsed.success) {
    console.error('[prepare_decision_packet] Zod validation failed:', JSON.stringify(parsed.error.issues, null, 2));
    console.error('[prepare_decision_packet] LLM-composed fields:', JSON.stringify(llmOut, null, 2));
    return {
      error: `DecisionPacket schema validation failed: ${parsed.error.message}`,
      run_status: 'escalated',
    };
  }

  return {
    decision_packet: parsed.data,
    policy_flags: runtimeFlags,
    current_node: 'prepare_decision_packet',
    ...(llmFailed ? { run_status: 'escalated' as const } : {}),
  };
}

/* ─── Node 8: validate_citations (deterministic gate) ──────────────────── */
/* v0.8: Two changes from v0.7:
 *   1. Write the per-citation `verified` boolean BACK into the packet's flags
 *      so the FE can render the unverified state on the relevant CitationChip
 *      (the v0.7 node computed verification but only used it for a meta-flag,
 *      leaving the citation's own `verified` field at its default false).
 *   2. No meta-flag synthesis. v0.7 appended a warn-severity "N citations
 *      could not be verified" flag with `recipient: 'procurement_manager'`
 *      and a fake citation — that flag had no policy in scope and polluted
 *      policy_flags. The visual surface (CitationChip's ⚠ glyph) replaces it.
 *
 * The tool record still reports verified/unverified counts so the audit
 * trail keeps the diagnostic for LangSmith / operator inspection. */
export async function validateCitationsNode(state: AgentState): Promise<StateUpdate> {
  if (!state.decision_packet) {
    console.error('[validate_citations] reached with no decision_packet — graph wiring bug');
    return {
      run_status: 'escalated',
      error: 'validate_citations reached with no decision_packet (graph wiring bug)',
    };
  }
  const allCitations = state.decision_packet.policy_flags.flatMap((f) => f.citations);
  const startedAt = Date.now();

  let unverified;
  try {
    ({ unverified } = await validateCitations(allCitations));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error('[validate_citations] verbatim-substring check threw', err);
    // §9 protection: a packet whose citations could not be verified must
    // NOT reach the operator as if validated. Escalate and surface the
    // reason; downstream stream.ts gates STATE_SNAPSHOT on absence of `error`.
    return {
      run_status: 'escalated',
      error: `citation_validation_failed: ${reason}`,
      current_node: 'validate_citations',
      tools_called: [
        ...state.tools_called,
        recordToolCall(
          'validate_citations',
          { citations: allCitations.length },
          { error: reason },
          startedAt
        ),
      ],
    };
  }

  const unverifiedKeys = new Set(
    unverified.map((c) => `${c.policy_doc}|${c.section}|${c.quote}`)
  );
  const updatedFlags = state.decision_packet.policy_flags.map((flag) => ({
    ...flag,
    citations: flag.citations.map((c) => ({
      ...c,
      verified: !unverifiedKeys.has(`${c.policy_doc}|${c.section}|${c.quote}`),
    })),
  }));

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

  // T1.4: Three-verdict model — approved/rejected go to decided;
  // escalated marks the packet as routed out-of-band to the CFO.
  const runStatus = verdict.verdict === 'escalated' ? 'escalated' : 'decided';

  return {
    human_decision: verdict,
    decision_packet: { ...state.decision_packet, human_decision: verdict },
    current_node: 'human_approval',
    run_status: runStatus,
  };
}

/* HITL → next-node router. All three verdicts terminate at emit_final;
 * the Edit & re-run loop-back is deferred (see PRODUCTIONIZATION.md). */
export function postHumanRouter(_state: AgentState): 'emit_final' {
  return 'emit_final';
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

function computeRiskTier(
  state: AgentState,
  flags: ReadonlyArray<{ severity: 'info' | 'warn' | 'block' }>
): RiskTier {
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

/* v0.10 Item 5c: regex-based per-element strip pass. Strict closer pattern —
 * does NOT match "Thank you for providing the security questionnaire." (body
 * content); only matches lines that are JUST a closer keyword. Preserves
 * internal structure of multi-line paragraphs (numbered lists stay intact). */
const GREETING_RE = /^\s*(hi|hello|hey|dear|greetings)\b[^\n]{0,40}[,!.]?\s*$/i;
const CLOSER_RE =
  /^\s*(best|kind\s+regards|regards|sincerely|cheers|warm\s+regards|warmly|with\s+thanks)\s*[,.!]?\s*$/i;
const DRAFT_TAG_RE = /\[draft[^\]]*\]/i;
const SIGNATURE_LINE_RE =
  /^\s*(procurement(\s+team)?|the\s+procurement\s+team|--+)\s*$/i;

function stripFrame(s: string): string {
  const ls = s.split(/\r?\n/);
  while (ls.length && (GREETING_RE.test(ls[0]) || !ls[0].trim())) {
    ls.shift();
  }
  while (
    ls.length &&
    (CLOSER_RE.test(ls[ls.length - 1]) ||
      SIGNATURE_LINE_RE.test(ls[ls.length - 1]) ||
      DRAFT_TAG_RE.test(ls[ls.length - 1]) ||
      !ls[ls.length - 1].trim())
  ) {
    ls.pop();
  }
  return ls.join('\n').trim();
}

function stripFrameLines(lines: string[]): string[] {
  return lines.map(stripFrame).filter((s) => s.length > 0);
}

function buildDraftEmail(
  state: AgentState,
  llmOut: { vendor_followup_body_lines: string[] }
): VendorFollowupDraft | null {
  if (state.document_inventory?.missing?.length === 0 && !needsFollowup(state)) {
    return null;
  }
  const vendorName = extractVendorName(state);
  let paragraphs = stripFrameLines(llmOut.vendor_followup_body_lines);
  if (paragraphs.length === 0) {
    console.warn(
      '[buildDraftEmail] stripFrameLines removed all paragraphs — falling back to raw entries'
    );
    paragraphs = llmOut.vendor_followup_body_lines
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  const body = `Hello,\n\n${paragraphs.join('\n\n')}\n\nBest,\nProcurement\n[DRAFT — pending procurement-owner review before send]`;
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
    degraded_mode: true,
    degraded_reason: 'Intake incomplete — deterministic-only escalation path (no LLM composition).',
  };
}

/* Real-LLM composition path — only invoked when LLM_PROVIDER !== 'mock'.
 * Uses getStructuredLlm() so DeepSeek's tool-calling is constrained to
 * LlmCompositionSchema; closes the silent-failure surface where free-form
 * JSON drifted off the strict PolicyFlag enums (severity, recipient,
 * citation.policy_doc) and Zod nulled the whole packet downstream. */
async function runLlmComposition(state: AgentState): Promise<LlmComposition> {
  // Anthropic forces temperature=1 (thinking enabled); DeepSeek lane defaults
  // to 0 inside the factory. Determinism comes from the bound schema, not temp.
  const structured = getStructuredCompositionLlm(LlmCompositionSchema, {
    name: 'compose_decision_packet',
  });
  const sys = await buildSystemPrompt(state);
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

  // v0.10 Item 9c: surface heuristic top-K policy clauses so the model can
  // quote VERBATIM instead of improvising. Pushes citation `verified` ratio
  // toward ≥99% and reduces flag fabrication.
  const candidatesBlock = Object.entries(state.candidate_clauses ?? {})
    .map(
      ([trigger, lines]) =>
        `## ${trigger}\n${lines.map((l) => `  • ${l}`).join('\n')}`
    )
    .join('\n\n');

  return await structured.invoke([
    { role: 'system', content: sys },
    {
      role: 'user',
      content:
        `Call compose_decision_packet with the structured payload for this case.\n\n` +
        `Constraints:\n` +
        `- intake_summary ≤120 words\n` +
        `- every policy_flags[].citations[].policy_doc must be one of the seven enumerated policy doc names\n` +
        `- severity is one of: info | warn | block (match to the deterministic risk math in the system prompt)\n` +
        `- quote citations VERBATIM from the candidate list below when applicable (verbatim text dramatically improves verification)\n\n` +
        (candidatesBlock
          ? `## CANDIDATE POLICY CLAUSES (use these verbatim when relevant)\n\n${candidatesBlock}\n\n`
          : '') +
        `## INPUTS\n${userMsg}`,
    },
  ]);
}

/* Always-emit fallback used when runLlmComposition throws (LLM error,
 * structured-output validation failure, transport error). Returns a
 * structurally-valid LlmComposition so the downstream merge + Zod gate
 * succeed and the UI always renders a packet. The single block-severity
 * flag is the operator's signal that automated narrative composition
 * failed and manual review is required. */
function buildLlmCompositionFallback(
  state: AgentState,
  err: unknown
): LlmComposition {
  const errMsg = err instanceof Error ? err.message : String(err);
  return {
    intake_summary:
      `Automated narrative composition failed (${errMsg.slice(0, 200)}). ` +
      `Deterministic facts (budget, TCV, duplicate check, data class) are ` +
      `available below; operator should compose the narrative manually.`,
    policy_flags: [
      {
        severity: 'block',
        issue:
          'LLM composition step failed; manual operator review required ' +
          'before any vendor follow-up or approval routing.',
        recipient: 'procurement_manager',
        citations: [
          {
            policy_doc: 'procurement_policy',
            section: 'system_fallback',
            quote:
              'Decision routed to operator after automated composition failure.',
          },
        ],
      },
    ],
    recommended_action: 'escalate',
    draft_internal_ticket:
      `[FALLBACK] Manual review needed for ${state.case_id} — ` +
      `automated narrative composition failed.`,
    vendor_followup_body_lines: [],
    rationale:
      'Automated composition failed; escalating to operator review so a human ' +
      'can verify deterministic facts and compose the narrative manually.',
  };
}

// Surface `readPolicy` for ad-hoc agent use later — not on the critical path
// today, but exposing it now so the citation lookup is a single import.
export { readPolicy };
