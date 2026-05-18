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
 * Names match the AG-UI spec where they exist (STATE_DELTA, STATE_SNAPSHOT,
 * RUN_STARTED, RUN_FINISHED, RUN_ERROR, TOOL_CALL_*). The HITL pause event is
 * deliberately custom-named RUN_PAUSED_AWAITING_HUMAN — NOT RUN_FINISHED — so
 * a future contributor reading "finished" cannot misread it as "approved" and
 * wire UI text like "Sent" or "Approved" against an unresolved interrupt.
 * This is the §9 hard-line at the protocol layer.
 *
 * State-rebuild philosophy: STATE_DELTA events are the wire format the client
 * reducer uses to build AgentState progressively. STATE_SNAPSHOT fires once,
 * post-validate_citations, and carries the verified decision_packet — it is
 * a "now safe to render the packet" semaphore, not a state-rebuild source.
 *
 * `path` shape: array of string keys, with '-' for array append. Example:
 *   { path: ['tools_called', '-'], value: <tool_record> } appends.
 *   { path: ['policy_flags'], value: <array> } replaces wholesale.
 * No JSON-Pointer '/' syntax — keeps the client reducer trivially typed.
 *
 * Schema discipline: server writes events through typed builders below
 * (no Zod on emit — typed builders are sufficient). Client parses incoming
 * frames with `AgUiEventSchema` for defense-in-depth.
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
  path: z.array(z.string()).min(1),
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
  stateDelta: (path: string[], value: unknown): AgUiEvent => ({
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
 * Encode an AG-UI event as an SSE frame. Format: `event: <type>\ndata: <json>\n\n`.
 * The event name is repeated as the SSE `event:` field for clients that
 * route on it (EventSource-style), and the JSON body is the same shape the
 * client Zod-parses.
 */
export function encodeSse(event: AgUiEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

/* ─── Node → tool map (static, used to synthesize TOOL_CALL_START) ─────── */

/**
 * Map of LangGraph node name to the deterministic tools that node invokes,
 * in order. Used by the SSE route to emit `TOOL_CALL_START` events just
 * before a node runs — paired with `TOOL_CALL_END` events derived from the
 * `tools_called` array delta after the node completes.
 *
 * Why static: nodes call plain async functions (not LangChain `Tool`
 * objects), so the runtime's tool-callback channel never fires. The map
 * mirrors what each node's `recordToolCall(...)` calls in nodes.ts; if that
 * sequence changes, update both — the streaming integration test asserts
 * the START/END pairing.
 */
export const NODE_TOOL_MAP: Record<string, ReadonlyArray<ToolName>> = {
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
