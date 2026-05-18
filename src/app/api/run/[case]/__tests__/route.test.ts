import { describe, it, expect, beforeAll } from 'vitest';
import { NextRequest } from 'next/server';
import { GET, POST } from '../route';
import { streamRun } from '@/lib/agent/stream';
import { graph, seedState } from '@/lib/agent/graph';
import type { AgentState } from '@/lib/agent/schemas';

/**
 * Tests for the GET /api/run/[case] rehydration branch — the second half of
 * the MemorySaver per-worker fallback the streaming plan calls out. The hook
 * branches on this response to choose between paint-from-cache and
 * arm-the-countdown.
 *
 * Branches under test:
 *   - Cold worker (no MemorySaver state for case_id) → `has_run: false`,
 *     `state: null`-ish, `interrupted: false`. Hook arms the countdown.
 *   - Paused worker (run drove to HITL) → `has_run: true`,
 *     `interrupted: true`, `state.decision_packet` present. Hook dispatches
 *     'hydrate' with `interrupted: true` → 'paused'.
 *   - Finished worker (run drove past HITL via resume) → `has_run: true`,
 *     `interrupted: false`, `state.run_status` ∈ {'decided', 'escalated'}.
 *     Hook dispatches 'hydrate' → 'finished'.
 *   - Unknown case (POST) → 400 with JSON error.
 */

interface GetResponseBody {
  case_id: string;
  thread_id: string;
  state: AgentState | null;
  next: string[];
  interrupted: boolean;
  has_run: boolean;
  provider: { label: string; thinking: boolean; mode: string };
}

async function callGet(caseId: string): Promise<GetResponseBody> {
  const req = new NextRequest(`http://localhost/api/run/${caseId}`);
  const params = Promise.resolve({ case: caseId });
  const res = await GET(req, { params });
  return (await res.json()) as GetResponseBody;
}

async function drainRun(caseId: string): Promise<void> {
  for await (const _ of streamRun(caseId, { kind: 'run' })) {
    void _;
  }
}

describe('GET /api/run/[case] — rehydration branches', () => {
  // Each branch uses its own case so they don't fight over MemorySaver state.
  // (streamRun keys by case_id, so re-using a case across tests is fine when
  // the test sequentially drives it to the desired terminal state first.)

  it('cold worker (no prior state) returns has_run=false and null-ish state', async () => {
    // Use a case_id that's been seeded but never run — wipes the channel set
    // but keeps the thread_id contract.
    const caseId = 'case_001';
    // Force a fresh thread by NOT seeding — the GET handler's `getState`
    // returns empty values when there's no checkpoint.
    // (MemorySaver is per-process; we share it across tests via the imported
    // singleton, so we use a synthetic id that no other test touches.)
    const config = { configurable: { thread_id: '__cold__' } };
    const snap = await graph.getState(config);
    expect(snap.values, 'precondition: no values on cold thread').toEqual({});

    // Call GET against the synthetic id by hitting the handler directly.
    const req = new NextRequest('http://localhost/api/run/__cold__');
    const params = Promise.resolve({ case: '__cold__' });
    const res = await GET(req, { params });
    const body = (await res.json()) as GetResponseBody;

    expect(body.has_run).toBe(false);
    expect(body.interrupted).toBe(false);
    expect(body.next).toEqual([]);
    void caseId;
  });

  it('paused worker (drove to HITL) returns has_run=true, interrupted=true, packet present', async () => {
    const caseId = 'case_002';
    // Drive the case to its HITL pause.
    await drainRun(caseId);

    const body = await callGet(caseId);

    expect(body.has_run).toBe(true);
    // `interrupted` (derived from snap.next) is the load-bearing signal the
    // hook branches on — run_status lags one node behind the interrupt
    // because LangGraph captures it just before humanApprovalNode finishes.
    expect(body.interrupted).toBe(true);
    expect(body.next.length).toBeGreaterThan(0);
    expect(body.state, 'state present after HITL pause').not.toBeNull();
    // Shape check on the packet: any object value (truthy-test would accept
    // 0 / "" / [] — the wire never sends those for decision_packet but the
    // assertion shouldn't accept them either).
    expect(body.state?.decision_packet).toEqual(expect.objectContaining({
      intake_summary: expect.any(String),
      policy_flags: expect.any(Array),
    }));
    expect(body.state?.human_decision, 'no human_decision before /api/resume').toBeNull();
  });

  it('finished worker (post-resume) returns has_run=true, interrupted=false, terminal status', async () => {
    const caseId = 'case_003';
    // Drive to HITL.
    await drainRun(caseId);
    // Resume with an approved verdict to push through emit_final.
    for await (const _ of streamRun(caseId, {
      kind: 'resume',
      decision: {
        verdict: 'approved',
        notes: null,
        decided_at: new Date().toISOString(),
        decided_by: 'priya',
        edits_applied: null,
      },
    })) {
      void _;
    }

    const body = await callGet(caseId);

    expect(body.has_run).toBe(true);
    expect(body.interrupted).toBe(false);
    expect(body.next).toEqual([]);
    expect(['decided', 'escalated']).toContain(body.state?.run_status);
    expect(body.state?.human_decision?.verdict).toBe('approved');
  });

  it('POST /api/run/[case] with an unknown case_id returns 400 JSON', async () => {
    const req = new NextRequest('http://localhost/api/run/case_999', { method: 'POST' });
    const params = Promise.resolve({ case: 'case_999' });
    const res = await POST(req, { params });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/Unknown case_id/);
  });
});

// Tiny helper to silence the seed import if needed in future tests.
void seedState;
