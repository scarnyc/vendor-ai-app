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
 * Event-generation lives in `streamRun()`; ordering invariants are documented
 * there. This handler only does SSE framing, provider-label rewrite, and
 * abort lifecycle.
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
        } catch (err) {
          // The only enqueue-time error we expect is the closed-controller
          // TypeError that fires when the client disconnects mid-stream. Log
          // anything else so a real bug isn't masked by the abort path.
          if (!isControllerClosed(err)) {
            console.error('[api/run] unexpected controller.enqueue failure', err);
          } else {
            // Observability for the stranded-stream window: post-iterator-
            // drain terminal frames (STATE_SNAPSHOT, RUN_PAUSED_AWAITING_HUMAN)
            // silently dropped when the client closes between iterator exit
            // and the post-loop yields. Client-side reconcile (useStreamingRun
            // openStream finally) recovers; this gives us a count.
            console.warn('[api/run] terminal frame dropped post-close', {
              case_id: caseId,
              event_type: event.type,
            });
          }
          abort.abort();
        }
      };

      try {
        for await (const event of streamRun(caseId, { kind: 'run' })) {
          if (abort.signal.aborted) break;
          // streamRun emits RUN_STARTED with provider='unspecified' so the
          // generator stays pure. Rewrite here so the wire carries the live
          // provider label.
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
        } catch (sendErr) {
          if (!isControllerClosed(sendErr)) {
            console.error('[api/run] runError send failed', sendErr);
          } else {
            console.warn('[api/run] terminal frame dropped post-close', {
              case_id: caseId,
              event_type: 'RUN_ERROR',
            });
          }
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
 * Narrow guard for the closed-ReadableStreamDefaultController error we expect
 * when a client aborts mid-stream. Anything else propagates up to a console
 * log so genuine bugs aren't swallowed by the abort path.
 */
function isControllerClosed(err: unknown): boolean {
  if (!(err instanceof TypeError)) return false;
  const msg = err.message;
  return (
    msg.includes('Controller is already closed') ||
    msg.includes('Invalid state')
  );
}

/**
 * GET /api/run/[case] — fetch current thread state without advancing.
 * Returns has_run=false when the worker has no record of the case (cold
 * worker on Vercel, in-memory cache eviction). The client re-shows the
 * countdown rather than an empty canvas.
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
