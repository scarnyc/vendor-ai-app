import { describe, it, expect } from 'vitest';
import { streamRun } from '../stream';
import type { AgUiEvent } from '../events';

/**
 * SPEC §9, lifted into the streaming protocol:
 *
 *   "The agent never approves spend, never sends external messages, never
 *    accepts contract language, never makes the final security/privacy
 *    decision."
 *
 * In the streaming context this means no event emitted during the 'run'
 * phase (before POST /api/resume) may carry `human_decision != null`.
 * humanApprovalNode is the SOLE writer of human_decision, and it only
 * runs after the operator click crosses into /api/resume.
 *
 * These tests are paired with spec_9_invariants.test.ts (which guards the
 * schema layer); together they hold the contract at both the data and wire
 * layers.
 */

function hasHumanDecisionPayload(event: AgUiEvent): boolean {
  if (event.type === 'STATE_DELTA') {
    if (event.path.includes('human_decision') && event.value != null) return true;
    // A STATE_DELTA of a whole object (e.g. final_state) carrying a non-null
    // human_decision is also a violation.
    if (
      typeof event.value === 'object' &&
      event.value !== null &&
      'human_decision' in (event.value as Record<string, unknown>) &&
      (event.value as Record<string, unknown>).human_decision != null
    ) {
      return true;
    }
  }
  if (event.type === 'STATE_SNAPSHOT') {
    if (event.decision_packet.human_decision != null) return true;
  }
  if (event.type === 'RUN_FINISHED') {
    if (event.final_state.human_decision != null) return true;
  }
  return false;
}

describe('SPEC §9 — streaming wire-layer invariants', () => {
  it('case_001 run stream never emits human_decision before /api/resume', async () => {
    const stream: AgUiEvent[] = [];
    for await (const event of streamRun('case_001', { kind: 'run' })) {
      stream.push(event);
    }

    for (const event of stream) {
      expect(
        hasHumanDecisionPayload(event),
        `event ${event.type} must not carry human_decision before /api/resume`
      ).toBe(false);
    }

    // The terminal event of the run phase MUST be the pause, not
    // RUN_FINISHED — case_001 reaches HITL. A RUN_FINISHED here would mean
    // the run skipped the gate.
    expect(stream[stream.length - 1].type).toBe('RUN_PAUSED_AWAITING_HUMAN');
  });

  it('the run-mode stream never emits RUN_RESUMED — that is reserved for /api/resume', async () => {
    const stream: AgUiEvent[] = [];
    for await (const event of streamRun('case_001', { kind: 'run' })) {
      stream.push(event);
    }
    const resumed = stream.filter((e) => e.type === 'RUN_RESUMED');
    expect(resumed.length).toBe(0);
  });

  it('AG-UI event vocabulary keeps the HITL pause structurally distinct from RUN_FINISHED', async () => {
    // This is a static guard: simply asserting the vocabulary exposes
    // RUN_PAUSED_AWAITING_HUMAN as a distinct event type. The custom name
    // is the §9 protection at the protocol layer — a contributor reading
    // "RUN_FINISHED" might wire UI text like "Approved"; "PAUSED_AWAITING_HUMAN"
    // cannot be misread.
    const { events } = await import('../events');
    expect(typeof events.runPausedAwaitingHuman).toBe('function');
    expect(events.runPausedAwaitingHuman().type).toBe('RUN_PAUSED_AWAITING_HUMAN');
    expect(events.runFinished({} as never).type).toBe('RUN_FINISHED');
    expect(events.runPausedAwaitingHuman().type).not.toBe('RUN_FINISHED');
  });
});
