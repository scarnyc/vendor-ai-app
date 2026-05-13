'use client';

import type { DecisionPacket, PolicyCitation, PolicyFlag, RequiredApprover } from '@/lib/agent/schemas';
import { filterFlagsForLens, type LensId } from '@/lib/personas';
import { CitationChip } from './CitationChip';

interface Props {
  packet: DecisionPacket;
  lens: LensId;
  onCitationClick: (citation: PolicyCitation) => void;
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

export function DecisionPacketCard({ packet, lens, onCitationClick }: Props) {
  const visibleFlags = filterFlagsForLens(packet.policy_flags, lens);
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
        <Flags flags={visibleFlags} totalCount={packet.policy_flags.length} onCitationClick={onCitationClick} />
        <Approvers approvers={packet.required_approvers} />
        <Recommendation packet={packet} />
      </div>
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
  totalCount,
  onCitationClick,
}: {
  flags: PolicyFlag[];
  totalCount: number;
  onCitationClick: (c: PolicyCitation) => void;
}) {
  const filteredOut = totalCount - flags.length;
  return (
    <div>
      <div className="section-h">
        Policy flags · {flags.length}
        {filteredOut > 0 && (
          <span className="case-meta" style={{ fontWeight: 400, marginLeft: 8 }}>
            ({filteredOut} hidden by recipient lens)
          </span>
        )}
      </div>
      <div className="flag-list">
        {flags.length === 0 ? (
          <div className="case-meta">No flags routed to this recipient.</div>
        ) : (
          flags.map((flag, i) => (
            <FlagRow key={i} flag={flag} onCitationClick={onCitationClick} />
          ))
        )}
      </div>
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
      ? 'Recommended: Block — do not proceed without resolving blocking issues'
      : action === 'escalate'
        ? 'Recommended: Escalate to executive sponsor'
        : 'Recommended: Approve with follow-up';
  const sub =
    action === 'block'
      ? 'Multiple blocking policy violations; the package cannot be approved as submitted. Operator may reject + escalate or request follow-up to resolve.'
      : action === 'escalate'
        ? 'Risk pattern exceeds standard routing; escalate to executive sponsor with the audit trail attached.'
        : 'Request the listed missing items from the vendor before routing to the named approvers. Final approval is at your discretion.';

  return (
    <div className={cls}>
      <div className="recommended-text">
        <div className="recommended-title">{title}</div>
        <div className="recommended-sub">{sub}</div>
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
