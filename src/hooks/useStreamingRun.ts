'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CaseId } from '@/lib/cases';
import type { AgentState, HumanDecision } from '@/lib/agent/schemas';
import { streamAgUiEvents } from '@/lib/agui/client';
import {
  INITIAL_STATE,
  reducer,
  type StreamingRunState,
  type StreamPhase,
} from './streamingRunReducer';

/**
 * useStreamingRun — owns the SSE lifecycle for a single case_id.
 *
 * The returned `state` is a discriminated union over `phase`; the compiler
 * enforces, e.g., that 'paused' always carries a non-null `decisionPacket`.
 * The pure reducer lives in ./streamingRunReducer so it's unit-testable
 * without spinning up React.
 *
 * Disconnect policy (per plan): NO auto-retry. The hook surfaces an 'error'
 * state with a `retry()` action. The server's MemorySaver checkpoint means
 * retry replays from cache when state was reached, or POSTs fresh otherwise.
 *
 * React 19 strict-mode safety: a second mount cycle for the same case while
 * a stream is in flight is a no-op. The hook dedupes via `streamingCases`
 * (cleared synchronously on cleanup so a rapid re-mount can start a fresh
 * stream).
 *
 * Multi-tab / case-switch safety: countdown timers and abort controllers
 * are owned by `useEffect` cleanups, so navigating away cancels cleanly.
 */

export type { StreamPhase, StreamingRunState };

interface ProviderInfo {
  label: string;
  thinking: boolean;
  mode: string;
}

interface RehydrateResponse {
  case_id: CaseId;
  thread_id: string;
  state: AgentState | null;
  next: string[];
  interrupted: boolean;
  has_run: boolean;
  provider?: ProviderInfo;
}

export interface UseStreamingRunOptions {
  countdownMs?: number;
}

export interface UseStreamingRunResult {
  state: StreamingRunState;
  provider: ProviderInfo | null;
  startNow: () => void;
  cancelCountdown: () => void;
  submitDecision: (decision: HumanDecision) => Promise<void>;
  retry: () => void;
}

