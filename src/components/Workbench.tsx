'use client';

import { useState } from 'react';
import { CASES, type CaseId } from '@/lib/cases';
import type { PolicyCitation } from '@/lib/agent/schemas';
import { useStreamingRun } from '@/hooks/useStreamingRun';
import { CaseTabs } from './CaseTabs';
import { CanvasHeader } from './CanvasHeader';
import { PlanList } from './PlanList';
import { ToolAuditCard } from './ToolAuditCard';
import { DecisionPacketCard } from './DecisionPacketCard';
import { ConfirmationCard } from './ConfirmationCard';
import { RunEmpty } from './RunEmpty';
import { PolicyDrawer } from './PolicyDrawer';

/**
 * Workbench — streaming AG-UI consumer.
 *
 * State, tool audit cards, decision packet, and HITL gate all build
 * progressively from the SSE event stream owned by useStreamingRun. The
 * legacy plain-JSON POST + polling fallback was retired with the streaming
 * refactor; MemorySaver still backs return-visit rehydration via GET.
 */
export function Workbench() {
  const [caseId, setCaseId] = useState<CaseId>('case_001');
  const [drawerCitation, setDrawerCitation] = useState<PolicyCitation | null>(null);

  const run = useStreamingRun(caseId);
  const caseMeta = CASES[caseId];

  const runStatus = run.agentState.run_status ?? 'await_run';
  const currentNode = run.agentState.current_node ?? null;
  const decisionPacket = run.decisionPacket;
  const tools = run.tools;
  const inFlightTool = run.inFlightTools.at(-1) ?? null;

  const busy = run.phase === 'streaming' || run.phase === 'countdown';
  const showRunEmpty =
    (run.phase === 'idle' || run.phase === 'countdown') && tools.length === 0;

  return (
    <div className="app">
      <main className="canvas">
        <CanvasHeader
          caseMeta={caseMeta}
          runStatus={runStatus}
          decisionPacket={decisionPacket}
          providerInfo={run.provider}
        />
        <CaseTabs caseId={caseId} onChange={setCaseId} />

        <div className="canvas-body">
          <div className="canvas-body-inner">
            {run.errorMessage && (
              <div
                className="flag f-block"
                role="alert"
                style={{ marginBottom: 12 }}
              >
                <div className="flag-bar" />
                <div className="flag-body">
                  <div className="flag-recipient">→ Operator</div>
                  <div className="flag-issue">
                    {run.errorMessage}
                    {' · '}
                    <button
                      type="button"
                      className="btn"
                      onClick={run.retry}
                      style={{ marginLeft: 8 }}
                    >
                      Retry
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showRunEmpty ? (
              <RunEmpty
                caseMeta={caseMeta}
                busy={busy}
                countdownSecondsRemaining={run.countdownSecondsRemaining}
                onRun={run.startNow}
                onCancelCountdown={run.cancelCountdown}
              />
            ) : (
              <>
                <PlanList
                  currentNode={currentNode}
                  runStatus={runStatus}
                  activeToolName={inFlightTool}
                />

                {tools.length > 0 && (
                  <>
                    <div
                      className="audit-section-label"
                      style={{ marginTop: 18 }}
                    >
                      Tool audit · {tools.length} call{tools.length === 1 ? '' : 's'}
                    </div>
                    {tools.map((t, i) => (
                      <ToolAuditCard
                        key={`${t.tool_name}-${i}`}
                        record={t}
                        packet={decisionPacket}
                        defaultOpen={i === 0}
                        onCitationClick={setDrawerCitation}
                      />
                    ))}
                  </>
                )}

                {decisionPacket && (
                  <DecisionPacketCard
                    packet={decisionPacket}
                    onCitationClick={setDrawerCitation}
                  >
                    {run.phase === 'paused' || run.phase === 'finished' ? (
                      <ConfirmationCard
                        packet={decisionPacket}
                        busy={run.phase !== 'paused'}
                        onSubmit={run.submitDecision}
                      />
                    ) : null}
                  </DecisionPacketCard>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      <PolicyDrawer
        citation={drawerCitation}
        onClose={() => setDrawerCitation(null)}
      />
    </div>
  );
}
