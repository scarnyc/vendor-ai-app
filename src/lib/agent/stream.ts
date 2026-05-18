import { Command } from '@langchain/langgraph';
import { graph, seedState } from './graph';
import {
  events,
  toolsForNode,
  type AgUiEvent,
} from './events';
import {
  DecisionPacketSchema,
  type AgentState,
  type HumanDecision,
  type ToolCallRecord,
} from './schemas';

/**
 * Streaming core for the AG-UI event protocol — pure async generator, no SSE
 * framing. Reused by `/api/run/[case]` (mode='run') and `/api/resume`
 * (mode='resume'). Tests consume it directly to assert event ordering
 * without spinning up HTTP transport.
 *
 * The mode parameter pins which resume input we send into the LangGraph
 * thread:
 *   - 'run' — first-arrival or post-replay re-entry. Resume value is the
 *     literal string 'run' which await_run uses as a gate.
 *   - 'resume' — operator-decision re-entry. Resume value is the
 *     HumanDecision payload from the operator click.
 *
 * Event ordering invariants this generator preserves:
 *   1. RUN_STARTED / RUN_RESUMED is the first event of every stream.
 *   2. STATE_SNAPSHOT (carrying decision_packet) is emitted at most ONCE,
 *      and only AFTER validate_citations completes — never before. This is
 *      the §9 protocol-layer guarantee: operators only see the validated
 *      packet, never an unverified intermediate.
 *   3. No event carries `human_decision != null` while the stream is in
 *      'run' mode. Only 'resume' mode emits `human_decision` deltas, and
 *      only after the operator click has crossed into the route handler.
 *   4. RUN_PAUSED_AWAITING_HUMAN / RUN_FINISHED is the terminal event.
 *      The HITL pause is deliberately custom-named (not RUN_FINISHED) so
 *      a contributor cannot misread the run as "approved."
 *   5. TOOL_CALL_START carries `args: {}` on live nodes — the deterministic
 *      tool fns are wrapped in node closures, not LangChain Tool objects,
 *      so the runtime never surfaces structured input. Replay paths fill
 *      `args` from the stored ToolCallRecord.args_summary instead.
 *   6. A run whose validate_citations gate set `error` terminates with
 *      RUN_ERROR (code='validation_failed'), NOT RUN_PAUSED_AWAITING_HUMAN —
 *      §9 forbids surfacing an unvalidated packet behind the HITL gate.
 */

export type StreamMode =
  | { kind: 'run' }
  | { kind: 'resume'; decision: HumanDecision };