export function useStreamingRun(
  caseId: CaseId,
  options: UseStreamingRunOptions = {}
): UseStreamingRunResult {
  const countdownMs = options.countdownMs ?? 3000;

  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);
  const runAbortRef = useRef<AbortController | null>(null);
  const resumeAbortRef = useRef<AbortController | null>(null);
  const streamingCases = useRef<Set<CaseId>>(new Set());
  const submittingRef = useRef<boolean>(false);
  const lastRehydrateRef = useRef<{ caseId: CaseId; hadState: boolean } | null>(null);
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);

  const clearCountdown = useCallback(() => {
    if (countdownTimer.current) {
      clearTimeout(countdownTimer.current);
      countdownTimer.current = null;
    }
    if (countdownTick.current) {
      clearInterval(countdownTick.current);
      countdownTick.current = null;
    }
  }, []);

  const handleMalformed = useCallback((raw: string, err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error('[useStreamingRun] malformed SSE frame', { raw, detail });
    dispatch({
      kind: 'error',
      code: 'malformed_event',
      message: `Stream corruption: ${detail}`,
      canRetry: true,
    });
    runAbortRef.current?.abort();
    resumeAbortRef.current?.abort();
  }, []);

  const openStream = useCallback(
    (url: string, init: RequestInit) => {
      if (streamingCases.current.has(caseId)) return;
      streamingCases.current.add(caseId);

      const controller = new AbortController();
      runAbortRef.current = controller;

      (async () => {
        try {
          for await (const event of streamAgUiEvents(url, init, {
            signal: controller.signal,
            onMalformed: handleMalformed,
          })) {
            dispatch({ kind: 'event', event });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Stream failed';
          dispatch({
            kind: 'error',
            code: 'stream_failed',
            message,
            canRetry: true,
          });
        } finally {
          streamingCases.current.delete(caseId);
          if (runAbortRef.current === controller) runAbortRef.current = null;
        }
      })();
    },
    [caseId, handleMalformed]
  );

  const startStream = useCallback(() => {
    clearCountdown();
    dispatch({ kind: 'enter_streaming' });
    openStream(`/api/run/${caseId}`, { method: 'POST' });
  }, [caseId, clearCountdown, openStream]);

  const rehydrate = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`/api/run/${caseId}`);
      if (!res.ok) {
        dispatch({
          kind: 'error',
          code: res.status >= 500 ? 'rehydrate_server_error' : 'rehydrate_failed',
          message: `Rehydrate failed: HTTP ${res.status}`,
          canRetry: true,
        });
        return false;
      }
      const data = (await res.json()) as RehydrateResponse;
      if (data.provider) setProvider(data.provider);
      if (data.state && data.has_run) {
        dispatch({
          kind: 'hydrate',
          state: data.state,
          interrupted: data.interrupted,
        });
        lastRehydrateRef.current = { caseId, hadState: true };
        return true;
      }
      lastRehydrateRef.current = { caseId, hadState: false };
      return false;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Rehydrate failed';
      dispatch({
        kind: 'error',
        code: 'rehydrate_network_error',
        message,
        canRetry: true,
      });
      return false;
    }
  }, [caseId]);

  const armCountdown = useCallback(() => {
    clearCountdown();
    dispatch({
      kind: 'enter_countdown',
      secondsRemaining: Math.ceil(countdownMs / 1000),
    });

    let remaining = Math.ceil(countdownMs / 1000);
    countdownTick.current = setInterval(() => {
      remaining = Math.max(0, remaining - 1);
      dispatch({ kind: 'countdown_tick', secondsRemaining: remaining });
    }, 1000);

    countdownTimer.current = setTimeout(() => {
      startStream();
    }, countdownMs);
  }, [clearCountdown, countdownMs, startStream]);

  const cancelCountdown = useCallback(() => {
    clearCountdown();
    dispatch({ kind: 'reset_to_idle' });
  }, [clearCountdown]);

  const startNow = useCallback(() => {
    if (streamingCases.current.has(caseId)) return;
    startStream();
  }, [caseId, startStream]);

  const retry = useCallback(() => {
    // If MemorySaver still had state at last rehydrate, prefer re-reading
    // it rather than re-POSTing (which would replay from the checkpoint
    // but uses budget for the SSE round-trip).
    if (lastRehydrateRef.current?.hadState) {
      void rehydrate();
      return;
    }
    startStream();
  }, [rehydrate, startStream]);

  const submitDecision = useCallback(
    async (decision: HumanDecision) => {
      // Synchronous re-entrance guard — protects against React 19 strict
      // mode double-mount and operator double-clicks that would otherwise
      // fire two POST /api/resume requests.
      if (submittingRef.current) return;
      submittingRef.current = true;

      const controller = new AbortController();
      resumeAbortRef.current = controller;
      try {
        for await (const event of streamAgUiEvents(
          '/api/resume',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ case_id: caseId, decision }),
          },
          { signal: controller.signal, onMalformed: handleMalformed }
        )) {
          dispatch({ kind: 'event', event });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Resume failed';
        dispatch({
          kind: 'error',
          code: 'resume_failed',
          message,
          canRetry: false,
        });
      } finally {
        submittingRef.current = false;
        if (resumeAbortRef.current === controller) resumeAbortRef.current = null;
      }
    },
    [caseId, handleMalformed]
  );

  // Per-case lifecycle: rehydrate first; if MemorySaver has state, paint it
  // and skip the countdown. Otherwise arm the first-visit countdown.
  useEffect(() => {
    let cancelled = false;
    dispatch({ kind: 'reset_to_idle' });
    clearCountdown();

    (async () => {
      const hadState = await rehydrate();
      if (cancelled) return;
      if (!hadState && lastRehydrateRef.current?.caseId === caseId) {
        // No prior state (or cache lost on a cold worker). Per plan's
        // MemorySaver fallback: re-show countdown rather than empty canvas;
        // operator can cancel or wait.
        armCountdown();
      }
    })();

    return () => {
      cancelled = true;
      clearCountdown();
      // Synchronously clear so a quick re-mount can start a new stream —
      // the in-flight async finally clause is racy with a fresh openStream.
      streamingCases.current.delete(caseId);
      if (runAbortRef.current) {
        runAbortRef.current.abort();
        runAbortRef.current = null;
      }
      if (resumeAbortRef.current) {
        resumeAbortRef.current.abort();
        resumeAbortRef.current = null;
      }
    };
  }, [caseId, armCountdown, clearCountdown, rehydrate]);

  return {
    state,
    provider,
    startNow,
    cancelCountdown,
    submitDecision,
    retry,
  };
}
