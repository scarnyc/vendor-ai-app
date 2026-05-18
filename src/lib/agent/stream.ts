import { Command } from '@langchain/langgraph';
import { graph, seedState } from './graph';
import {
  events,
  toolsForNode,
  type AgUiEvent,
} from './events';
import type {
  AgentState,
  DecisionPacket,
  HumanDecision,
  ToolCallRecord,
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
      yield* replayState(existing.values as AgentState);
      yield events.runPausedAwaitingHuman();
      return;
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

  const resumeValue =
    mode.kind === 'run' ? 'run' : (mode.decision as unknown);

  const iterator = await graph.stream(new Command({ resume: resumeValue }), {
    ...config,
    streamMode: 'updates',
  });

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
        // §9 protection: never snapshot a packet whose citation gate failed.
        // validateCitationsNode sets `error` on the run; stream must keep the
        // packet off the wire so the operator never sees an unvalidated one.
        !accumulated.error
      ) {
        yield events.stateSnapshot(accumulated.decision_packet as DecisionPacket);
        snapshotEmitted = true;
      }
    }
  }

  const finalSnap = await graph.getState(config);
  const interrupted = (finalSnap.next?.length ?? 0) > 0;

  if (interrupted) {
    if (
      !snapshotEmitted &&
      finalSnap.values.decision_packet &&
      !finalSnap.values.error
    ) {
      yield events.stateSnapshot(
        finalSnap.values.decision_packet as DecisionPacket
      );
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
    yield events.stateSnapshot(state.decision_packet);
  }
}
