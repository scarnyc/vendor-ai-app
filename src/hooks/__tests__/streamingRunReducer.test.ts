import { describe, it, expect } from 'vitest';
import {
  reducer,
  INITIAL_STATE,
  type StreamingRunState,
  type Action,
} from '../streamingRunReducer';
import type { AgUiEvent } from '@/lib/agent/events';
import type {
  AgentState,
  DecisionPacket,
  HumanDecision,
  PolicyFlag,
  ToolCallRecord,
} from '@/lib/agent/schemas';

/**
 * Pure-reducer tests for useStreamingRun. The hook owns I/O (SSE, timers,
 * AbortController); this reducer owns state transitions. Isolating the two
 * means the §9 protocol invariants (e.g., 'paused' implies a non-null
 * DecisionPacket) can be asserted at the unit layer without spinning up a
 * React tree or a network round-trip.
 */

const tool = (name: ToolCallRecord['tool_name']): ToolCallRecord => ({
  tool_name: name,
  display_label: name,
  args_summary: {},
  result_summary: {},
  ran_at: '2026-05-18T00:00:00.000Z',
  duration_ms: 1,
});

const flag: PolicyFlag = {
  severity: 'info',
  issue: 'placeholder flag',
  recipient: 'procurement_manager',
  citations: [
    {
      policy_doc: 'procurement_policy',
      section: 'whatever',
      quote: 'verbatim line',
      verified: true,
    },
  ],
};

const packet: DecisionPacket = {
  case_id: 'case_001',
  vendor_name: 'Acme',
  intake_summary: 'summary',
  missing_items: [],
  risk_tier: 'low',
  data_class: 'internal',
  budget: {
    cost_center: 'CC-1',
    department: 'IT',
    annual_budget_remaining: 100,
    budget_owner: 'someone',
    found: true,
    sufficient_for_contract: true,
    headroom_after_contract: 50,
  },
  tcv: { acv_usd: 10, term_months: 12, one_time_usd: 0, tcv_usd: 10, formula: '10*1' },
  duplicate_vendor: { vendor_name: 'Acme', match_type: 'none', matched_vendor: null, confidence: 0 },
  policy_flags: [flag],
  required_approvers: ['procurement_manager'],
  recommended_action: 'approve_with_followup',
  draft_vendor_email: null,
  draft_internal_ticket: 'ticket',
  tools_called: [],
  human_decision: null,
  generated_at: '2026-05-18T00:00:00.000Z',
  degraded_mode: false,
};

const finishedState: AgentState = {
  case_id: 'case_001',
  run_status: 'decided',
  current_node: 'final',
  document_inventory: null,
  budget: packet.budget,
  duplicate_vendor: packet.duplicate_vendor,
  tcv: packet.tcv,
  data_sensitivity: null,
  required_approvals: null,
  policy_flags: [flag],
  decision_packet: packet,
  tools_called: [tool('validate_citations')],
  human_decision: {
    verdict: 'approved',
    notes: null,
    decided_at: '2026-05-18T00:00:01.000Z',
    decided_by: 'priya',
    edits_applied: null,
  },
  error: null,
  candidate_clauses: null,
};

const approved: HumanDecision = {
  verdict: 'approved',
  notes: null,
  decided_at: '2026-05-18T00:00:01.000Z',
  decided_by: 'priya',
  edits_applied: null,
};

function apply(actions: Action[]): StreamingRunState {
  return actions.reduce<StreamingRunState>(reducer, INITIAL_STATE);
}

describe('streamingRunReducer — lifecycle actions', () => {
  it('reset_to_idle returns the initial state', () => {
    const next = reducer(
      { ...INITIAL_STATE, phase: 'streaming' } as StreamingRunState,
      { kind: 'reset_to_idle' }
    );
    expect(next).toEqual(INITIAL_STATE);
  });

  it('enter_countdown moves to countdown with secondsRemaining', () => {
    const next = reducer(INITIAL_STATE, { kind: 'enter_countdown', secondsRemaining: 3 });
    expect(next.phase).toBe('countdown');
    if (next.phase === 'countdown') {
      expect(next.countdownSecondsRemaining).toBe(3);
    }
  });

  it('countdown_tick updates seconds while in countdown', () => {
    const after = apply([
      { kind: 'enter_countdown', secondsRemaining: 3 },
      { kind: 'countdown_tick', secondsRemaining: 1 },
    ]);
    expect(after.phase).toBe('countdown');
    if (after.phase === 'countdown') {
      expect(after.countdownSecondsRemaining).toBe(1);
    }
  });

  it('countdown_tick is a no-op outside countdown', () => {
    const start = reducer(INITIAL_STATE, { kind: 'enter_streaming' });
    const after = reducer(start, { kind: 'countdown_tick', secondsRemaining: 999 });
    expect(after).toBe(start);
  });

  it('enter_streaming preserves base state (tools accumulate across phase switches)', () => {
    const withTool = apply([
      { kind: 'enter_streaming' },
      { kind: 'event', event: { type: 'TOOL_CALL_END', tool_call: tool('lookup_budget') } },
    ]);
    expect(withTool.tools).toHaveLength(1);

    const reentered = reducer(withTool, { kind: 'enter_streaming' });
    expect(reentered.phase).toBe('streaming');
    expect(reentered.tools).toHaveLength(1);
  });

  it('error action carries code/message/canRetry and preserves base state', () => {
    const seeded = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'TOOL_CALL_END', tool_call: tool('lookup_budget') },
    });
    const errored = reducer(seeded, {
      kind: 'error',
      code: 'stream_failed',
      message: 'boom',
      canRetry: true,
    });
    expect(errored.phase).toBe('error');
    if (errored.phase === 'error') {
      expect(errored.errorCode).toBe('stream_failed');
      expect(errored.errorMessage).toBe('boom');
      expect(errored.canRetry).toBe(true);
    }
    // Tools accumulated before the error should still be in scope so the
    // Workbench can render an audit trail beside the error banner.
    expect(errored.tools).toHaveLength(1);
  });
});

