'use client';

import { CASE_IDS, CASES, type CaseId } from '@/lib/cases';

interface Props {
  caseId: CaseId;
  onChange: (caseId: CaseId) => void;
}

export function CaseTabs({ caseId, onChange }: Props) {
  return (
    <nav className="case-tabs" aria-label="Cases">
      {CASE_IDS.map((id) => {
        const meta = CASES[id];
        const active = id === caseId;
        return (
          <button
            key={id}
            type="button"
            aria-current={active ? 'page' : undefined}
            className={`case-tab${active ? ' active' : ''}`}
            onClick={() => onChange(id)}
          >
            <span className="tab-id">{id}</span>
            <span>{meta.short_name}</span>
            <span className="tab-acv">{meta.acv_short}</span>
          </button>
        );
      })}
    </nav>
  );
}
