'use client';

import { CASE_IDS, CASES, type CaseId } from '@/lib/cases';

interface Props {
  caseId: CaseId;
  onChange: (caseId: CaseId) => void;
}

export function CaseTabs({ caseId, onChange }: Props) {
  return (
    <div className="case-tabs" role="tablist" aria-label="Case selector">
      {CASE_IDS.map((id) => {
        const meta = CASES[id];
        const active = id === caseId;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            aria-current={active ? 'true' : undefined}
            className={`case-tab${active ? ' active' : ''}`}
            onClick={() => onChange(id)}
          >
            <span className="case-tab-id">{id}</span>
            <span className="case-tab-name">{meta.vendor_name}</span>
          </button>
        );
      })}
    </div>
  );
}