describe('streamingRunReducer — hydrate (rehydrate-from-MemorySaver)', () => {
  it('interrupted + packet → paused with non-null decisionPacket', () => {
    const state: AgentState = {
      ...finishedState,
      run_status: 'awaiting_human',
      human_decision: null,
    };
    const next = reducer(INITIAL_STATE, {
      kind: 'hydrate',
      state,
      interrupted: true,
    });
    expect(next.phase).toBe('paused');
    if (next.phase === 'paused') {
      expect(next.decisionPacket).toEqual(packet);
    }
  });

  it('run_status=decided → finished with verdict extracted', () => {
    const next = reducer(INITIAL_STATE, {
      kind: 'hydrate',
      state: finishedState,
      interrupted: false,
    });
    expect(next.phase).toBe('finished');
    if (next.phase === 'finished') {
      expect(next.verdict).toBe('approved');
      expect(next.decisionPacket).toEqual(packet);
    }
  });

  it('run_status=escalated → finished with verdict from human_decision (null if absent)', () => {
    const escalated: AgentState = {
      ...finishedState,
      run_status: 'escalated',
      human_decision: null,
    };
    const next = reducer(INITIAL_STATE, {
      kind: 'hydrate',
      state: escalated,
      interrupted: false,
    });
    expect(next.phase).toBe('finished');
    if (next.phase === 'finished') {
      expect(next.verdict).toBeNull();
    }
  });

  it('mid-run (run_status=tooling, no packet) → streaming', () => {
    const midRun: AgentState = {
      ...finishedState,
      run_status: 'tooling',
      decision_packet: null,
      human_decision: null,
    };
    const next = reducer(INITIAL_STATE, {
      kind: 'hydrate',
      state: midRun,
      interrupted: false,
    });
    expect(next.phase).toBe('streaming');
    expect(next.decisionPacket).toBeNull();
  });

  it('error stickiness: hydrate cannot overwrite an error banner', () => {
    // Operator hit an error and we showed them a Retry button. A stranded-
    // reconcile GET racing in afterward must NOT silently flip back to
    // streaming/paused — Retry is the only escape from 'error'.
    const errored = reducer(INITIAL_STATE, {
      kind: 'error',
      code: 'stream_failed',
      message: 'boom',
      canRetry: true,
    });
    expect(errored.phase).toBe('error');
    const afterHydrate = reducer(errored, {
      kind: 'hydrate',
      state: finishedState,
      interrupted: true,
    });
    expect(afterHydrate).toBe(errored);
  });
});

