'use client';

import { useEffect, useState } from 'react';
import type { PolicyCitation } from '@/lib/agent/schemas';

interface Props {
  citation: PolicyCitation | null;
  onClose: () => void;
}

export function PolicyDrawer({ citation, onClose }: Props) {
  const [text, setText] = useState<string>('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!citation) return;
    let cancelled = false;
    setLoading(true);
    setText('');
    fetch(`/api/policy/${citation.policy_doc}`)
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        setText(d.text ?? '');
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setText(`Failed to load ${citation.policy_doc}.md`);
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [citation]);

  useEffect(() => {
    if (!citation) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [citation, onClose]);

  if (!citation) return null;

  return (
    <div
      className="drawer-overlay"
      onClick={onClose}
      role="presentation"
    >
      <aside
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={`Policy: ${citation.policy_doc}`}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="drawer-header">
          <div>
            <div className="drawer-eyebrow">
              {citation.verified ? 'Verified citation' : 'UNVERIFIED citation'}
            </div>
            <div className="drawer-title">
              {citation.policy_doc.replace(/_/g, ' ')} § {citation.section}
            </div>
          </div>
          <button
            type="button"
            className="btn"
            onClick={onClose}
            aria-label="Close drawer"
          >
            Close
          </button>
        </header>

        <div className="drawer-quote">
          <div className="drawer-quote-label">Agent quoted:</div>
          <blockquote>{citation.quote}</blockquote>
          {!citation.verified && (
            <div className="drawer-quote-warn">
              This quote was not found verbatim in the cited policy doc. The
              agent loses authority to claim it; the operator should verify
              before relying on it.
            </div>
          )}
        </div>

        <div className="drawer-body">
          {loading ? (
            <div className="drawer-loading">Loading policy text…</div>
          ) : (
            <PolicyText text={text} highlight={citation.quote} />
          )}
        </div>
      </aside>
    </div>
  );
}

function PolicyText({ text, highlight }: { text: string; highlight: string }) {
  if (!highlight.trim()) return <pre className="policy-pre">{text}</pre>;
  const lc = text.toLowerCase();
  const idx = lc.indexOf(highlight.toLowerCase());
  if (idx === -1) return <pre className="policy-pre">{text}</pre>;
  const before = text.slice(0, idx);
  const match = text.slice(idx, idx + highlight.length);
  const after = text.slice(idx + highlight.length);
  return (
    <pre className="policy-pre">
      {before}
      <mark className="policy-highlight">{match}</mark>
      {after}
    </pre>
  );
}
