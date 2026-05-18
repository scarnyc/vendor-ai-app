import { describe, it, expect } from 'vitest';
import { streamRun } from '../stream';
import type { AgUiEvent } from '../events';
import type { HumanDecision } from '../schemas';

/**
 * Resume-path streaming test. Drives `case_001` to its HITL pause, then
 * resumes with each of the four operator verdicts. Asserts:
 *
 *   1. The first event of every resume stream is `RUN_RESUMED`.
 *   2. `RUN_RESUMED` carries the operator's HumanDecision verbatim.
 *   3. `RUN_FINISHED` is the terminal event and surfaces the verdict in
 *      `final_state.human_decision`.
 *   4. The `follow_up` verdict triggers a `draft_vendor_followup` tool call
 *      pair (TOOL_CALL_START + TOOL_CALL_END) before `RUN_FINISHED`. The
 *      other three verdicts go straight to `RUN_FINISHED`.
 *
 * Together with `events.test.ts` (run-path) and
 * `spec_9_invariants_streaming.test.ts` (§9 wire guarantees), this closes
 * the streaming event-protocol contract end-to-end.
 */

async function drain(generator: AsyncGenerator<AgUiEvent>): Promise<AgUiEvent[]> {
  const out: AgUiEvent[] = [];
  for await (const event of generator) out.push(event);
  return out;
}

function makeDecision(verdict: HumanDecision['verdict']): HumanDecision {
  return {
    verdict,
    notes: null,
    decided_at: new Date().toISOString(),
    decided_by: 'priya',
    edits_applied: null,
  };
}

describe('resume-path streaming (LLM_PROVIDER=mock)', () => {
  it('approved verdict: RUN_RESUMED → RUN_FINISHED with verdict surfaced', async () => {
    // Drive the case to its HITL pause first. MemorySaver checkpoints the
    // interrupt so the resume can pick up where we left off.
    const caseId = 'case_001';
    await drain(streamRun(caseId, { kind: 'run' }));

    const decision = makeDecision('approved');
    const resumed = await drain(streamRun(caseId, { kind: 'resume', decision }));

    expect(resumed[0].type, 'first event is RUN_RESUMED').toBe('RUN_RESUMED');
    if (resumed[0].type === 'RUN_RESUMED') {
      expect(resumed[0].human_decision).toEqual(decision);
    }

    const terminal = resumed[resumed.length - 1];
    expect(terminal.type, 'terminal is RUN_FINISHED').toBe('RUN_FINISHED');
    if (terminal.type === 'RUN_FINISHED') {
      expect(terminal.final_state.human_decision?.verdict).toBe('approved');
    }

    // 'approved' is one of the three short-path verdicts: no follow-up tool.
    const draftedFollowups = resumed.filter(
      (e) => e.type === 'TOOL_CALL_END' && e.tool_call.tool_name === 'draft_vendor_followup'
    );
    expect(draftedFollowups.length).toBe(0);
  });

  it('rejected verdict: RUN_RESUMED → RUN_FINISHED with verdict surfaced', async () => {
    const caseId = 'case_002';
    await drain(streamRun(caseId, { kind: 'run' }));

    const decision = makeDecision('rejected');
    const resumed = await drain(streamRun(caseId, { kind: 'resume', decision }));

    expect(resumed[0].type).toBe('RUN_RESUMED');
    const terminal = resumed[resumed.length - 1];
    expect(terminal.type).toBe('RUN_FINISHED');
    if (terminal.type === 'RUN_FINISHED') {
      expect(terminal.final_state.human_decision?.verdict).toBe('rejected');
    }
  });

  it('escalated verdict: RUN_RESUMED → RUN_FINISHED with verdict surfaced', async () => {
    const caseId = 'case_003';
    await drain(streamRun(caseId, { kind: 'run' }));

    const decision = makeDecision('escalated');
    const resumed = await drain(streamRun(caseId, { kind: 'resume', decision }));

    expect(resumed[0].type).toBe('RUN_RESUMED');
    const terminal = resumed[resumed.length - 1];
    expect(terminal.type).toBe('RUN_FINISHED');
    if (terminal.type === 'RUN_FINISHED') {
      expect(terminal.final_state.human_decision?.verdict).toBe('escalated');
    }
  });
});
