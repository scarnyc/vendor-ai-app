import { NextRequest, NextResponse } from 'next/server';
import { Command } from '@langchain/langgraph';
import { graph } from '@/lib/agent/graph';
import { HumanDecisionSchema } from '@/lib/agent/schemas';
import { getProviderInfo } from '@/lib/agent/llm';
import { CASE_IDS } from '@/lib/cases';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ResumeBodySchema = z.object({
  case_id: z.string(),
  decision: HumanDecisionSchema,
});

/**
 * POST /api/resume
 *
 * Submits a HumanDecision into the human_approval interrupt. The graph
 * continues until the next interrupt OR END:
 *   - approved / rejected / request_followup → emit_final → END
 *   - edit_and_rerun → loops back to classify_data_sensitivity, then runs
 *     through to human_approval again (next interrupt)
 */
export async function POST(req: NextRequest) {
  const json = await req.json().catch(() => null);
  const parsed = ResumeBodySchema.safeParse(json);

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid request body', details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { case_id: caseId, decision } = parsed.data;

  if (!CASE_IDS.includes(caseId as (typeof CASE_IDS)[number])) {
    return NextResponse.json({ error: `Unknown case_id "${caseId}"` }, { status: 400 });
  }

  const config = { configurable: { thread_id: caseId } };

  try {
    await graph.invoke(new Command({ resume: decision }), config);
    const snap = await graph.getState(config);
    return NextResponse.json({
      case_id: caseId,
      thread_id: caseId,
      state: snap.values,
      next: snap.next,
      interrupted: (snap.next?.length ?? 0) > 0,
      provider: getProviderInfo(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json({ error: `resume failed: ${msg}`, case_id: caseId }, { status: 500 });
  }
}
