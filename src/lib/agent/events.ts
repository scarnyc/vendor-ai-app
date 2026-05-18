import { z } from 'zod';
import {
  DecisionPacketSchema,
  HumanDecisionSchema,
  AgentStateSchema,
  ToolCallRecordSchema,
  type DecisionPacket,
  type HumanDecision,
  type AgentState,
} from './schemas';

/*
 * AG-UI event vocabulary used over a hand-rolled SSE transport.
 *
 * The HITL pause event is custom-named RUN_PAUSED_AWAITING_HUMAN — NOT
 * RUN_FINISHED — so a future contributor reading "finished" cannot misread
 * it as "approved" and wire UI text like "Sent" or "Approved" against an
 * unresolved interrupt. This is the §9 hard-line at the protocol layer.
 *
 * STATE_DELTA `path` is an array of string keys, with '-' for array append.
 * No JSON-Pointer '/' syntax — keeps the client reducer trivially typed.
 */

const ToolNameSchema = ToolCallRecordSchema.shape.tool_name;
export type ToolName = z.infer<typeof ToolNameSchema>;

const RunStartedSchema = z.object({
  type: z.literal('RUN_STARTED'),
  case_id: z.string(),
  thread_id: z.string(),
  provider: z.string(),
});

const ToolCallStartSchema = z.object({
  type: z.literal('TOOL_CALL_START'),
  tool_name: ToolNameSchema,
  args: z.record(z.string(), z.unknown()),
});

const ToolCallEndSchema = z.object({
  type: z.literal('TOOL_CALL_END'),
  tool_call: ToolCallRecordSchema,
});

const StateDeltaSchema = z.object({
  type: z.literal('STATE_DELTA'),
  path: z.tuple([z.string()]).rest(z.string()),
  value: z.unknown(),
});

const StateSnapshotSchema = z.object({
  type: z.literal('STATE_SNAPSHOT'),
  decision_packet: DecisionPacketSchema,
});

const RunPausedAwaitingHumanSchema = z.object({
  type: z.literal('RUN_PAUSED_AWAITING_HUMAN'),
});

const RunResumedSchema = z.object({
  type: z.literal('RUN_RESUMED'),
  human_decision: HumanDecisionSchema,
});

const RunFinishedSchema = z.object({
  type: z.literal('RUN_FINISHED'),
  final_state: AgentStateSchema,
});

const RunErrorSchema = z.object({
  type: z.literal('RUN_ERROR'),
  code: z.string(),
  message: z.string(),
  recoverable: z.boolean(),
});

export const AgUiEventSchema = z.discriminatedUnion('type', [
  RunStartedSchema,
  ToolCallStartSchema,
  ToolCallEndSchema,
  StateDeltaSchema,
  StateSnapshotSchema,
  RunPausedAwaitingHumanSchema,
  RunResumedSchema,
  RunFinishedSchema,
  RunErrorSchema,
]);
export type AgUiEvent = z.infer<typeof AgUiEventSchema>;
export type AgUiEventType = AgUiEvent['type'];

/* ─── Typed builders (server emit) ─────────────────────────────────────── */

export const events = {
  runStarted: (p: { case_id: string; thread_id: string; provider: string }): AgUiEvent => ({
    type: 'RUN_STARTED',
    ...p,
  }),
  toolCallStart: (p: { tool_name: ToolName; args: Record<string, unknown> }): AgUiEvent => ({
    type: 'TOOL_CALL_START',
    ...p,
  }),
  toolCallEnd: (tool_call: z.infer<typeof ToolCallRecordSchema>): AgUiEvent => ({
    type: 'TOOL_CALL_END',
    tool_call,
  }),
  stateDelta: (path: [string, ...string[]], value: unknown): AgUiEvent => ({
    type: 'STATE_DELTA',
    path,
    value,
  }),
  stateSnapshot: (decision_packet: DecisionPacket): AgUiEvent => ({
    type: 'STATE_SNAPSHOT',
    decision_packet,
  }),
  runPausedAwaitingHuman: (): AgUiEvent => ({ type: 'RUN_PAUSED_AWAITING_HUMAN' }),
  runResumed: (human_decision: HumanDecision): AgUiEvent => ({
    type: 'RUN_RESUMED',
    human_decision,
  }),
  runFinished: (final_state: AgentState): AgUiEvent => ({
    type: 'RUN_FINISHED',
    final_state,
  }),
  runError: (p: { code: string; message: string; recoverable: boolean }): AgUiEvent => ({
    type: 'RUN_ERROR',
    ...p,
  }),
} as const;

