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
 * v0.6 state graph (DESIGN §16.7) — wires the 14 nodes from nodes.ts into the
 * PNG topology with two structural changes vs §6g:
 *   1. await_run is the new initial state — operator's Run button issues
 *      Command({resume: "run"}) to pass through awaitRunNode.
 *   2. Edit-and-re-run loops from human_approval back to
 *      classify_data_sensitivity (LLM-driven nodes only; deterministic tool
 *      results are memoized in state and not recomputed).
 *
 * Channels mirror AgentStateSchema field-for-field. We use overwrite reducers
 * (omit `reducer:`) because nodes.ts already does explicit array concat for
 * tools_called/policy_flags — keeping it explicit at the node layer is easier
 * to reason about than spreading concat semantics across both surfaces.
 *
 * Checkpointer is MemorySaver — Vercel serverless ephemeral filesystem rules
 * out SqliteSaver (plan §13 finding #1 / §8). thread_id is passed at invoke
 * time as `configurable.thread_id` and lives in the URL search params so a
 * cold-start retry can resume cleanly.
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
});

export type AgentStateAnnotation = typeof StateAnnotation.State;

const builder = new StateGraph(StateAnnotation)
  .addNode('await_run', awaitRunNode)
  .addNode('parse_inputs', parseInputsNode)
  .addNode('normalize_facts', normalizeFactsNode)
  .addNode('run_deterministic_tools', runDeterministicToolsNode)
  .addNode('classify_data_sensitivity', classifyDataSensitivityNode)
  .addNode('determine_required_approvals', determineRequiredApprovalsNode)
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
builder.addEdge('determine_required_approvals', 'prepare_decision_packet');
builder.addEdge('prepare_decision_packet', 'validate_citations');
builder.addEdge('validate_citations', 'human_approval');

// HITL → either loop back into classification OR emit final.
builder.addConditionalEdges('human_approval', postHumanRouter, {
  classify_data_sensitivity: 'classify_data_sensitivity',
  emit_final: 'emit_final',
});

// No branch — incomplete intake.
builder.addEdge('identify_missing', 'draft_vendor_followup');
builder.addEdge('draft_vendor_followup', 'escalate_to_human');
builder.addEdge('escalate_to_human', END);

builder.addEdge('emit_final', END);

const checkpointer = new MemorySaver();

export const graph = builder.compile({ checkpointer });

/**
 * Build a fresh seed state for a case. Caller passes case_id; we initialize
 * arrays + nulls so node code can rely on `state.tools_called` always being
 * iterable.
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
  };
}
