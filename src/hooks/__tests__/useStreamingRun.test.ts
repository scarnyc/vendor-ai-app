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

  it('reconciles via rehydrate when stream ends without terminal frame', async () => {
    // Initial rehydrate: no prior state (cold case). Second rehydrate
    // (the stranded-stream reconcile) returns a finished state so the
    // reducer transitions to phase: 'finished'. The fact that the second
    // GET fires at all is the assertion that proves the finally-block
    // reconcile branch fired — i.e. server-side terminal-frame drop is
    // recoverable on the client without a manual refresh.
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

    let fetchCount = 0;
    fetchMock.mockImplementation(async () => {
      fetchCount += 1;
      // First GET: no run yet → no state, has_run=false (operator-driven start).
      // Second GET: this is the auto-reconcile after stranded stream → returns
      // the persisted MemorySaver snapshot.
      const body =
        fetchCount === 1
          ? { case_id: 'case_001', thread_id: 'thr', state: null, next: [], interrupted: false, has_run: false }
          : { case_id: 'case_001', thread_id: 'thr', state: finishedState, next: [], interrupted: false, has_run: true };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const { useStreamingRun } = await import('../useStreamingRun');

    const { result } = renderHook(() =>
      useStreamingRun('case_001', { countdownMs: 60_000 })
    );
    // Initial rehydrate completes.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // Operator clicks Run → POST /api/run/case_001 stream opens.
    await act(async () => {
      result.current.startNow();
    });
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Stream "ends" mid-flight WITHOUT yielding a terminal frame —
    // resolve with an empty event list. This simulates the server-side
    // terminal-frame drop window (controller close after iterator drain).
    await act(async () => {
      streamCalls[0].resolve([]);
      // Yield microtasks so the IIFE finally runs.
      await Promise.resolve();
      await Promise.resolve();
    });

    // Reconcile fires a second GET. Reducer transitions to 'finished'
    // off the second rehydrate response (run_status === 'decided').
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.state.phase).toBe('finished'));
  });

  it('does not reconcile when case-switch caused the abort', async () => {
    // Both cases return has_run=false; we only care about fetch COUNT per case.
    fetchMock.mockImplementation(async (url: string) => {
      const caseId = url.includes('case_002') ? 'case_002' : 'case_001';
      return new Response(
        JSON.stringify({
          case_id: caseId,
          thread_id: 'thr',
          state: null,
          next: [],
          interrupted: false,
          has_run: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const { useStreamingRun } = await import('../useStreamingRun');

    const { result, rerender } = renderHook(
      ({ caseId }) => useStreamingRun(caseId, { countdownMs: 60_000 }),
      { initialProps: { caseId: 'case_001' as 'case_001' | 'case_002' } }
    );
    // Initial rehydrate for case_001.
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes('case_001')).length
      ).toBe(1)
    );

    // Start a stream on case_001 so there's an in-flight controller to abort.
    await act(async () => {
      result.current.startNow();
    });
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Operator switches to case_002 — lifecycle cleanup flips
    // expectedTeardownRef.current = true BEFORE aborting, so the
    // finally must NOT fire a reconcile GET against case_001.
    rerender({ caseId: 'case_002' });

    // Drain the aborted stream's finally.
    await act(async () => {
      streamCalls[0].resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // case_001's GET count must stay at 1 (the initial rehydrate). No
    // stranded-reconcile GET fired for the abandoned case.
    const case001Gets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('case_001')
    ).length;
    expect(case001Gets).toBe(1);
  });

  it('default countdownMs=0 skips the countdown phase', async () => {
    mockRehydrate({ has_run: false });
    const { useStreamingRun } = await import('../useStreamingRun');

    const { result } = renderHook(() =>
      useStreamingRun('case_001', { countdownMs: 0 })
    );

    // After the initial rehydrate (has_run=false), armCountdown fires.
    // With countdownMs=0, ceil(0/1000)=0 and setTimeout(_, 0) flushes
    // startStream → enter_streaming on the next macrotask. The phase
    // must reach 'streaming' (or 'error' if anything fails) without
    // sitting in 'countdown' indefinitely.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(streamCalls.length).toBe(1), { timeout: 1000 });
    // We should never observe phase 'countdown' with a measurable
    // countdownSecondsRemaining > 0 when countdownMs=0.
    expect(result.current.state.phase).not.toBe('idle');
  });

  it('AC9: fast case-switch race does not reconcile for abandoned case', async () => {
    // Toggle case_001 → case_002 → case_001 within a tight window.
    // The pinned myCaseId in each stream's finally must skip reconcile
    // for any case the operator already navigated away from.
    fetchMock.mockImplementation(async (url: string) => {
      const caseId = url.includes('case_002') ? 'case_002' : 'case_001';
      return new Response(
        JSON.stringify({
          case_id: caseId,
          thread_id: 'thr',
          state: null,
          next: [],
          interrupted: false,
          has_run: false,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    });

    const { useStreamingRun } = await import('../useStreamingRun');

    const { result, rerender } = renderHook(
      ({ caseId }) => useStreamingRun(caseId, { countdownMs: 60_000 }),
      { initialProps: { caseId: 'case_001' as 'case_001' | 'case_002' } }
    );

    await waitFor(() =>
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes('case_001')).length
      ).toBe(1)
    );

    // Open a stream on case_001.
    await act(async () => {
      result.current.startNow();
    });
    await waitFor(() => expect(streamCalls.length).toBe(1));

    // Rapid toggle: case_001 → case_002 → case_001.
    rerender({ caseId: 'case_002' });
    rerender({ caseId: 'case_001' });

    // Drain the abandoned case_001 stream from before the toggles.
    await act(async () => {
      streamCalls[0].resolve([]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // case_001 GETs: 1 from initial mount, 1 from the second mount after
    // toggling back. The stranded-finally must NOT have added a third.
    const case001Gets = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes('case_001')
    ).length;
    expect(case001Gets).toBeLessThanOrEqual(2);
  });
});
