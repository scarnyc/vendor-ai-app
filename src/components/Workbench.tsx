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

export function Workbench() {
  const [caseId, setCaseId] = useState<CaseId>('case_001');
  const [drawerCitation, setDrawerCitation] = useState<PolicyCitation | null>(null);

  const run = useStreamingRun(caseId);
  const { state } = run;
  const caseMeta = CASES[caseId];

  const runStatus = state.agentState.run_status ?? 'await_run';
  const currentNode = state.agentState.current_node ?? null;
  const decisionPacket = state.decisionPacket;
  const tools = state.tools;
  const inFlightTool = state.inFlightTools.at(-1) ?? null;

  const busy = state.phase === 'streaming' || state.phase === 'countdown';
  const showRunEmpty =
    (state.phase === 'idle' || state.phase === 'countdown') && tools.length === 0;
  const countdownSecondsRemaining =
    state.phase === 'countdown' ? state.countdownSecondsRemaining : null;
  const errorBlock = state.phase === 'error'
    ? { message: state.errorMessage, code: state.errorCode, canRetry: state.canRetry }
    : null;

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
            {errorBlock && (
              <div
                className="flag f-block"
                role="alert"
                style={{ marginBottom: 12 }}
              >
                <div className="flag-bar" />
                <div className="flag-body">
                  <div className="flag-recipient">→ Operator</div>
                  <div className="flag-issue">
                    {errorBlock.message}
                    <span style={{ opacity: 0.6, fontSize: 11, marginLeft: 6 }}>
                      ({errorBlock.code})
                    </span>
                    {errorBlock.canRetry && (
                      <>
                        {' · '}
                        <button
                          type="button"
                          className="btn"
                          onClick={run.retry}
                          style={{ marginLeft: 8 }}
                        >
                          Retry
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            )}

            {showRunEmpty ? (
              <RunEmpty
                caseMeta={caseMeta}
                busy={busy}
                countdownSecondsRemaining={countdownSecondsRemaining}
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
                    {state.phase === 'paused' || state.phase === 'finished' ? (
                      <ConfirmationCard
                        packet={decisionPacket}
                        busy={state.phase !== 'paused'}
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
