'use client';

import { useState } from 'react';
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
    packet.draft_vendor_email?.body ?? packet.draft_internal_ticket
  );
  const [notes, setNotes] = useState<string>('');
  const [copied, setCopied] = useState(false);

  if (packet.human_decision) {
    return <DecidedStamp decision={packet.human_decision} />;
  }

  if (!operator) {
    return (
      <div className="confirm" role="region" aria-label="Recipient preview">
        <div className="confirm-header">
          <div>
            <div className="confirm-title">Preview only</div>
            <div className="confirm-sub">
              Recipients see the routed packet, but cannot act on it. Switch to
              the <strong>Procurement</strong> lens to approve, edit, or reject.
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

  const submit = (verdict: Verdict) => {
    const edits =
      risk !== packet.risk_tier ||
      (extraApprover && !packet.required_approvers.includes(extraApprover as RequiredApprover)) ||
      draft !==
        (packet.draft_vendor_email?.body ?? packet.draft_internal_ticket)
        ? {
            risk_tier: risk,
            extra_approver: extraApprover || null,
            draft_text: draft,
          }
        : null;

    onSubmit({
      verdict,
      notes: notes.trim() ? notes.trim() : null,
      decided_at: new Date().toISOString(),
      decided_by: 'operator',
      edits_applied: edits,
    });
  };

  return (
    <div className="confirm" role="region" aria-label="Additional approval required">
      <div className="confirm-header">
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
            {ALL_APPROVERS.filter(
              (a) => !packet.required_approvers.includes(a)
            ).map((a) => (
              <option key={a} value={a}>
                {APPROVER_LABEL[a]}
              </option>
            ))}
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

      <div style={{ marginTop: 12 }}>
        <div className="field-label">Notes (optional)</div>
        <textarea
          className="editable"
          rows={2}
          placeholder="Why approve / re-run / reject? Captured in the audit trail."
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
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
          ✓ Approve recommendation
        </button>
        <button
          type="button"
          className="btn"
          onClick={handleCopy}
          disabled={busy}
        >
          {copied ? '✓ Copied' : '⧉ Copy draft'}
        </button>
        <button
          type="button"
          className="btn btn-warn"
          onClick={() => submit('edit_and_rerun')}
          disabled={busy}
        >
          ↻ Edit &amp; re-run
        </button>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => submit('rejected')}
          disabled={busy}
        >
          ⚠ Reject + escalate
        </button>
      </div>
    </div>
  );
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
