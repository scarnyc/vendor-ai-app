import { describe, it, expect } from 'vitest';
import { Command } from '@langchain/langgraph';
import { graph, seedState } from '../graph';

interface Target {
  flagsCount: number;
  action: 'approve_with_followup' | 'escalate' | 'block';
}

const TARGETS: Record<string, Target> = {
  case_001: { flagsCount: 3, action: 'approve_with_followup' },
  case_002: { flagsCount: 2, action: 'approve_with_followup' },
  case_003: { flagsCount: 6, action: 'escalate' },
};

async function runCase(caseId: string) {
  const config = { configurable: { thread_id: `test_${caseId}_${Date.now()}` } };
  await graph.updateState(config, seedState(caseId), undefined);
  await graph.invoke(new Command({ resume: 'run' }), config);
  const snap = await graph.getState(config);
  return snap.values;
}

describe('agent accuracy (LLM_PROVIDER=mock)', () => {
  for (const [caseId, target] of Object.entries(TARGETS)) {
    it(`${caseId} produces ${target.flagsCount} flags / ${target.action}`, async () => {
      const state = await runCase(caseId);
      const packet = state?.decision_packet;
      expect(packet, 'decision_packet must be populated after run').toBeTruthy();
      expect(packet.policy_flags.length).toBe(target.flagsCount);
      expect(packet.recommended_action).toBe(target.action);
      // v0.8 Zod bounds — sanity check that flags landed inside [1, 8].
      expect(packet.policy_flags.length).toBeGreaterThanOrEqual(1);
      expect(packet.policy_flags.length).toBeLessThanOrEqual(8);
    });
  }

  it('case_001 — citation verification writes per-citation booleans (not a meta-flag)', async () => {
    const state = await runCase('case_001');
    const packet = state?.decision_packet;
    expect(packet).toBeTruthy();
    // v0.8 Item 3: there should be NO synthetic "citations could not be verified" flag.
    const metaFlag = packet.policy_flags.find((f: { issue: string }) =>
      /policy citation\(s\) could not be verified/i.test(f.issue)
    );
    expect(metaFlag, 'v0.8 removed the synthesized citation meta-flag').toBeUndefined();
    // Every citation must carry an explicit verified boolean.
    for (const flag of packet.policy_flags) {
      for (const cite of flag.citations) {
        expect(typeof cite.verified).toBe('boolean');
      }
    }
  });

  it('case_003 — at least one block-severity flag drives the escalation', async () => {
    const state = await runCase('case_003');
    const packet = state?.decision_packet;
    expect(packet).toBeTruthy();
    expect(packet.policy_flags.some((f: { severity: string }) => f.severity === 'block')).toBe(true);
    expect(packet.risk_tier).toBe('high');
  });
});
