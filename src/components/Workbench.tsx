'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CASES, CASE_IDS, type CaseId } from '@/lib/cases';
import type { AgentState, HumanDecision, PolicyCitation } from '@/lib/agent/schemas';
import { CaseTabs } from './CaseTabs';
import { CanvasHeader } from './CanvasHeader';
import { PlanList } from './PlanList';
import { ToolAuditCard } from './ToolAuditCard';
import { DecisionPacketCard } from './DecisionPacketCard';
import { ConfirmationCard } from './ConfirmationCard';
import { RunEmpty } from './RunEmpty';
import { PolicyDrawer } from './PolicyDrawer';

interface ProviderInfo {
  label: string;
  thinking: boolean;
  mode: string;
}

interface RunResponse {
  case_id: CaseId;
  thread_id: string;
  state: AgentState | null;
  next: string[];
  interrupted: boolean;
  provider?: ProviderInfo;
}

export function Workbench() {
  const [caseId, setCaseId] = useState<CaseId>('case_001');
  const [stateByCase, setStateByCase] = useState<Partial<Record<CaseId, AgentState>>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerCitation, setDrawerCitation] = useState<PolicyCitation | null>(null);
  const [providerInfo, setProviderInfo] = useState<ProviderInfo | null>(null);
  const fetchedCases = useRef<Set<CaseId>>(new Set());

  const state = stateByCase[caseId] ?? null;
  const caseMeta = CASES[caseId];

  // Restore per-case state when switching tabs (one fetch per case per session).
  useEffect(() => {
    if (fetchedCases.current.has(caseId)) return;
    fetchedCases.current.add(caseId);
    let cancelled = false;
    fetch(`/api/run/${caseId}`)
      .then((r) => r.json() as Promise<RunResponse>)
      .then((data) => {
        if (cancelled) return;
        if (data.provider) setProviderInfo(data.provider);
        if (!data.state) return;
        setStateByCase((prev) => ({ ...prev, [caseId]: data.state! }));
      })
      .catch(() => {
        // Silent: an unfetched thread is just await_run; user can press Run.
      });
    return () => {
      cancelled = true;
    };
  }, [caseId]);

  const sync = useCallback((data: RunResponse) => {
    if (data.provider) setProviderInfo(data.provider);
    if (data.state) {
      setStateByCase((prev) => ({ ...prev, [data.case_id]: data.state! }));
    }
  }, []);

  const runAgent = useCallback(
    async (id: CaseId) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch(`/api/run/${id}`, { method: 'POST' });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Run failed with HTTP ${res.status}`);
        }
        const data = (await res.json()) as RunResponse;
        sync(data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Run failed';
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [sync]
  );

  const submitDecision = useCallback(
    async (decision: HumanDecision) => {
      setBusy(true);
      setError(null);
      try {
        const res = await fetch('/api/resume', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ case_id: caseId, decision }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.error ?? `Resume failed with HTTP ${res.status}`);
        }
        const data = (await res.json()) as RunResponse;
        sync(data);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : 'Resume failed';
        setError(msg);
      } finally {
        setBusy(false);
      }
    },
    [caseId, sync]
  );

  const runStatus = state?.run_status ?? 'await_run';
  const showRunEmpty = runStatus === 'await_run' && !state?.decision_packet;
  const decisionPacket = state?.decision_packet ?? null;
  const tools = state?.tools_called ?? [];

  return (
    <div className="app">
      <main className="canvas">
        <CanvasHeader
          caseMeta={caseMeta}
          runStatus={runStatus}
          decisionPacket={decisionPacket}
          providerInfo={providerInfo}
        />
        <CaseTabs
          caseId={caseId}
          onChange={(id) => {
            setCaseId(id);
          }}
        />

        <div className="canvas-body">
          <div className="canvas-body-inner">
            {error && (
              <div
                className="flag f-block"
                role="alert"
                style={{ marginBottom: 12 }}
              >
                <div className="flag-bar" />
                <div className="flag-body">
                  <div className="flag-recipient">→ Operator</div>
                  <div className="flag-issue">{error}</div>
                </div>
              </div>
            )}

            {showRunEmpty ? (
              <RunEmpty
                caseMeta={caseMeta}
                busy={busy}
                onRun={() => runAgent(caseId)}
              />
            ) : (
              <>
                <PlanList
                  currentNode={state?.current_node ?? null}
                  runStatus={runStatus}
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
                    <ConfirmationCard
                      packet={decisionPacket}
                      busy={busy}
                      onSubmit={submitDecision}
                    />
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
