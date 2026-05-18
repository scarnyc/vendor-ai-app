import type {
  AgentState,
  DecisionPacket,
  HumanDecision,
  ToolCallRecord,
} from '@/lib/agent/schemas';
import type { AgUiEvent, ToolName } from '@/lib/agent/events';

export type StreamPhase =
  | 'idle'
  | 'countdown'
  | 'streaming'
  | 'paused'
  | 'finished'
  | 'error';

interface BaseState {
  agentState: Partial<AgentState>;
  tools: ToolCallRecord[];
  inFlightTools: ToolName[];
  decisionPacket: DecisionPacket | null;
}

export type StreamingRunState =
  | (BaseState & { phase: 'idle' })
  | (BaseState & { phase: 'countdown'; countdownSecondsRemaining: number })
  | (BaseState & { phase: 'streaming' })
  | (BaseState & { phase: 'paused'; decisionPacket: DecisionPacket })
  | (BaseState & {
      phase: 'finished';
      decisionPacket: DecisionPacket | null;
      verdict: HumanDecision['verdict'] | null;
    })
  | (BaseState & {
      phase: 'error';
      errorCode: string;
      errorMessage: string;
      canRetry: boolean;
    });

export const BASE: BaseState = {
  agentState: {},
  tools: [],
  inFlightTools: [],
  decisionPacket: null,
};

export const INITIAL_STATE: StreamingRunState = { ...BASE, phase: 'idle' };

export type Action =
  | { kind: 'reset_to_idle' }
  | { kind: 'enter_countdown'; secondsRemaining: number }
  | { kind: 'countdown_tick'; secondsRemaining: number }
  | { kind: 'enter_streaming' }
  | { kind: 'hydrate'; state: AgentState; interrupted: boolean }
  | { kind: 'event'; event: AgUiEvent }
  | { kind: 'error'; code: string; message: string; canRetry: boolean };

function readBase(state: StreamingRunState): BaseState {
  return {
    agentState: state.agentState,
    tools: state.tools,
    inFlightTools: state.inFlightTools,
    decisionPacket: state.decisionPacket,
  };
}

export function reducer(state: StreamingRunState, action: Action): StreamingRunState {
  switch (action.kind) {
    case 'reset_to_idle':
      return INITIAL_STATE;

    case 'enter_countdown':
      return {
        ...BASE,
        phase: 'countdown',
        countdownSecondsRemaining: action.secondsRemaining,
      };

    case 'countdown_tick':
      if (state.phase !== 'countdown') return state;
      return { ...state, countdownSecondsRemaining: action.secondsRemaining };

    case 'enter_streaming':
      return {
        ...BASE,
        ...readBase(state),
        phase: 'streaming',
      };

    case 'hydrate': {
      const base: BaseState = {
        agentState: action.state,
        tools: action.state.tools_called ?? [],
        inFlightTools: [],
        decisionPacket: action.state.decision_packet,
      };
      if (action.interrupted && action.state.decision_packet) {
        return {
          ...base,
          phase: 'paused',
          decisionPacket: action.state.decision_packet,
        };
      }
      if (action.state.run_status === 'decided' || action.state.run_status === 'escalated') {
        return {
          ...base,
          phase: 'finished',
          verdict: action.state.human_decision?.verdict ?? null,
        };
      }
      return { ...base, phase: 'streaming' };
    }

    case 'event':
      return applyEvent(state, action.event);

    case 'error':
      return {
        ...BASE,
        ...readBase(state),
        phase: 'error',
        errorCode: action.code,
        errorMessage: action.message,
        canRetry: action.canRetry,
      };
  }
}

function applyEvent(state: StreamingRunState, event: AgUiEvent): StreamingRunState {
  switch (event.type) {
    case 'RUN_STARTED':
      return { ...BASE, ...readBase(state), phase: 'streaming' };

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
      const [head, ...rest] = event.path;
      if (!head) {
        console.warn('[reducer] dropping STATE_DELTA with empty path', event);
        return state;
      }
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
      // Nested paths aren't supported yet — surface the dropped event so we
      // notice if a node starts emitting them instead of silently desyncing.
      console.warn('[reducer] dropping STATE_DELTA with unsupported nested path', event);
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

    case 'RUN_PAUSED_AWAITING_HUMAN': {
      // §9 invariant: 'paused' requires a validated DecisionPacket already in
      // state. If the snapshot never arrived (validate_citations failed and
      // suppressed the snapshot), surface an error rather than render an
      // empty confirmation card.
      if (!state.decisionPacket) {
        return {
          ...BASE,
          ...readBase(state),
          phase: 'error',
          errorCode: 'paused_without_packet',
          errorMessage: 'Run paused before decision packet arrived.',
          canRetry: true,
        };
      }
      return {
        ...state,
        phase: 'paused',
        decisionPacket: state.decisionPacket,
      };
    }

    case 'RUN_RESUMED':
      return {
        ...BASE,
        ...readBase(state),
        phase: 'streaming',
        agentState: {
          ...state.agentState,
          human_decision: event.human_decision,
        },
      };

    case 'RUN_FINISHED':
      return {
        ...BASE,
        agentState: event.final_state,
        tools: event.final_state.tools_called ?? state.tools,
        inFlightTools: [],
        decisionPacket: event.final_state.decision_packet ?? state.decisionPacket,
        phase: 'finished',
        verdict: event.final_state.human_decision?.verdict ?? null,
      };

    case 'RUN_ERROR':
      return {
        ...BASE,
        ...readBase(state),
        phase: 'error',
        errorCode: event.code,
        errorMessage: event.message,
        canRetry: event.recoverable,
      };
  }
}
