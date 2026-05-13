'use client';

import { useState } from 'react';
import type { CaseId } from '@/lib/cases';
import { CASE_IDS } from '@/lib/cases';

interface Props {
  onRunCase: (caseId: CaseId) => void;
}

export function AmbientPromptPill({ onRunCase }: Props) {
  const [value, setValue] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = value.trim();
    const match = trimmed.match(/^\/run\s+(case_\d{3})$/);
    if (match) {
      const id = match[1];
      if ((CASE_IDS as readonly string[]).includes(id)) {
        onRunCase(id as CaseId);
        setValue('');
        return;
      }
    }
    setValue('');
  };

  return (
    <footer className="pill-dock">
      <form className="pill" onSubmit={handleSubmit}>
        <span aria-hidden style={{ fontSize: 16, color: 'var(--text-mute)' }}>
          ⌕
        </span>
        <input
          type="text"
          placeholder="Ask anything · /run case_002 · /explain SOC 2 II requirement · /show audit"
          aria-label="Ambient prompt"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
        <button className="pill-btn" type="submit" aria-label="Send">
          →
        </button>
      </form>
      <div className="pill-hint">
        <span>/run case_001</span>
        <span>/run case_002</span>
        <span>/run case_003</span>
        <span>/explain &lt;flag&gt;</span>
        <span>/show audit</span>
      </div>
    </footer>
  );
}