export async function* streamRun(
  caseId: string,
  mode: StreamMode
): AsyncGenerator<AgUiEvent, void, void> {
  const config = { configurable: { thread_id: caseId } };

  if (mode.kind === 'run') {
    yield events.runStarted({
      case_id: caseId,
      thread_id: caseId,
      provider: 'unspecified',
    });

    const existing = await graph.getState(config);
    const hasState = Object.keys(existing.values ?? {}).length > 0;
    const stillRunning = (existing.next ?? []).length > 0;

    if (hasState && stillRunning) {
      // Already paused at HITL — replay accumulated state, re-emit pause.
      // §9 defense-in-depth: only enter the HITL replay branch if the graph
      // is actually interrupted at human_approval. If a future node ever
      // pauses elsewhere, fall through so replayState's schema check (below)
      // and the run path's validate_citations gate stay load-bearing.
      const interruptNodes = existing.next ?? [];
      if (interruptNodes.includes('human_approval')) {
        yield* replayState(existing.values as AgentState);
        yield events.runPausedAwaitingHuman();
        return;
      }
    }

    if (!hasState) {
      await graph.updateState(config, seedState(caseId), undefined);
    }
  } else {
    yield events.runResumed(mode.decision);
  }

  const beforeSnap = await graph.getState(config);
  const beforeTools = (beforeSnap.values as Partial<AgentState>)?.tools_called ?? [];
  let lastToolsLen = beforeTools.length;
  let snapshotEmitted = false;
  const announcedTools = new Set<string>();
  const accumulated: Partial<AgentState> = { ...(beforeSnap.values ?? {}) };

  const resumeValue = mode.kind === 'run' ? 'run' : mode.decision;

  const iterator = await graph.stream(new Command({ resume: resumeValue }), {
    ...config,
    streamMode: 'updates',
  });

  let iteratorDrained = false;
  try {
    for await (const chunk of iterator) {
      const updates = chunk as Record<string, Partial<AgentState>>;
      for (const [nodeName, update] of Object.entries(updates)) {
        const nodeTools = toolsForNode(nodeName);
        if (nodeTools && !announcedTools.has(nodeName)) {
          for (const toolName of nodeTools) {
            yield events.toolCallStart({ tool_name: toolName, args: {} });
          }
          announcedTools.add(nodeName);
        }

        for (const [key, value] of Object.entries(update)) {
          if (key === 'tools_called') {
            const records = value as ToolCallRecord[];
            const newRecords = records.slice(lastToolsLen);
            for (const record of newRecords) {
              yield events.toolCallEnd(record);
            }
            lastToolsLen = records.length;
          } else if (key === 'decision_packet') {
            // Skip the redundant STATE_DELTA: the packet rides the wire once,
            // via STATE_SNAPSHOT post-validate_citations. Keeping the delta in
            // accumulated state below preserves the snapshot's source-of-truth.
          } else {
            yield events.stateDelta([key], value);
          }
          (accumulated as Record<string, unknown>)[key] = value;
        }

        if (
          nodeName === 'validate_citations' &&
          !snapshotEmitted &&
          accumulated.decision_packet &&
          !accumulated.error
        ) {
          const parsed = DecisionPacketSchema.safeParse(accumulated.decision_packet);
          if (parsed.success) {
            yield events.stateSnapshot(parsed.data);
            snapshotEmitted = true;
          } else {
            yield events.runError({
              code: 'packet_schema_invalid',
              message: `DecisionPacket failed schema validation: ${parsed.error.message}`,
              recoverable: false,
            });
            return;
          }
        }
      }
    }
    iteratorDrained = true;
  } finally {
    if (!iteratorDrained) {
      // for-await exited via throw / early return / generator abandonment.
      // The graph.stream() iterator drains server-side regardless, so the
      // MemorySaver checkpoint is intact; the warn just makes the partial
      // stream visible in server logs instead of dropping silently.
      console.warn('[streamRun] iterator did not drain to completion', {
        case_id: caseId,
        mode: mode.kind,
      });
    }
  }

  const finalSnap = await graph.getState(config);
  const interrupted = (finalSnap.next?.length ?? 0) > 0;
  const errorOnRun = (finalSnap.values as Partial<AgentState>)?.error;

  if (errorOnRun) {
    // §9 protection: validate_citations (or any future guard) set an error
    // string on state. Route to RUN_ERROR so the client surfaces the failure
    // instead of presenting an HITL gate over an unvalidated packet.
    yield events.runError({
      code: 'validation_failed',
      message: errorOnRun,
      recoverable: false,
    });
    return;
  }

  if (interrupted) {
    if (!snapshotEmitted && finalSnap.values.decision_packet) {
      const parsed = DecisionPacketSchema.safeParse(finalSnap.values.decision_packet);
      if (parsed.success) {
        yield events.stateSnapshot(parsed.data);
      } else {
        yield events.runError({
          code: 'packet_schema_invalid',
          message: `DecisionPacket failed schema validation on pause: ${parsed.error.message}`,
          recoverable: false,
        });
        return;
      }
    }
    yield events.runPausedAwaitingHuman();
  } else {
    yield events.runFinished(finalSnap.values as AgentState);
  }
}

/**
 * Re-emit the events that would have led to the current state. Used when
 * POST lands on an already-paused thread (page reload after HITL was
 * reached). Tools become START/END pairs; non-tool fields become single
 * STATE_DELTA events; the packet becomes a single STATE_SNAPSHOT.
 *
 * §9 defense-in-depth: the persisted decision_packet is re-validated against
 * DecisionPacketSchema before being re-emitted. The first-pass run already
 * gated on validate_citations, but a future graph change (or a corrupted
 * MemorySaver checkpoint) could otherwise let an unvalidated packet reach
 * the operator behind the HITL gate. On parse failure we emit RUN_ERROR
 * instead of STATE_SNAPSHOT, so the client never renders an unvalidated
 * confirmation card.
 */
function* replayState(state: AgentState): Generator<AgUiEvent, void, void> {
  for (const record of state.tools_called ?? []) {
    yield events.toolCallStart({
      tool_name: record.tool_name,
      args: record.args_summary,
    });
    yield events.toolCallEnd(record);
  }

  const replayKeys: ReadonlyArray<keyof AgentState> = [
    'current_node',
    'run_status',
    'document_inventory',
    'budget',
    'duplicate_vendor',
    'tcv',
    'data_sensitivity',
    'required_approvals',
    'policy_flags',
    'candidate_clauses',
  ];
  for (const key of replayKeys) {
    const value = state[key];
    if (value !== null && value !== undefined) {
      yield events.stateDelta([key as string], value);
    }
  }

  if (state.decision_packet) {
    const parsed = DecisionPacketSchema.safeParse(state.decision_packet);
    if (parsed.success) {
      yield events.stateSnapshot(parsed.data);
    } else {
      yield events.runError({
        code: 'packet_schema_invalid',
        message: `Persisted DecisionPacket failed schema validation on replay: ${parsed.error.message}`,
        recoverable: false,
      });
    }
  }
}
