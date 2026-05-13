'use client';

import type { CaseMeta } from '@/lib/cases';

interface Props {
  caseMeta: CaseMeta;
  busy: boolean;
  onRun: () => void;
}

export function RunEmpty({ caseMeta, busy, onRun }: Props) {
  return (
    <div className="run-empty">
      <div className="run-empty-title">Ready to triage {caseMeta.vendor_name}</div>
      <div className="run-empty-sub">{caseMeta.one_liner}</div>
      <div className="run-empty-sub" style={{ fontSize: 12 }}>
        Press Run to parse the package, run the deterministic tools, classify
        risk, and prepare a Decision Packet for your review. The agent never
        approves spend or sends external messages on its own.
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={onRun}
        disabled={busy}
        style={{ marginTop: 12 }}
      >
        {busy ? 'Running…' : '▶ Run agent'}
      </button>
    </div>
  );
}