/* ─── SSE serializer ───────────────────────────────────────────────────── */

/**
 * Encode an AG-UI event as an SSE frame: `event: <type>\ndata: <json>\n\n`.
 * If the payload can't be JSON-encoded (circular ref, BigInt, etc.) we
 * substitute a RUN_ERROR frame rather than crashing the stream — the client
 * surfaces the error and the operator can retry without a hung canvas.
 */
export function encodeSse(event: AgUiEvent): string {
  try {
    return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
  } catch (err) {
    console.error('[encodeSse] JSON.stringify failed; sending RUN_ERROR fallback', {
      event_type: event.type,
      err,
    });
    const fallback: AgUiEvent = {
      type: 'RUN_ERROR',
      code: 'encode_failed',
      message: `Failed to JSON-encode ${event.type}: ${err instanceof Error ? err.message : String(err)}`,
      recoverable: false,
    };
    return `event: RUN_ERROR\ndata: ${JSON.stringify(fallback)}\n\n`;
  }
}

/* ─── Node → tool map (static, used to synthesize TOOL_CALL_START) ─────── */

/**
 * Map of LangGraph node name to the deterministic tools that node invokes,
 * in order. Mirrors each node's `recordToolCall(...)` sequence in nodes.ts —
 * keep both in sync; the streaming integration test asserts START/END pairing.
 *
 * WHY static (rather than introspected from LangGraph at runtime): nodes in
 * this repo call plain async functions in tools.ts directly, not LangChain
 * `Tool` objects. LangGraph's tool-callback channel therefore never fires,
 * and the stream layer has no other source of truth for "which tools will
 * this node run next." Promoting the map to a typed constant lets us
 * synthesize TOOL_CALL_START as soon as a node begins executing, instead of
 * waiting for the TOOL_CALL_END that arrives only after the tool finishes.
 */
export type EmittingNodeName =
  | 'parse_inputs'
  | 'run_deterministic_tools'
  | 'classify_data_sensitivity'
  | 'determine_required_approvals'
  | 'validate_citations'
  | 'draft_vendor_followup'
  | 'escalate_to_human';

const NODE_TOOL_MAP_INTERNAL: Readonly<Record<EmittingNodeName, ReadonlyArray<ToolName>>> = {
  parse_inputs: ['validate_required_documents'],
  run_deterministic_tools: [
    'lookup_budget',
    'check_existing_vendor',
    'calculate_total_contract_value',
  ],
  classify_data_sensitivity: ['classify_data_sensitivity'],
  determine_required_approvals: ['determine_required_approvals'],
  validate_citations: ['validate_citations'],
  draft_vendor_followup: ['draft_vendor_followup'],
  escalate_to_human: ['escalate_to_human'],
};

/**
 * Look up the deterministic tools a node emits. Returns `undefined` for
 * non-emitting nodes (e.g. `await_run`, `normalize_facts`, `human_approval`,
 * `emit_final`) so the stream loop can branch cleanly without type widening.
 */
export function toolsForNode(nodeName: string): ReadonlyArray<ToolName> | undefined {
  return (NODE_TOOL_MAP_INTERNAL as Record<string, ReadonlyArray<ToolName> | undefined>)[nodeName];
}

export const NODE_TOOL_MAP = NODE_TOOL_MAP_INTERNAL;
