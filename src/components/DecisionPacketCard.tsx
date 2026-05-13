'use client';

import type { DecisionPacket, PolicyCitation, PolicyFlag, RequiredApprover } from '@/lib/agent/schemas';
import { CitationChip } from './CitationChip';

interface Props {
  packet: DecisionPacket;
  onCitationClick: (citation: PolicyCitation) => void;
  children?: React.ReactNode;
}

const APPROVER_LABEL: Record<RequiredApprover, string> = {
  business_owner: 'Business Owner',
  procurement_manager: 'Procurement Manager',
  vp_finance: 'VP Finance',
  cfo: 'CFO',
  executive_sponsor: 'Executive Sponsor',
  legal: 'Legal',
  security: 'Security',
};

export function DecisionPacketCard({ packet, onCitationClick, children }: Props) {
  const riskLabel = packet.risk_tier.charAt(0).toUpperCase() + packet.risk_tier.slice(1);
  const dataLabel = packet.data_class.charAt(0).toUpperCase() + packet.data_class.slice(1);

  return (
    <section className="packet" aria-label="Decision Packet">
      <div className="packet-header">
        <div>
          <div className="packet-title">Decision Packet</div>
          <div className="packet-tagline">
            Pre-filled by agent · pending operator review
          </div>
        </div>
        <div className="header-spacer" />
        <span className={`badge ${riskBadgeClass(packet.risk_tier)}`}>
          Risk: {riskLabel}
        </span>
        <span className="badge b-info">Data: {dataLabel}</span>
      </div>

      <div className="packet-body">
        <Stats packet={packet} />
        <IntakeSummary text={packet.intake_summary} />
        <Flags flags={packet.policy_flags} onCitationClick={onCitationClick} />
        <Approvers approvers={packet.required_approvers} />
        <Recommendation packet={packet} />
      </div>

      {children}
    </section>
  );
}

function riskBadgeClass(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'high') return 'b-danger';
  if (risk === 'medium') return 'b-warn';
  return 'b-success';
}

function Stats({ packet }: { packet: DecisionPacket }) {
  const acv = formatUsd(packet.tcv.acv_usd);
  const tcv = formatUsd(packet.tcv.tcv_usd);
  const headroom = packet.budget.headroom_after_contract;
  const headroomDisplay =
    headroom === null ? '—' : formatUsd(headroom);
  const oneTime = packet.tcv.one_time_usd
    ? `+ ${formatUsd(packet.tcv.one_time_usd)} one-time`
    : 'No one-time fee';
  const ownerLine = packet.budget.budget_owner
    ? `${packet.budget.cost_center} · ${packet.budget.budget_owner}`
    : packet.budget.cost_center;

  return (
    <div className="grid-3">
      <div className="stat">
        <div className="stat-label">Annual Contract Value</div>
        <div className="stat-value">{acv}</div>
        <div className="stat-sub">{oneTime}</div>
      </div>
      <div className="stat">
        <div className="stat-label">Total Contract Value</div>
        <div className="stat-value">{tcv}</div>
        <div className="stat-sub">{packet.tcv.term_months}-month term</div>
      </div>
      <div className="stat">
        <div className="stat-label">Budget Headroom</div>
        <div className="stat-value">{headroomDisplay}</div>
        <div className="stat-sub">{ownerLine}</div>
      </div>
    </div>
  );
}

function IntakeSummary({ text }: { text: string }) {
  return (
    <div>
      <div className="section-h">Intake summary</div>
      <p className="intake-summary">{text}</p>
    </div>
  );
}

