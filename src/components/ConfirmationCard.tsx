'use client';

import { useCallback, useEffect } from 'react';
import type { DecisionPacket, HumanDecision } from '@/lib/agent/schemas';

interface Props {
  packet: DecisionPacket;
  busy: boolean;
  onSubmit: (decision: HumanDecision) => void;
}

type Verdict = 'approved' | 'rejected' | 'escalated' | 'follow_up';

const VERDICT_LABEL: Record<Verdict, string> = {
  approved: 'Approve',
  rejected: 'Reject',
  escalated: 'Escalate',
  follow_up: 'Pending Follow-up',
};

const BUTTON_TITLE: Record<Verdict, string> = {
  approved: 'Vendor submitted everything; no flags',
  rejected: 'Red flags; vendor must resubmit required paperwork',
  escalated: 'Route to CEO for executive approval',
  follow_up: 'Pending — vendor must submit additional paperwork',
};

const RECOMMENDED_ACTION_TO_VERDICT: Record<string, Verdict | undefined> = {
  approve: 'approved',
  approve_with_followup: 'follow_up',
  escalate: 'escalated',
  block: 'rejected',
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
      } else if (e.shiftKey && (e.key === 'F' || e.key === 'f')) {
        e.preventDefault();
        submit('follow_up');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, packet.human_decision, submit]);

  if (packet.human_decision) {
    return <DecidedStamp decision={packet.human_decision} />;
  }

  const recommendedVerdict = packet.recommended_action
    ? RECOMMENDED_ACTION_TO_VERDICT[packet.recommended_action]
    : undefined;

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
          className={`btn btn-approve${recommendedVerdict === 'approved' ? ' btn-recommended' : ''}`}
          onClick={() => submit('approved')}
          disabled={busy}
          title={BUTTON_TITLE.approved}
          aria-label={recommendedVerdict === 'approved' ? 'Approve (recommended by agent)' : 'Approve'}
        >
          <CheckIcon />
          Approve
        </button>
        <button
          type="button"
          className={`btn btn-follow-up${recommendedVerdict === 'follow_up' ? ' btn-recommended' : ''}`}
          onClick={() => submit('follow_up')}
          disabled={busy}
          title={BUTTON_TITLE.follow_up}
          aria-label={recommendedVerdict === 'follow_up' ? 'Pending Follow-up (recommended by agent)' : 'Pending Follow-up'}
        >
          Pending Follow-up
        </button>
        <button
          type="button"
          className={`btn btn-escalate${recommendedVerdict === 'escalated' ? ' btn-recommended' : ''}`}
          onClick={() => submit('escalated')}
          disabled={busy}
          title={BUTTON_TITLE.escalated}
          aria-label={recommendedVerdict === 'escalated' ? 'Escalate (recommended by agent)' : 'Escalate'}
        >
          <ArrowUpIcon />
          Escalate
        </button>
        <button
          type="button"
          className={`btn btn-reject${recommendedVerdict === 'rejected' ? ' btn-recommended' : ''}`}
          onClick={() => submit('rejected')}
          disabled={busy}
          title={BUTTON_TITLE.rejected}
          aria-label={recommendedVerdict === 'rejected' ? 'Reject (recommended by agent)' : 'Reject'}
        >
          <AlertIcon />
          Reject
        </button>
      </div>

      <div className="confirm-kbd-hints" aria-hidden="true">
        <kbd>Enter</kbd> approve · <kbd>⇧F</kbd> follow-up · <kbd>⇧E</kbd> escalate · <kbd>⇧X</kbd> reject
      </div>

      <div className="confirm-legend">
        <div><strong>Approve</strong> — vendor submitted everything; no flags.</div>
        <div><strong>Pending Follow-up</strong> — vendor must submit additional paperwork.</div>
        <div><strong>Escalate</strong> — CEO approval is needed.</div>
        <div><strong>Reject</strong> — red flags; vendor must resubmit required paperwork.</div>
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
  const stampLabel =
    decision.verdict === 'follow_up'
      ? 'Pending — follow-up sent'
      : VERDICT_LABEL[decision.verdict as Verdict];
  return (
    <div className="decided-stamp">
      <strong>{stampLabel}</strong> by {decision.decided_by} ·{' '}
      {when}
      {decision.notes ? <div className="case-meta">"{decision.notes}"</div> : null}
    </div>
  );
}