describe('streamingRunReducer — applyEvent (stream-driven transitions)', () => {
  it('RUN_STARTED moves to streaming while preserving accumulated base (replay-safe)', () => {
    const seeded = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'TOOL_CALL_END', tool_call: tool('lookup_budget') },
    });
    expect(seeded.tools).toHaveLength(1);
    const restarted = reducer(seeded, {
      kind: 'event',
      event: {
        type: 'RUN_STARTED',
        case_id: 'case_001',
        thread_id: 'case_001',
        provider: 'mock',
      },
    });
    expect(restarted.phase).toBe('streaming');
    // Tools are preserved across RUN_STARTED so reconnect-after-drop can
    // overlay incoming events on the already-rendered audit trail without
    // a render flash. The route handler emits RUN_STARTED only once per
    // POST, so the same-stream "duplicate RUN_STARTED" case can't reset
    // legitimate state mid-run.
    expect(restarted.tools).toHaveLength(1);
  });

  it('TOOL_CALL_START tracks in-flight tool names', () => {
    const next = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'TOOL_CALL_START', tool_name: 'lookup_budget', args: {} },
    });
    expect(next.inFlightTools).toEqual(['lookup_budget']);
  });

  it('TOOL_CALL_END appends to tools and removes from inFlight', () => {
    const after = apply([
      {
        kind: 'event',
        event: { type: 'TOOL_CALL_START', tool_name: 'lookup_budget', args: {} },
      },
      {
        kind: 'event',
        event: { type: 'TOOL_CALL_END', tool_call: tool('lookup_budget') },
      },
    ]);
    expect(after.tools).toHaveLength(1);
    expect(after.tools[0].tool_name).toBe('lookup_budget');
    expect(after.inFlightTools).toEqual([]);
  });

  it('STATE_DELTA single-key path replaces the value at that key', () => {
    const after = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'STATE_DELTA', path: ['policy_flags'], value: [flag] },
    });
    expect(after.agentState.policy_flags).toEqual([flag]);
  });

  it("STATE_DELTA path [key, '-'] appends to an existing array", () => {
    const after = apply([
      {
        kind: 'event',
        event: { type: 'STATE_DELTA', path: ['policy_flags'], value: [] as PolicyFlag[] },
      },
      {
        kind: 'event',
        event: { type: 'STATE_DELTA', path: ['policy_flags', '-'], value: flag },
      },
    ]);
    expect(after.agentState.policy_flags).toEqual([flag]);
  });

  it('STATE_DELTA empty path is a no-op (defensive guard)', () => {
    const before = reducer(INITIAL_STATE, { kind: 'enter_streaming' });
    const after = reducer(before, {
      kind: 'event',
      event: { type: 'STATE_DELTA', path: [] as unknown as [string, ...string[]], value: 'x' },
    });
    expect(after).toBe(before);
  });

  it('STATE_SNAPSHOT stores the decision packet without changing phase', () => {
    const after = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'STATE_SNAPSHOT', decision_packet: packet },
    });
    expect(after.decisionPacket).toEqual(packet);
    expect(after.agentState.decision_packet).toEqual(packet);
    expect(after.phase).toBe('idle');
  });

  it('RUN_PAUSED_AWAITING_HUMAN with prior STATE_SNAPSHOT → paused (typed non-null packet)', () => {
    const after = apply([
      {
        kind: 'event',
        event: { type: 'STATE_SNAPSHOT', decision_packet: packet },
      },
      { kind: 'event', event: { type: 'RUN_PAUSED_AWAITING_HUMAN' } },
    ]);
    expect(after.phase).toBe('paused');
    if (after.phase === 'paused') {
      // The type narrows this to a non-null packet at compile time; the
      // assertion below is the runtime mirror.
      expect(after.decisionPacket).toEqual(packet);
    }
  });

  it('RUN_PAUSED_AWAITING_HUMAN without a prior snapshot → error (§9 invariant)', () => {
    const after = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'RUN_PAUSED_AWAITING_HUMAN' },
    });
    expect(after.phase).toBe('error');
    if (after.phase === 'error') {
      // The §9 protocol-layer guarantee: never render a 'paused' card with
      // no DecisionPacket. The hook surfaces this as a retryable error so
      // the operator can replay from the checkpoint.
      expect(after.errorCode).toBe('paused_without_packet');
      expect(after.canRetry).toBe(true);
    }
  });

  it('RUN_RESUMED returns to streaming and records human_decision in agentState', () => {
    const paused = apply([
      { kind: 'event', event: { type: 'STATE_SNAPSHOT', decision_packet: packet } },
      { kind: 'event', event: { type: 'RUN_PAUSED_AWAITING_HUMAN' } },
    ]);
    const resumed = reducer(paused, {
      kind: 'event',
      event: { type: 'RUN_RESUMED', human_decision: approved },
    });
    expect(resumed.phase).toBe('streaming');
    expect(resumed.agentState.human_decision).toEqual(approved);
  });

  it('RUN_FINISHED transitions to finished and surfaces verdict from final_state', () => {
    const finished = reducer(INITIAL_STATE, {
      kind: 'event',
      event: { type: 'RUN_FINISHED', final_state: finishedState },
    });
    expect(finished.phase).toBe('finished');
    if (finished.phase === 'finished') {
      expect(finished.verdict).toBe('approved');
      expect(finished.decisionPacket).toEqual(packet);
      expect(finished.tools).toEqual(finishedState.tools_called);
    }
  });

  it('RUN_FINISHED with no human_decision surfaces verdict=null', () => {
    const finished = reducer(INITIAL_STATE, {
      kind: 'event',
      event: {
        type: 'RUN_FINISHED',
        final_state: { ...finishedState, human_decision: null },
      },
    });
    expect(finished.phase).toBe('finished');
    if (finished.phase === 'finished') {
      expect(finished.verdict).toBeNull();
    }
  });

  it('RUN_ERROR surfaces code/message/recoverable as the error block', () => {
    const errored: AgUiEvent = {
      type: 'RUN_ERROR',
      code: 'graph_error',
      message: 'boom',
      recoverable: false,
    };
    const next = reducer(INITIAL_STATE, { kind: 'event', event: errored });
    expect(next.phase).toBe('error');
    if (next.phase === 'error') {
      expect(next.errorCode).toBe('graph_error');
      expect(next.errorMessage).toBe('boom');
      expect(next.canRetry).toBe(false);
    }
  });
});
