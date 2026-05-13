'use client';

import type { CaseMeta } from '@/lib/cases';
import { LENSES, type LensId } from '@/lib/personas';
import type { DecisionPacket, RunStatus } from '@/lib/agent/schemas';

interface ProviderInfo {
  label: string;
  thinking: boolean;
  mode: string;
}

interface Props {
  caseMeta: CaseMeta;
  lens: LensId;
  runStatus: RunStatus;
  decisionPacket: DecisionPacket | null;
  providerInfo?: ProviderInfo | null;
}

export function CanvasHeader({
  caseMeta,
  lens,
  runStatus,
  decisionPacket,
  providerInfo,
}: Props) {
  const lensMeta = LENSES.find((l) => l.id === lens);
  const showLensChip = lensMeta && !lensMeta.is_operator;

  return (
    <header className="canvas-header">
      <div>
        <div className="case-title">{caseMeta.vendor_name}</div>
        <div className="case-meta">
          {caseMeta.id} · {caseMeta.one_liner}
        </div>
      </div>
      <div className="header-spacer" />
      {providerInfo && (
        <span
          className={`provider-chip${providerInfo.thinking ? ' thinking' : ''}`}
          title={`Provider mode: ${providerInfo.mode}`}
        >
          {providerInfo.label}
        </span>
      )}
      {showLensChip && (
        <span className="lens-chip">viewing as: {lensMeta.label}</span>
      )}
      <StatusBadge runStatus={runStatus} decisionPacket={decisionPacket} />
    </header>
  );
}

/* Derivation order is intentional and exclusive (no fall-through 'decided'
 * branch — that case used to fire alongside packet-derived branches and
 * caused render ambiguity). The header always says either *what was
 * decided* or *what's recommended*, never the neutral "Decided". */
function StatusBadge({
  runStatus,
  decisionPacket,
}: {
  runStatus: RunStatus;
  decisionPacket: DecisionPacket | null;
}) {
  if (runStatus === 'await_run') {
    return <span className="badge">Idle</span>;
  }

  const decision = decisionPacket?.human_decision;
  if (decision) {
    switch (decision.verdict) {
      case 'approved':
        return <span className="badge b-success">Approved by operator</span>;
      case 'rejected':
        return <span className="badge b-danger">Rejected & escalated</span>;
      case 'edit_and_rerun':
        return <span className="badge b-warn">Edit &amp; re-run</span>;
      case 'request_followup':
        return <span className="badge b-warn">Follow-up requested</span>;
    }
  }

  if (decisionPacket?.recommended_action) {
    return (
      <span className="badge b-info">
        Recommends: {humanizeRecommendation(decisionPacket.recommended_action)}
      </span>
    );
  }

  if (runStatus === 'escalated') {
    return <span className="badge b-danger">Escalated</span>;
  }
  if (runStatus === 'awaiting_human') {
    return <span className="badge b-warn">Ready for review</span>;
  }
  return <span className="badge b-info">Working…</span>;
}

function humanizeRecommendation(action: DecisionPacket['recommended_action']): string {
  switch (action) {
    case 'approve_with_followup':
      return 'approve with follow-up';
    case 'escalate':
      return 'escalate';
    case 'block':
      return 'block — do not proceed';
  }
}
