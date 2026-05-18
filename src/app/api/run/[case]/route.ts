import { NextRequest, NextResponse } from 'next/server';
import { graph } from '@/lib/agent/graph';
import { CASE_IDS } from '@/lib/cases';
import { getProviderInfo } from '@/lib/agent/llm';
import { events, encodeSse, type AgUiEvent } from '@/lib/agent/events';
import { streamRun } from '@/lib/agent/stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/run/[case] — AG-UI event stream over SSE.
 *
 * Streams typed events as the LangGraph thread keyed by case_id advances.
 * Event-generation lives in `streamRun()`; this handler is the SSE framing
 * + provider-label rewrite + lifecycle (close / error).
 *
 * Sequence (happy path):
 *   RUN_STARTED → (per node) TOOL_CALL_START... STATE_DELTA... TOOL_CALL_END...
 *   → STATE_SNAPSHOT (after validate_citations; safe to render packet)
 *   → RUN_PAUSED_AWAITING_HUMAN (HITL) | RUN_FINISHED (escalation branch)
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ case: string }> }
) {
  const { case: caseId } = await params;

  if (!CASE_IDS.includes(caseId as (typeof CASE_IDS)[number])) {
    return NextResponse.json(
      { error: `Unknown case_id "${caseId}"` },
      { status: 400 }
    );
  }

  const providerLabel = getProviderInfo().label;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: AgUiEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      try {
        for await (const event of streamRun(caseId, { kind: 'run' })) {
          // streamRun emits RUN_STARTED with provider='unspecified' so it
          // stays pure (no LLM-module import). Rewrite it here so the wire
          // carries the live provider label.
          if (event.type === 'RUN_STARTED') {
            send({ ...event, provider: providerLabel });
          } else {
            send(event);
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          send(events.runError({
            code: 'graph_error',
            message,
            recoverable: false,
          }));
        } catch {
          // Controller may already be closed; swallow.
        }
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}

/**
 * GET /api/run/[case] — fetch current thread state without advancing.
 * Used for case-tab switching when MemorySaver has cached state for this
 * case in this worker process. Returns null when the worker has no record
 * of the case (cold worker on Vercel, in-memory cache eviction) — the
 * client should re-show the countdown card rather than empty canvas.
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ case: string }> }
) {
  const { case: caseId } = await params;
  const config = { configurable: { thread_id: caseId } };
  const snap = await graph.getState(config);
  return NextResponse.json({
    case_id: caseId,
    thread_id: caseId,
    state: snap.values,
    next: snap.next,
    interrupted: (snap.next?.length ?? 0) > 0,
    has_run: Object.keys(snap.values ?? {}).length > 0,
    provider: getProviderInfo(),
  });
}
