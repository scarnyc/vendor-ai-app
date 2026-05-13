'use client';

import { useCallback, useEffect } from 'react';
import type { DecisionPacket, HumanDecision } from '@/lib/agent/schemas';

interface Props {
  packet: DecisionPacket;
  busy: boolean;
  onSubmit: (decision: HumanDecision) => void;
}

type Verdict = HumanDecision['verdict'];

const VERDICT_LABEL: Record<Verdict, string> = {
  approved: 'Approved',
  rejected: 'Rejected — vendor must resubmit',
  escalated: 'Escalated to CFO',
};

const BUTTON_TITLE: Record<Verdict, string> = {
  approved:
    'Vendor submitted everything; no flags or executive approval needed.',
  rejected: 'Vendor needs to resubmit required paperwork.',
  escalated: 'Route to CFO for executive approval.',
};

export function ConfirmationCard({ packet, busy, onSubmit }: Props) {
  const submit = useCallback(
    (verdict: Verdict) => {
      onSubmit({
        verdict,
        notes: null,
        decided_at: new Date().toISOString(),
        decided_by: 'operator',
        // T1.4 — Edit affordance deferred to PRODUCTIONIZATION.md; the
        // operator commits the agent's pre-filled packet as-is for now.
        edits_applied: null,
      });
    },
    [onSubmit, packet]
  );

  useEffect(() => {
    if (busy || packet.human_decision) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        submit('approved');
      } else if (e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        e.preventDefault();
        submit('rejected');
      } else if (e.shiftKey && (e.key === 'E' || e.key === 'e')) {
        e.preventDefault();
        submit('escalated');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, packet.human_decision, submit]);

  if (packet.human_decision) {
    return <DecidedStamp decision={packet.human_decision} />;
  }

  return (
    <div className="confirm" role="region" aria-label="Operator decision required">
      <div className="confirm-header">
        <ClockIcon />
        <div>
          <div className="confirm-title">Operator decision</div>
          <div className="confirm-sub">
            The agent has pre-filled the packet above. Choose an action — the agent will not act without you.
          </div>
        </div>
      </div>

      <div className="confirm-actions">
        <button
          type="button"
          className="btn btn-approve"
          onClick={() => submit('approved')}
          disabled={busy}
          title={BUTTON_TITLE.approved}
        >
          <CheckIcon />
          Approve
        </button>
        <button
          type="button"
          className="btn btn-reject"
          onClick={() => submit('rejected')}
          disabled={busy}
          title={BUTTON_TITLE.rejected}
        >
          <AlertIcon />
          Reject
        </button>
        <button
          type="button"
          className="btn btn-escalate"
          onClick={() => submit('escalated')}
          disabled={busy}
          title={BUTTON_TITLE.escalated}
        >
          <ArrowUpIcon />
          Escalate
        </button>
      </div>

      <div className="confirm-kbd-hints" aria-hidden="true">
        <kbd>Enter</kbd> approve · <kbd>⇧X</kbd> reject · <kbd>⇧E</kbd> escalate
      </div>

      <div className="confirm-legend">
        <div><strong>Approve</strong> — vendor submitted everything; no flags, no executive approval needed.</div>
        <div><strong>Reject</strong> — vendor needs to resubmit required paperwork.</div>
        <div><strong>Escalate</strong> — CFO approval is needed.</div>
      </div>
    </div>
  );
}

function ClockIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="var(--accent)"
      strokeWidth="1.8"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 8v5l3 2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="m5 13 4 4L19 7" />
    </svg>
  );
}

function AlertIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
      <path d="M10.3 3.7 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0Z" />
    </svg>
  );
}

function ArrowUpIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 19V5" />
      <path d="m5 12 7-7 7 7" />
    </svg>
  );
}

function DecidedStamp({ decision }: { decision: HumanDecision }) {
  const when = new Date(decision.decided_at).toLocaleString();
  return (
    <div className="decided-stamp">
      <strong>{VERDICT_LABEL[decision.verdict]}</strong> by {decision.decided_by} ·{' '}
      {when}
      {decision.notes ? <div className="case-meta">"{decision.notes}"</div> : null}
    </div>
  );
}
