import {
  Annotation,
  StateGraph,
  START,
  END,
  MemorySaver,
} from '@langchain/langgraph';
import {
  awaitRunNode,
  parseInputsNode,
  isPackageComplete,
  normalizeFactsNode,
  runDeterministicToolsNode,
  classifyDataSensitivityNode,
  determineRequiredApprovalsNode,
  extractCandidateClausesNode,
  prepareDecisionPacketNode,
  validateCitationsNode,
  identifyMissingNode,
  draftFollowupNode,
  escalateNode,
  humanApprovalNode,
  postHumanRouter,
  emitFinalNode,
} from './nodes';
import type {
  BudgetCheck,
  DataSensitivityResult,
  DecisionPacket,
  DocumentInventory,
  DuplicateCheckResult,
  HumanDecision,
  PolicyFlag,
  RequiredApprovals,
  RunStatus,
  ToolCallRecord,
  TotalContractValue,
} from './schemas';

/**
 * State graph (DESIGN §16.7). Two WHYs worth preserving:
 *   - Overwrite reducers (no explicit `reducer:`): node code in nodes.ts
 *     already does explicit array concat for tools_called/policy_flags, so
 *     channel-level concat semantics would double-append. Keep concat in
 *     one place.
 *   - MemorySaver checkpointer: Vercel's ephemeral filesystem rules out
 *     SqliteSaver. thread_id rides the URL search params so a cold-start
 *     retry can resume cleanly.
 */
const StateAnnotation = Annotation.Root({
  case_id: Annotation<string>,
  run_status: Annotation<RunStatus>,
  current_node: Annotation<string | null>,
  document_inventory: Annotation<DocumentInventory | null>,
  budget: Annotation<BudgetCheck | null>,
  duplicate_vendor: Annotation<DuplicateCheckResult | null>,
  tcv: Annotation<TotalContractValue | null>,
  data_sensitivity: Annotation<DataSensitivityResult | null>,
  required_approvals: Annotation<RequiredApprovals | null>,
  policy_flags: Annotation<PolicyFlag[]>,
  decision_packet: Annotation<DecisionPacket | null>,
  tools_called: Annotation<ToolCallRecord[]>,
  human_decision: Annotation<HumanDecision | null>,
  error: Annotation<string | null>,
  // v0.10 Item 9: heuristic top-K policy clauses per flag-trigger, populated
  // by extract_candidate_clauses and consumed by runLlmComposition's user msg.
  candidate_clauses: Annotation<Record<string, string[]> | null>,
});

export type AgentStateAnnotation = typeof StateAnnotation.State;

const builder = new StateGraph(StateAnnotation)
  .addNode('await_run', awaitRunNode)
  .addNode('parse_inputs', parseInputsNode)
  .addNode('normalize_facts', normalizeFactsNode)
  .addNode('run_deterministic_tools', runDeterministicToolsNode)
  .addNode('classify_data_sensitivity', classifyDataSensitivityNode)
  .addNode('determine_required_approvals', determineRequiredApprovalsNode)
  .addNode('extract_candidate_clauses', extractCandidateClausesNode)
  .addNode('prepare_decision_packet', prepareDecisionPacketNode)
  .addNode('validate_citations', validateCitationsNode)
  .addNode('identify_missing', identifyMissingNode)
  .addNode('draft_vendor_followup', draftFollowupNode)
  .addNode('escalate_to_human', escalateNode)
  .addNode('human_approval', humanApprovalNode)
  .addNode('emit_final', emitFinalNode);

builder.addEdge(START, 'await_run');
builder.addEdge('await_run', 'parse_inputs');

// Branch on intake completeness.
builder.addConditionalEdges('parse_inputs', isPackageComplete, {
  normalize_facts: 'normalize_facts',
  identify_missing: 'identify_missing',
});

// Yes branch — full triage path.
builder.addEdge('normalize_facts', 'run_deterministic_tools');
builder.addEdge('run_deterministic_tools', 'classify_data_sensitivity');
builder.addEdge('classify_data_sensitivity', 'determine_required_approvals');
builder.addEdge('determine_required_approvals', 'extract_candidate_clauses');
builder.addEdge('extract_candidate_clauses', 'prepare_decision_packet');
builder.addEdge('prepare_decision_packet', 'validate_citations');
builder.addEdge('validate_citations', 'human_approval');

// HITL → emit final. Edit-and-re-run loop-back is deferred (see
// PRODUCTIONIZATION.md "Operator 'Edit' affordance — deferred").
builder.addConditionalEdges('human_approval', postHumanRouter, {
  emit_final: 'emit_final',
});

// No branch — incomplete intake.
builder.addEdge('identify_missing', 'draft_vendor_followup');
builder.addEdge('draft_vendor_followup', 'escalate_to_human');
builder.addEdge('escalate_to_human', END);

builder.addEdge('emit_final', END);

// Next.js dev (Turbopack) re-evaluates modules on Fast Refresh, which would
// replace a module-local `new MemorySaver()` with a fresh empty instance and
// silently drop every thread checkpoint. Cache on globalThis so the in-process
// singleton survives HMR. Harmless in prod — there's only one module load.
declare global {
  // eslint-disable-next-line no-var
  var __vendorai_checkpointer: MemorySaver | undefined;
}

globalThis.__vendorai_checkpointer ??= new MemorySaver();
const checkpointer = globalThis.__vendorai_checkpointer;

export const graph = builder.compile({ checkpointer });

/**
 * Fresh seed state for a case. Initializes arrays + nulls so node code can
 * rely on `state.tools_called` always being iterable.
 */
export function seedState(caseId: string): AgentStateAnnotation {
  return {
    case_id: caseId,
    run_status: 'await_run',
    current_node: null,
    document_inventory: null,
    budget: null,
    duplicate_vendor: null,
    tcv: null,
    data_sensitivity: null,
    required_approvals: null,
    policy_flags: [],
    decision_packet: null,
    tools_called: [],
    human_decision: null,
    error: null,
    candidate_clauses: null,
  };
}