function Flags({
  flags,
  onCitationClick,
}: {
  flags: PolicyFlag[];
  onCitationClick: (c: PolicyCitation) => void;
}) {
  // T1.7: Partition by severity so the operator can read at a glance which
  // flags are blockers (escalate path) vs follow-ups (pending vendor reply).
  // Info-severity flags stay collapsed — they don't change routing.
  const blocks = flags.filter((f) => f.severity === 'block');
  const followups = flags.filter((f) => f.severity === 'warn');
  const info = flags.filter((f) => f.severity === 'info');

  if (flags.length === 0) {
    return (
      <div>
        <div className="section-h">Policy flags · 0</div>
        <div className="case-meta">No policy flags raised by the agent.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="section-h">Policy flags · {flags.length}</div>

      {blocks.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <div className="flags-subhead flags-subhead-blocks">
            Blocking issues (escalate path) · {blocks.length}
          </div>
          <div className="flag-list">
            {blocks.map((flag, i) => (
              <FlagRow key={`block-${i}`} flag={flag} onCitationClick={onCitationClick} />
            ))}
          </div>
        </div>
      )}

      {followups.length > 0 && (
        <div style={{ marginBottom: info.length > 0 ? 12 : 0 }}>
          <div className="flags-subhead flags-subhead-followups">
            Vendor follow-ups (pending paperwork) · {followups.length}
          </div>
          <div className="flag-list">
            {followups.map((flag, i) => (
              <FlagRow key={`warn-${i}`} flag={flag} onCitationClick={onCitationClick} />
            ))}
          </div>
        </div>
      )}

      {info.length > 0 && (
        <details className="flags-info-details">
          <summary>Informational · {info.length}</summary>
          <div className="flag-list">
            {info.map((flag, i) => (
              <FlagRow key={`info-${i}`} flag={flag} onCitationClick={onCitationClick} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

function FlagRow({
  flag,
  onCitationClick,
}: {
  flag: PolicyFlag;
  onCitationClick: (c: PolicyCitation) => void;
}) {
  const cls = `flag f-${flag.severity}`;
  const recipientLabel = APPROVER_LABEL[flag.recipient] ?? flag.recipient;
  return (
    <div className={cls}>
      <div className="flag-bar" />
      <div className="flag-body">
        <div className="flag-recipient">→ {recipientLabel}</div>
        <div className="flag-issue">{flag.issue}</div>
        <div className="flag-citations">
          {flag.citations.map((c, i) => (
            <CitationChip key={i} citation={c} onOpen={onCitationClick} />
          ))}
        </div>
      </div>
    </div>
  );
}

function Approvers({ approvers }: { approvers: RequiredApprover[] }) {
  return (
    <div>
      <div className="section-h">Required approvers</div>
      <div className="approver-list">
        {approvers.length === 0 ? (
          <span className="case-meta">No additional approvers required.</span>
        ) : (
          approvers.map((a) => (
            <span key={a} className="badge">
              {APPROVER_LABEL[a]}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function Recommendation({ packet }: { packet: DecisionPacket }) {
  const action = packet.recommended_action;
  const cls =
    action === 'block'
      ? 'recommended r-block'
      : action === 'escalate'
        ? 'recommended r-escalate'
        : 'recommended';
  const title =
    action === 'block'
      ? 'Reject — red flags; vendor must resubmit.'
      : action === 'escalate'
        ? 'Escalate — CEO approval required'
        : 'Pending Follow-up — vendor paperwork pending.';
  // T1.1: The approve_with_followup branch returns null because its old
  // "Request the listed missing items..." subtitle contradicted the
  // deterministic doc-inventory check directly above it.
  const sub =
    action === 'block'
      ? 'Multiple blocking policy violations; the package cannot proceed as submitted. Operator may reject or escalate to resolve.'
      : action === 'escalate'
        ? 'Risk pattern exceeds standard routing; escalate to CEO with the audit trail attached.'
        : null;

  return (
    <div className={cls}>
      <svg
        className="ic"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        aria-hidden="true"
      >
        <path d="M12 2v4M12 18v4M4 12H2M22 12h-2M5.6 5.6l-1.4-1.4M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4" />
      </svg>
      <div className="recommended-text">
        <div className="recommended-title">{title}</div>
        {sub && <div className="recommended-sub">{sub}</div>}
      </div>
    </div>
  );
}

function formatUsd(n: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(n);
}
