import { NextRequest } from 'next/server';
import { HumanDecisionSchema } from '@/lib/agent/schemas';
import { CASE_IDS } from '@/lib/cases';
import { z } from 'zod';
import { events, encodeSse, type AgUiEvent } from '@/lib/agent/events';
import { streamRun } from '@/lib/agent/stream';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const ResumeBodySchema = z.object({
  case_id: z.string(),
  decision: HumanDecisionSchema,
});

/**
 * POST /api/resume — AG-UI event stream over SSE.
 *
 * Submits a HumanDecision into the human_approval interrupt and streams the
 * resumed graph's terminal events. Validation failures stream a single
 * RUN_ERROR frame (text/event-stream) rather than JSON, so the client's
 * event-stream contract holds on every code path.
 */
export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = ResumeBodySchema.safeParse(json);

  if (!parsed.success) {
    return sseErrorResponse({
      code: 'invalid_request',
      message: 'invalid request body',
    });
  }

  const { case_id: caseId, decision } = parsed.data;

  if (!CASE_IDS.includes(caseId as (typeof CASE_IDS)[number])) {
    return sseErrorResponse({
      code: 'unknown_case',
      message: `Unknown case_id "${caseId}"`,
    });
  }

  // See run/[case]/route.ts for the rationale.
  const abort = new AbortController();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: AgUiEvent) => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(encodeSse(event)));
        } catch (err) {
          if (!isControllerClosed(err)) {
            console.error('[api/resume] unexpected controller.enqueue failure', err);
          }
          abort.abort();
        }
      };

      try {
        for await (const event of streamRun(caseId, {
          kind: 'resume',
          decision,
        })) {
          if (abort.signal.aborted) break;
          send(event);
        }
        if (!abort.signal.aborted) controller.close();
      } catch (err) {
        if (abort.signal.aborted) return;
        const message = err instanceof Error ? err.message : String(err);
        console.error('[api/resume] graph stream error', err);
        try {
          send(
            events.runError({
              code: 'resume_error',
              message,
              recoverable: false,
            })
          );
        } catch (sendErr) {
          if (!isControllerClosed(sendErr)) {
            console.error('[api/resume] runError send failed', sendErr);
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
 * Narrow guard for the closed-ReadableStreamDefaultController TypeError that
 * fires when a client aborts mid-stream. Real bugs propagate to console.
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
 * One-shot SSE response carrying a single RUN_ERROR frame. Validation
 * failures use this so the client's event-stream contract holds — no JSON
 * branch the reducer would have to learn.
 */
function sseErrorResponse(p: {
  code: string;
  message: string;
}): Response {
  const body = encodeSse(
    events.runError({ code: p.code, message: p.message, recoverable: false })
  );
  return new Response(body, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
