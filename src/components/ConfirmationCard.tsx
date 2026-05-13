'use client';

import { useCallback, useEffect, useState } from 'react';
import type {
  DecisionPacket,
  HumanDecision,
  RiskTier,
  RequiredApprover,
} from '@/lib/agent/schemas';
import type { LensId } from '@/lib/personas';
import { LENSES } from '@/lib/personas';

const ALL_APPROVERS: RequiredApprover[] = [
  'business_owner',
  'procurement_manager',
  'vp_finance',
  'cfo',
  'executive_sponsor',
  'legal',
  'security',
];

const APPROVER_LABEL: Record<RequiredApprover, string> = {
  business_owner: 'Business Owner',
  procurement_manager: 'Procurement Manager',
  vp_finance: 'VP Finance',
  cfo: 'CFO',
  executive_sponsor: 'Executive Sponsor',
  legal: 'Legal',
  security: 'Security',
};

interface Props {
  packet: DecisionPacket;
  lens: LensId;
  busy: boolean;
  onSubmit: (decision: HumanDecision) => void;
}

type Verdict = HumanDecision['verdict'];

export function ConfirmationCard({ packet, lens, busy, onSubmit }: Props) {
  const operator = LENSES.find((l) => l.id === lens)?.is_operator;

  const [risk, setRisk] = useState<RiskTier>(packet.risk_tier);
  const [extraApprover, setExtraApprover] = useState<string>('');
  const [draft, setDraft] = useState<string>(
    stripMarkdownAsterisks(
      packet.draft_vendor_email?.body ?? packet.draft_internal_ticket
    )
  );
  const [copied, setCopied] = useState(false);

  if (packet.human_decision) {
    return <DecidedStamp decision={packet.human_decision} />;
  }

  if (!operator) {
    return (
      <div className="confirm" role="region" aria-label="Approver view">
        <div className="confirm-header">
          <ClockIcon />
          <div>
            <div className="confirm-title">Approver view</div>
            <div className="confirm-sub">
              This is the routed packet as <strong>{LENSES.find((l) => l.id === lens)?.label}</strong> would
              receive it. Approvers act in their own systems (Slack, Workday, email) once
              <strong> Procurement</strong> routes it. Switch to the Procurement lens to approve, edit, or reject here.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const submit = useCallback(
    (verdict: Verdict) => {
      // Compare against the asterisk-stripped baseline so a no-op render
      // (display normalization only) doesn't masquerade as an operator edit.
      const baselineDraft = stripMarkdownAsterisks(
        packet.draft_vendor_email?.body ?? packet.draft_internal_ticket
      );
      const edits =
        risk !== packet.risk_tier ||
        (extraApprover && !packet.required_approvers.includes(extraApprover as RequiredApprover)) ||
        draft !== baselineDraft
          ? {
              risk_tier: risk,
              extra_approver: extraApprover || null,
              draft_text: draft,
            }
          : null;

      onSubmit({
        verdict,
        notes: null,
        decided_at: new Date().toISOString(),
        decided_by: 'operator',
        edits_applied: edits,
      });
    },
    [risk, extraApprover, draft, packet, onSubmit]
  );

  useEffect(() => {
    if (!operator || busy || packet.human_decision) return;
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
      } else if (e.shiftKey && (e.key === 'R' || e.key === 'r')) {
        e.preventDefault();
        submit('edit_and_rerun');
      } else if (e.shiftKey && (e.key === 'X' || e.key === 'x')) {
        e.preventDefault();
        submit('rejected');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [operator, busy, packet.human_decision, submit]);

  return (
    <div className="confirm" role="region" aria-label="Additional approval required">
      <div className="confirm-header">
        <ClockIcon />
        <div>
          <div className="confirm-title">Additional approval required</div>
          <div className="confirm-sub">
            Review, edit, then choose an action. The agent will not act without you.
          </div>
        </div>
      </div>

      <div className="confirm-grid">
        <div>
          <div className="field-label">Risk tier</div>
          <select
            className="editable"
            value={risk}
            onChange={(e) => setRisk(e.target.value as RiskTier)}
            disabled={busy}
          >
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
          </select>
        </div>
        <div>
          <div className="field-label">Add an approver</div>
          <select
            className="editable"
            value={extraApprover}
            onChange={(e) => setExtraApprover(e.target.value)}
            disabled={busy}
          >
            <option value="">—</option>
            {ALL_APPROVERS.map((a) => {
              const alreadyRouted = packet.required_approvers.includes(a);
              return (
                <option key={a} value={a} disabled={alreadyRouted}>
                  {APPROVER_LABEL[a]}
                  {alreadyRouted ? ' (already routed)' : ''}
                </option>
              );
            })}
          </select>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div className="field-label">
          <span>Vendor follow-up</span>
          <span className="draft-tag">Draft · not sent</span>
        </div>
        <textarea
          className="editable"
          rows={6}
          aria-label="Vendor follow-up draft (not sent)"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          disabled={busy}
        />
      </div>

      <div className="confirm-actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => submit('approved')}
          disabled={busy}
        >
          <CheckIcon />
          Approve recommendation
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleCopy}
          disabled={busy}
        >
          <CopyIcon />
          {copied ? 'Copied' : 'Copy vendor draft'}
        </button>
        <button
          type="button"
          className="btn btn-warn"
          onClick={() => submit('edit_and_rerun')}
          disabled={busy}
        >
          <RefreshIcon />
          Edit &amp; re-run
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => submit('rejected')}
          disabled={busy}
        >
          <AlertIcon />
          Reject + escalate
        </button>
      </div>

      <div className="confirm-kbd-hints" aria-hidden="true">
        <kbd>Enter</kbd> approve · <kbd>⇧R</kbd> edit &amp; re-run · <kbd>⇧X</kbd> reject
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

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15.5-6.4L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15.5 6.4L3 16" />
      <path d="M3 21v-5h5" />
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

// Display-only normalization: the LLM occasionally emits Markdown emphasis
// (`*bold*`, `**bold**`) inside the vendor email body even though the prompt
// asks for plain prose. Operators copy this draft straight into Gmail/Outlook,
// where literal asterisks read as typos. Strip them on the way into the
// textarea, then compare-against-stripped on submit so a pure-normalization
// render doesn't get flagged as an operator edit.
function stripMarkdownAsterisks(text: string): string {
  return text.replace(/\*+/g, '');
}

function DecidedStamp({ decision }: { decision: HumanDecision }) {
  const when = new Date(decision.decided_at).toLocaleString();
  const verdictLabel: Record<Verdict, string> = {
    approved: 'Approved',
    rejected: 'Rejected & escalated',
    edit_and_rerun: 'Edit & re-run',
    request_followup: 'Follow-up requested',
  };
  return (
    <div className="decided-stamp">
      <strong>{verdictLabel[decision.verdict]}</strong> by {decision.decided_by} ·{' '}
      {when}
      {decision.notes ? <div className="case-meta">"{decision.notes}"</div> : null}
    </div>
  );
}
