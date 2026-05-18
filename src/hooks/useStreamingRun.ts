'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { CaseId } from '@/lib/cases';
import type {
  AgentState,
  DecisionPacket,
  HumanDecision,
  ToolCallRecord,
} from '@/lib/agent/schemas';
import type { AgUiEvent, ToolName } from '@/lib/agent/events';
import { streamAgUiEvents } from '@/lib/agui/client';

/**
 * useStreamingRun — owns the SSE lifecycle for a single case_id.
 *
 * Three observable states:
 *   idle      — countdown not started, no live stream
 *   streaming — fetch + SSE reader is consuming events into state
 *   paused    — RUN_PAUSED_AWAITING_HUMAN was received; awaiting operator
 *               input via `submitDecision()`
 *   finished  — RUN_FINISHED received (post-resume terminal state)
 *   error     — RUN_ERROR received, or fetch threw
 *
 * Disconnect policy (per plan): NO auto-retry. If the connection drops mid-
 * stream, the hook surfaces an `error` state with a `retry()` action; the
 * server's MemorySaver checkpoint means re-POSTing replays from cache.
 *
 * React 19 strict-mode safety: a second mount cycle for the same case while
 * a stream is in flight is a no-op. The hook uses a ref to dedupe.
 *
 * Multi-tab / case-switch safety: countdown timers and abort controllers
 * live inside `useEffect` cleanups, so navigating away cancels cleanly.
 */

export type StreamPhase =
  | 'idle'
  | 'countdown'
  | 'streaming'
  | 'paused'
  | 'finished'
  | 'error';

export interface StreamingRunState {
  phase: StreamPhase;
  agentState: Partial<AgentState>;
  decisionPacket: DecisionPacket | null;
  tools: ToolCallRecord[];
  inFlightTools: ToolName[];
  errorMessage: string | null;
}

const INITIAL_STATE: StreamingRunState = {
  phase: 'idle',
  agentState: {},
  decisionPacket: null,
  tools: [],
  inFlightTools: [],
  errorMessage: null,
};

type Action =
  | { kind: 'reset_to_idle' }
  | { kind: 'hydrate'; state: AgentState }
  | { kind: 'set_phase'; phase: StreamPhase }
  | { kind: 'event'; event: AgUiEvent }
  | { kind: 'error'; message: string };

function reducer(state: StreamingRunState, action: Action): StreamingRunState {
  switch (action.kind) {
    case 'reset_to_idle':
      return INITIAL_STATE;
    case 'hydrate':
      return {
        phase: action.state.decision_packet ? 'paused' : 'streaming',
        agentState: action.state,
        decisionPacket: action.state.decision_packet,
        tools: action.state.tools_called,
        inFlightTools: [],
        errorMessage: null,
      };
    case 'set_phase':
      return { ...state, phase: action.phase };
    case 'event':
      return applyEvent(state, action.event);
    case 'error':
      return { ...state, phase: 'error', errorMessage: action.message };
  }
}

function applyEvent(state: StreamingRunState, event: AgUiEvent): StreamingRunState {
  switch (event.type) {
    case 'RUN_STARTED':
      return { ...state, phase: 'streaming', errorMessage: null };
    case 'TOOL_CALL_START':
      return {
        ...state,
        inFlightTools: [...state.inFlightTools, event.tool_name],
      };
    case 'TOOL_CALL_END': {
      const record = event.tool_call;
      const inFlight = [...state.inFlightTools];
      const idx = inFlight.indexOf(record.tool_name);
      if (idx !== -1) inFlight.splice(idx, 1);
      return {
        ...state,
        tools: [...state.tools, record],
        inFlightTools: inFlight,
      };
    }
    case 'STATE_DELTA': {
      // path is array of string keys; '-' means array append. Only top-level
      // single-key deltas are emitted by the server today, but the reducer
      // handles the append form so a future change doesn't silently no-op.
      const [head, ...rest] = event.path;
      if (!head) return state;
      if (rest.length === 0) {
        return {
          ...state,
          agentState: { ...state.agentState, [head]: event.value },
        };
      }
      if (rest.length === 1 && rest[0] === '-') {
        const current = (state.agentState as Record<string, unknown>)[head];
        const arr = Array.isArray(current) ? current : [];
        return {
          ...state,
          agentState: {
            ...state.agentState,
            [head]: [...arr, event.value],
          },
        };
      }
      return state;
    }
    case 'STATE_SNAPSHOT':
      return {
        ...state,
        decisionPacket: event.decision_packet,
        agentState: {
          ...state.agentState,
          decision_packet: event.decision_packet,
        },
      };
    case 'RUN_PAUSED_AWAITING_HUMAN':
      return { ...state, phase: 'paused' };
    case 'RUN_RESUMED':
      return {
        ...state,
        phase: 'streaming',
        agentState: {
          ...state.agentState,
          human_decision: event.human_decision,
        },
      };
    case 'RUN_FINISHED':
      return {
        ...state,
        phase: 'finished',
        agentState: event.final_state,
        decisionPacket:
          event.final_state.decision_packet ?? state.decisionPacket,
        tools: event.final_state.tools_called ?? state.tools,
        inFlightTools: [],
      };
    case 'RUN_ERROR':
      return {
        ...state,
        phase: 'error',
        errorMessage: event.message,
      };
  }
}

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

