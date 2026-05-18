// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup, waitFor } from '@testing-library/react';
import type { AgUiEvent } from '@/lib/agent/events';
import type { AgentState, HumanDecision } from '@/lib/agent/schemas';

/**
 * Integration tests for useStreamingRun's lifecycle invariants. The pure
 * reducer is covered in streamingRunReducer.test.ts; this file targets the
 * hook-owned behaviors that only fire when React drives the effects:
 *
 *   1. `streamingCases` Set dedupe — a re-mount while the SSE is in flight
 *      (React 19 strict-mode double-render or rapid case-switch) must not
 *      fan out two POST /api/run requests against the same case.
 *   2. `submittingRef` synchronous re-entrance guard — two operator clicks
 *      on Approve in the same tick must only fire one POST /api/resume.
 *   3. `retry()` branching — when `lastRehydrateRef.hadState` is true,
 *      retry must use GET /api/run (no LLM cost, skip SSE handshake); when
 *      false, it must POST /api/run to drive the graph fresh.
 *
 * Both transports (rehydrate GET, SSE generator) are mocked. The reducer
 * runs for real so we're asserting against the real state machine.
 */

interface StreamCall {
  url: string;
  init: RequestInit;
  resolve: (events: AgUiEvent[]) => void;
}

const streamCalls: StreamCall[] = [];

vi.mock('@/lib/agui/client', () => ({
  streamAgUiEvents: vi.fn(
    async function* (
      url: string,
      init: RequestInit
    ): AsyncGenerator<AgUiEvent, void, unknown> {
      const events = await new Promise<AgUiEvent[]>((resolve) => {
        streamCalls.push({ url, init, resolve });
      });
      for (const event of events) yield event;
    }
  ),
}));

const fetchMock = vi.fn();

beforeEach(() => {
  streamCalls.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  // Resolve any dangling streams so abort-on-unmount doesn't leak warnings.
  for (const call of streamCalls) call.resolve([]);
  cleanup();
  vi.unstubAllGlobals();
});

function mockRehydrate(opts: {
  has_run: boolean;
  state?: AgentState | null;
  interrupted?: boolean;
}): void {
  fetchMock.mockImplementation(async () =>
    new Response(
      JSON.stringify({
        case_id: 'case_001',
        thread_id: 'thr_001',
        state: opts.state ?? null,
        next: [],
        interrupted: opts.interrupted ?? false,
        has_run: opts.has_run,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  );
}

describe('useStreamingRun', () => {
  it('dedupes rapid re-mounts via streamingCases (strict-mode safety)', async () => {
    mockRehydrate({ has_run: false });
    const { useStreamingRun } = await import('../useStreamingRun');

    const { result, rerender } = renderHook(
      ({ caseId }) => useStreamingRun(caseId, { countdownMs: 60_000 }),
      { initialProps: { caseId: 'case_001' as const } }
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Skip the countdown — call startNow to fire POST.
    await act(async () => {
      result.current.startNow();
    });
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Re-render with same caseId (simulates strict-mode double-effect cycle).
    rerender({ caseId: 'case_001' as const });
    await act(async () => {
      await Promise.resolve();
    });

    // Even if startNow were called again, the Set dedupe must hold.
    await act(async () => {
      result.current.startNow();
    });
    expect(streamCalls.length).toBe(1);
  });

  it('submitDecision dedupes synchronous double-clicks', async () => {
    mockRehydrate({ has_run: false });
    const { useStreamingRun } = await import('../useStreamingRun');

    const { result } = renderHook(() =>
      useStreamingRun('case_001', { countdownMs: 60_000 })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const decision: HumanDecision = {
      verdict: 'approved',
      notes: null,
      decided_at: '2026-05-18T00:00:00.000Z',
      decided_by: 'priya',
      edits_applied: null,
    };

    // Two synchronous calls in the same tick — submittingRef must absorb #2.
    let p1: Promise<void>;
    let p2: Promise<void>;
    act(() => {
      p1 = result.current.submitDecision(decision);
      p2 = result.current.submitDecision(decision);
    });

    // Drain microtasks so the synchronous guard has a chance to short-circuit
    // p2 before either stream resolves.
    await act(async () => {
      await Promise.resolve();
    });

    // Only one resume stream should have opened — #2 short-circuited.
    const resumeCalls = streamCalls.filter((c) => c.url === '/api/resume');
    expect(resumeCalls.length).toBe(1);

    // Resolve the one open stream so the awaited promises settle cleanly.
    resumeCalls[0].resolve([]);
    await act(async () => {
      await p1!;
      await p2!;
    });
  });

  it('retry() rehydrates when prior rehydrate had state', async () => {
    const finishedState: AgentState = {
      case_id: 'case_001',
      run_status: 'decided',
      current_node: null,
      document_inventory: null,
      budget: null,
      duplicate_vendor: null,
      tcv: null,
      data_sensitivity: null,
      required_approvals: null,
      policy_flags: [],
      decision_packet: null,
      tools_called: [],
      human_decision: {
        verdict: 'approved',
        notes: null,
        decided_at: '2026-05-18T00:00:00.000Z',
        decided_by: 'priya',
        edits_applied: null,
      },
      error: null,
      candidate_clauses: null,
    };
    mockRehydrate({ has_run: true, state: finishedState });
    const { useStreamingRun } = await import('../useStreamingRun');

    const { result } = renderHook(() =>
      useStreamingRun('case_001', { countdownMs: 60_000 })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(streamCalls.length).toBe(0); // no POST — rehydrated from checkpoint

    // retry should re-GET, not POST.
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(streamCalls.length).toBe(0);
  });

  it('retry() POSTs when prior rehydrate had no state', async () => {
    mockRehydrate({ has_run: false });
    const { useStreamingRun } = await import('../useStreamingRun');

    const { result } = renderHook(() =>
      useStreamingRun('case_001', { countdownMs: 60_000 })
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(streamCalls.length).toBe(0);

    // retry on the no-state branch starts a fresh stream.
    await act(async () => {
      result.current.retry();
    });
    await waitFor(() => expect(streamCalls.length).toBe(1));
    expect(streamCalls[0].url).toBe('/api/run/case_001');
    expect(streamCalls[0].init.method).toBe('POST');
  });
});
