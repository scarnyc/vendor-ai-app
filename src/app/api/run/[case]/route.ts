import { NextRequest, NextResponse } from 'next/server';
import { Command } from '@langchain/langgraph';
import { graph, seedState } from '@/lib/agent/graph';
import { CASE_IDS } from '@/lib/cases';
import { getProviderInfo } from '@/lib/agent/llm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

/**
 * POST /api/run/[case]
 *
 * Drives the LangGraph thread keyed by case_id. The first call seeds state
 * and resumes the `await_run` interrupt with `Command(resume="run")`. The
 * graph then runs until the next interrupt (human_approval) OR a terminal
 * END node (escalate_to_human path on incomplete intake).
 *
 * Returns the final state snapshot for the client to render. Thread_id ===
 * case_id so a subsequent /api/resume call lands on the same thread.
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

  const config = { configurable: { thread_id: caseId } };

  try {
    const existing = await graph.getState(config);
    const hasState = Object.keys(existing.values ?? {}).length > 0;
    const stillRunning = (existing.next ?? []).length > 0;

    // Already running OR awaiting human input — re-POSTing would inject
    // 'run' into the active interrupt and corrupt state. Return the current
    // snapshot unchanged so the UI re-syncs without disturbing the thread.
    if (hasState && stillRunning) {
      return NextResponse.json({
        case_id: caseId,
        thread_id: caseId,
        state: existing.values,
        next: existing.next,
        interrupted: true,
        provider: getProviderInfo(),
      });
    }

    // Fresh thread (no state) — seed then start the run.
    if (!hasState) {
      await graph.updateState(config, seedState(caseId), undefined);
    }

    await graph.invoke(new Command({ resume: 'run' }), config);

    const finalSnap = await graph.getState(config);
    return NextResponse.json({
      case_id: caseId,
      thread_id: caseId,
      state: finalSnap.values,
      next: finalSnap.next,
      interrupted: (finalSnap.next?.length ?? 0) > 0,
      provider: getProviderInfo(),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error';
    return NextResponse.json(
      { error: `agent run failed: ${msg}`, case_id: caseId },
      { status: 500 }
    );
  }
}

/**
 * GET /api/run/[case] — fetch current thread state without advancing.
 * Used for case-tab switching: if the case has been run before, restore
 * its decided/awaiting state without re-invoking the graph.
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