export interface UseStreamingRunResult extends StreamingRunState {
  countdownSecondsRemaining: number | null;
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
  const abortRef = useRef<AbortController | null>(null);
  const streamingCases = useRef<Set<CaseId>>(new Set());
  const seenCases = useRef<Set<CaseId>>(new Set());
  const countdownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTick = useRef<ReturnType<typeof setInterval> | null>(null);
  const [countdownRemaining, setCountdownRemaining] = useState<number | null>(null);
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
    setCountdownRemaining(null);
  }, [setCountdownRemaining]);

  const openStream = useCallback(
    (url: string, init: RequestInit) => {
      if (streamingCases.current.has(caseId)) return;
      streamingCases.current.add(caseId);

      const controller = new AbortController();
      abortRef.current = controller;

      (async () => {
        try {
          for await (const event of streamAgUiEvents(url, init, {
            signal: controller.signal,
          })) {
            dispatch({ kind: 'event', event });
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          const message = err instanceof Error ? err.message : 'Stream failed';
          dispatch({ kind: 'error', message });
        } finally {
          streamingCases.current.delete(caseId);
          if (abortRef.current === controller) abortRef.current = null;
        }
      })();
    },
    [caseId]
  );

  const startStream = useCallback(() => {
    clearCountdown();
    dispatch({ kind: 'set_phase', phase: 'streaming' });
    openStream(`/api/run/${caseId}`, { method: 'POST' });
  }, [caseId, clearCountdown, openStream]);

  const armCountdown = useCallback(() => {
    clearCountdown();
    dispatch({ kind: 'set_phase', phase: 'countdown' });
    setCountdownRemaining(Math.ceil(countdownMs / 1000));

    countdownTick.current = setInterval(() => {
      setCountdownRemaining((prev) => (prev != null && prev > 0 ? prev - 1 : prev));
    }, 1000);

    countdownTimer.current = setTimeout(() => {
      startStream();
    }, countdownMs);
  }, [clearCountdown, countdownMs, setCountdownRemaining, startStream]);

  const cancelCountdown = useCallback(() => {
    clearCountdown();
    dispatch({ kind: 'set_phase', phase: 'idle' });
  }, [clearCountdown]);

  const startNow = useCallback(() => {
    if (streamingCases.current.has(caseId)) return;
    startStream();
  }, [caseId, startStream]);

  const retry = useCallback(() => {
    startStream();
  }, [startStream]);

  const submitDecision = useCallback(
    async (decision: HumanDecision) => {
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        for await (const event of streamAgUiEvents(
          '/api/resume',
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ case_id: caseId, decision }),
          },
          { signal: controller.signal }
        )) {
          dispatch({ kind: 'event', event });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        const message = err instanceof Error ? err.message : 'Resume failed';
        dispatch({ kind: 'error', message });
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [caseId]
  );

  // Per-case lifecycle: rehydrate first; if MemorySaver has state, paint it
  // and skip the countdown. Otherwise arm the first-visit countdown.
  useEffect(() => {
    let cancelled = false;
    dispatch({ kind: 'reset_to_idle' });
    clearCountdown();

    (async () => {
      try {
        const res = await fetch(`/api/run/${caseId}`);
        if (cancelled) return;
        if (!res.ok) throw new Error(`Rehydrate failed: HTTP ${res.status}`);
        const data = (await res.json()) as RehydrateResponse;
        if (cancelled) return;
        if (data.provider) setProvider(data.provider);

        if (data.state && data.has_run) {
          dispatch({ kind: 'hydrate', state: data.state });
          seenCases.current.add(caseId);
          if (data.interrupted) {
            dispatch({ kind: 'set_phase', phase: 'paused' });
          } else if (data.state.run_status === 'decided' || data.state.run_status === 'escalated') {
            dispatch({ kind: 'set_phase', phase: 'finished' });
          }
          return;
        }

        // No prior state — first visit (or cold worker that lost the cache).
        // Either way, arm the countdown so the operator gets the same UX.
        if (!seenCases.current.has(caseId)) {
          seenCases.current.add(caseId);
          armCountdown();
        } else {
          // Returning to a case whose state was lost — re-arm rather than
          // showing an empty canvas (per plan's MemorySaver fallback).
          armCountdown();
        }
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : 'Rehydrate failed';
        dispatch({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
      clearCountdown();
      if (abortRef.current) {
        abortRef.current.abort();
        abortRef.current = null;
      }
    };
  }, [caseId, armCountdown, clearCountdown, setProvider]);

  return {
    ...state,
    countdownSecondsRemaining: countdownRemaining,
    provider,
    startNow,
    cancelCountdown,
    submitDecision,
    retry,
  };
}

