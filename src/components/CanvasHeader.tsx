'use client';

import type { CaseMeta } from '@/lib/cases';
import { LENSES, type LensId } from '@/lib/personas';
import type { RunStatus } from '@/lib/agent/schemas';

interface Props {
  caseMeta: CaseMeta;
  lens: LensId;
  runStatus: RunStatus;
}

export function CanvasHeader({ caseMeta, lens, runStatus }: Props) {
  const lensMeta = LENSES.find((l) => l.id === lens);
  const showLensChip = lensMeta && !lensMeta.is_operator;

  return (
    <div className="canvas-header">
      <div>
        <div className="case-title">{caseMeta.vendor_name}</div>
        <div className="case-meta">
          {caseMeta.id} · {caseMeta.one_liner}
        </div>
      </div>
      <div className="status-row">
        {showLensChip && (
          <span className="lens-chip">
            viewing as: {lensMeta.label}
          </span>
        )}
        <StatusBadge runStatus={runStatus} />
      </div>
    </div>
  );
}

function StatusBadge({ runStatus }: { runStatus: RunStatus }) {
  switch (runStatus) {
    case 'await_run':
      return <span className="badge">Idle</span>;
    case 'awaiting_human':
      return <span className="badge b-warn">Ready for review</span>;
    case 'decided':
      return <span className="badge b-success">Decided</span>;
    case 'escalated':
      return <span className="badge b-danger">Escalated</span>;
    default:
      return <span className="badge b-info">Working…</span>;
  }
}
