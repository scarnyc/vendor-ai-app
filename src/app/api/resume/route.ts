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
 * resumed graph's terminal events. Today, all four verdicts route through
 * emit_final to END (no further tool nodes); the resume stream is therefore
 * short: RUN_RESUMED → STATE_DELTA(human_decision, run_status) → RUN_FINISHED.
 *
 * The stream still observes TOOL_CALL_START/END for any node it traverses,
 * so a future graph change that adds tool work to the post-resume path
 * (e.g. spinning up draft_vendor_followup for the follow_up verdict) will
 * surface in the UI without further wiring.
 *
 * Validation failures stream a single RUN_ERROR frame instead of returning
 * JSON, so the client's event-stream contract holds on every code path.
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

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      const send = (event: AgUiEvent) => {
        controller.enqueue(encoder.encode(encodeSse(event)));
      };

      try {
        for await (const event of streamRun(caseId, {
          kind: 'resume',
          decision,
        })) {
          send(event);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          send(
            events.runError({
              code: 'resume_error',
              message,
              recoverable: false,
            })
          );
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
 * Build a one-shot SSE response carrying a single RUN_ERROR frame. Used for
 * validation failures so the client's event-stream contract holds even on
 * the 400-equivalent path — no JSON branch the reducer would have to learn.
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
