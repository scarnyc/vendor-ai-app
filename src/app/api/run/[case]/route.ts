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
 * Event-generation lives in `streamRun()`; the event ordering invariants
 * are documented there. This handler is just SSE framing + provider-label
 * rewrite + lifecycle (close / error).
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

  // Shared with start()/cancel() so a client abort flips it and the for-await
  // stops trying to enqueue into a closed controller. The graph.stream()
  // iterator inside streamRun keeps draining server-side regardless — that's
  // intentional, so MemorySaver still commits even if the client disconnects.
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: AgUiEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch {
          abort.abort();
        }
      };

      try {
        for await (const event of streamRun(caseId, { kind: 'run' })) {
          if (abort.signal.aborted) break;
          // streamRun emits RUN_STARTED with provider='unspecified' so the
          // generator stays pure. Rewrite it here so the wire carries the
          // live provider label.
          if (event.type === 'RUN_STARTED') {
            send({ ...event, provider: providerLabel });
          } else {
            send(event);
          }
        }
        if (!abort.signal.aborted) controller.close();
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('[api/run] graph stream error', err);
        try {
          send(events.runError({
            code: 'graph_error',
            message,
            recoverable: false,
          }));
        } catch {
          // Already errored — controller.error below still rejects the reader.
        }
        controller.error(err instanceof Error ? err : new Error(message));
      }
    },
    cancel() {
      abort.abort();
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
