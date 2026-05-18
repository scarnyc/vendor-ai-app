import { describe, it, expect } from 'vitest';
import { streamRun } from '../stream';
import { AgUiEventSchema, type AgUiEvent } from '../events';

/**
 * Happy-path AG-UI event-sequence test on case_001 (mock provider).
 *
 * Asserts the event vocabulary the client reducer depends on:
 *   - First event is RUN_STARTED.
 *   - Per-node TOOL_CALL_START emitted before TOOL_CALL_END of the same name.
 *   - STATE_SNAPSHOT is emitted exactly ONCE.
 *   - Stream terminates with RUN_PAUSED_AWAITING_HUMAN (HITL branch).
 *   - Every emitted event re-validates against AgUiEventSchema (catches
 *     drift between typed builders and the schema discriminated union).
 */

async function drain(caseId: string): Promise<AgUiEvent[]> {
  // streamRun keys MemorySaver by caseId. Vitest runs files in worker
  // isolation and tests within a file run sequentially, so two `drain` calls
  // for the same caseId in this file will never race; a prior run leaves a
  // checkpoint that the next call's replayState path picks up cleanly.
  const collected: AgUiEvent[] = [];
  for await (const event of streamRun(caseId, { kind: 'run' })) {
    collected.push(event);
  }
  return collected;
}

describe('AG-UI event sequence (LLM_PROVIDER=mock)', () => {
  it('case_001 — full happy-path stream is well-formed', async () => {
    const stream = await drain('case_001');

    // Re-validate every event against the schema. Catches drift between
    // typed builders and the discriminated union.
    for (const event of stream) {
      expect(() => AgUiEventSchema.parse(event)).not.toThrow();
    }

    // First event is RUN_STARTED.
    expect(stream[0].type).toBe('RUN_STARTED');

    // Exactly one STATE_SNAPSHOT.
    const snapshots = stream.filter((e) => e.type === 'STATE_SNAPSHOT');
    expect(snapshots.length, 'STATE_SNAPSHOT fires once post-validate_citations').toBe(1);

    // STATE_SNAPSHOT lands AFTER the validate_citations TOOL_CALL_END.
    const snapshotIdx = stream.findIndex((e) => e.type === 'STATE_SNAPSHOT');
    const validateEndIdx = stream.findIndex(
      (e) => e.type === 'TOOL_CALL_END' && e.tool_call.tool_name === 'validate_citations'
    );
    expect(validateEndIdx).toBeGreaterThanOrEqual(0);
    expect(snapshotIdx).toBeGreaterThan(validateEndIdx);

    // Stream terminates with RUN_PAUSED_AWAITING_HUMAN — case_001 reaches HITL.
    expect(stream[stream.length - 1].type).toBe('RUN_PAUSED_AWAITING_HUMAN');

    // Every TOOL_CALL_START has a matching TOOL_CALL_END of the same name.
    const starts = stream.filter((e) => e.type === 'TOOL_CALL_START');
    const ends = stream.filter((e) => e.type === 'TOOL_CALL_END');
    expect(ends.length).toBeGreaterThanOrEqual(starts.length);
    for (const start of starts) {
      if (start.type !== 'TOOL_CALL_START') continue;
      const matching = ends.find(
        (e) => e.type === 'TOOL_CALL_END' && e.tool_call.tool_name === start.tool_name
      );
      expect(
        matching,
        `every TOOL_CALL_START for ${start.tool_name} must have a matching TOOL_CALL_END`
      ).toBeDefined();
    }

    // All 7 deterministic tool names appear in TOOL_CALL_END events. Using
    // superset comparison rather than per-name loop so one assertion failure
    // names every missing tool at once (and tolerates extra tools landing
    // later without rewriting the expected list).
    const endNames = new Set<string>(
      ends.flatMap((e) => (e.type === 'TOOL_CALL_END' ? [e.tool_call.tool_name as string] : []))
    );
    const expectedTools = new Set<string>([
      'validate_required_documents',
      'lookup_budget',
      'check_existing_vendor',
      'calculate_total_contract_value',
      'classify_data_sensitivity',
      'determine_required_approvals',
      'validate_citations',
    ]);
    const missing = [...expectedTools].filter((t) => !endNames.has(t));
    expect(missing, `missing TOOL_CALL_END for: ${missing.join(', ')}`).toEqual([]);
  });
});
