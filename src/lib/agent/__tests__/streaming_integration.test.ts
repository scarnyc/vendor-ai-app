import { describe, it, expect } from 'vitest';
import { Command } from '@langchain/langgraph';
import { streamRun } from '../stream';
import { graph, seedState } from '../graph';
import type { AgUiEvent } from '../events';
import type { AgentState, ToolCallRecord } from '../schemas';

/**
 * Streaming-vs-batch equivalence test.
 *
 * Drives the same case through two paths:
 *   A) `streamRun(caseId, { kind: 'run' })` — drains every AG-UI event,
 *      then reconstructs AgentState by applying STATE_DELTA / STATE_SNAPSHOT
 *      and counting TOOL_CALL_END records.
 *   B) `graph.invoke(Command({resume: 'run'}), config)` — the pre-refactor
 *      synchronous path, returning a final snapshot.
 *
 * Asserts the load-bearing fields of the reconstructed state match those
 * from the synchronous path. The streaming refactor changes the wire
 * protocol but MUST NOT change the agent's output.
 */

interface AccumulatedState {
  decision_packet: AgentState['decision_packet'];
  policy_flags: AgentState['policy_flags'];
  tools_called: ToolCallRecord[];
  run_status: AgentState['run_status'] | null;
}

function reconstructFromStream(events: AgUiEvent[]): AccumulatedState {
  const state: AccumulatedState = {
    decision_packet: null,
    policy_flags: [],
    tools_called: [],
    run_status: null,
  };
  for (const event of events) {
    if (event.type === 'STATE_DELTA') {
      const [head, ...rest] = event.path;
      if (rest.length !== 0) continue;
      if (head === 'policy_flags') state.policy_flags = event.value as AgentState['policy_flags'];
      else if (head === 'run_status') state.run_status = event.value as AgentState['run_status'];
      else if (head === 'decision_packet')
        state.decision_packet = event.value as AgentState['decision_packet'];
    } else if (event.type === 'STATE_SNAPSHOT') {
      state.decision_packet = event.decision_packet;
    } else if (event.type === 'TOOL_CALL_END') {
      state.tools_called.push(event.tool_call);
    }
  }
  return state;
}

async function batchInvoke(caseId: string): Promise<AgentState> {
  // Use a fresh thread so we don't share state with the streaming run.
  const config = { configurable: { thread_id: `batch_${caseId}_${Date.now()}` } };
  await graph.updateState(config, seedState(caseId), undefined);
  await graph.invoke(new Command({ resume: 'run' }), config);
  const snap = await graph.getState(config);
  return snap.values as AgentState;
}

describe('streaming integration — stream output matches synchronous invoke', () => {
  it('case_001 — reconstructed decision_packet matches batch invoke', async () => {
    const collected: AgUiEvent[] = [];
    for await (const event of streamRun('case_001', { kind: 'run' })) {
      collected.push(event);
    }

    const reconstructed = reconstructFromStream(collected);
    const batched = await batchInvoke('case_001');

    expect(reconstructed.decision_packet, 'streamed packet present').toBeTruthy();
    expect(batched.decision_packet, 'batched packet present').toBeTruthy();

    // The packet must agree on the load-bearing fields the operator sees.
    const sp = reconstructed.decision_packet!;
    const bp = batched.decision_packet!;
    expect(sp.recommended_action).toBe(bp.recommended_action);
    expect(sp.risk_tier).toBe(bp.risk_tier);
    expect(sp.policy_flags.length).toBe(bp.policy_flags.length);

    // Tool-call records: same count, same names in order. (Args / outputs
    // may include timestamps that differ across two runs of the mock; the
    // tool *sequence* is the load-bearing assertion.)
    const streamedNames = reconstructed.tools_called.map((r) => r.tool_name);
    const batchedNames = batched.tools_called.map((r) => r.tool_name);
    expect(streamedNames).toEqual(batchedNames);
  });

  it('e2e wall-time stays under SPEC §6 90s target on case_001 (mock provider)', async () => {
    const startedAt = Date.now();
    const collected: AgUiEvent[] = [];
    for await (const event of streamRun('case_001', { kind: 'run' })) {
      collected.push(event);
    }
    const elapsedMs = Date.now() - startedAt;
    expect(
      elapsedMs,
      `streamed run of case_001 (mock) took ${elapsedMs}ms; SPEC §6 budget is 90,000ms`
    ).toBeLessThan(90_000);
  });
});
