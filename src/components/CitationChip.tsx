'use client';

import type { PolicyCitation } from '@/lib/agent/schemas';

interface Props {
  citation: PolicyCitation;
  onOpen: (citation: PolicyCitation) => void;
}

export function CitationChip({ citation, onOpen }: Props) {
  const cls = `citation${citation.verified ? '' : ' unverified'}`;
  const label = `${citation.policy_doc.replace(/_/g, ' ')} § ${citation.section}`;
  const title = citation.verified
    ? `Verified quote: "${citation.quote}"`
    : `UNVERIFIED — agent quote not found verbatim in ${citation.policy_doc}.md. Click to inspect.`;
  return (
    <button
      type="button"
      className={cls}
      title={title}
      onClick={() => onOpen(citation)}
    >
      {label}
    </button>
  );
}
