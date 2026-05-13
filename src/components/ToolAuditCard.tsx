'use client';

import type {
  DecisionPacket,
  PolicyCitation,
  PolicyDoc,
  PolicyFlag,
  ToolCallRecord,
} from '@/lib/agent/schemas';

interface Props {
  record: ToolCallRecord;
  packet: DecisionPacket | null;
  defaultOpen?: boolean;
  onCitationClick?: (citation: PolicyCitation) => void;
}

interface DisplayRow {
  label: string;
  value: React.ReactNode;
  emphasis?: 'ok' | 'warn' | 'block';
}

export function ToolAuditCard({ record, packet, defaultOpen = false, onCitationClick }: Props) {
  const seconds = (record.duration_ms / 1000).toFixed(2);
  const rows = buildRows(record, packet);
  const cited = packet ? citedByFor(record.tool_name, packet.policy_flags) : [];

  return (
    <details className="audit tool-audit" open={defaultOpen}>
      <summary>
        <span className="audit-title">{record.display_label}</span>
        <span className="audit-meta">
          {humanizeToolName(record.tool_name)} · {seconds}s
        </span>
      </summary>
      <div className="audit-body">
        <dl className="audit-dl">
          {rows.map((r, i) => (
            <Row key={i} row={r} />
          ))}
        </dl>
        {cited.length > 0 && (
          <div className="audit-footer">
            <span className="footer-label">Cited by →</span>
            {cited.map((c, i) => (
              <button
                key={i}
                type="button"
                className="citation citation-button"
                onClick={() => onCitationClick?.(c.citation)}
                title={`${c.citation.policy_doc.replace(/_/g, ' ')} § ${c.citation.section}`}
              >
                {c.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </details>
  );
}

function Row({ row }: { row: DisplayRow }) {
  const className = row.emphasis === 'ok'
    ? 'ok'
    : row.emphasis === 'warn'
      ? 'warn'
      : row.emphasis === 'block'
        ? 'block'
        : undefined;
  return (
    <>
      <dt>{row.label}</dt>
      <dd>{className ? <span className={className}>{row.value}</span> : row.value}</dd>
    </>
  );
}

/* ─── Curated row builders ─────────────────────────────────────────────── */

function buildRows(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  switch (record.tool_name) {
    case 'validate_required_documents':
      return rowsForValidateDocs(record, packet);
    case 'lookup_budget':
      return rowsForLookupBudget(record, packet);
    case 'check_existing_vendor':
      return rowsForExistingVendor(record, packet);
    case 'calculate_total_contract_value':
      return rowsForTcv(record, packet);
    case 'classify_data_sensitivity':
      return rowsForDataSensitivity(record, packet);
    case 'determine_required_approvals':
      return rowsForApprovals(record, packet);
    case 'validate_citations':
      return rowsForValidateCitations(record);
    case 'draft_vendor_followup':
      return rowsForDraftFollowup(record);
    case 'escalate_to_human':
      return rowsForEscalate(record);
    case 'read_policy':
      return rowsForReadPolicy(record);
    default:
      return rowsFallback(record);
  }
}

function rowsForValidateDocs(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const present = asArray(record.result_summary.present);
  const missing = asArray(record.result_summary.missing);
  const verdict = missing.length === 0
    ? {
        text:
          'All required case-folder documents present (intake form, vendor email, quote, security questionnaire, contract).',
        emphasis: 'ok' as const,
      }
    : missing.length <= 2
      ? { text: `${missing.length} missing — non-blocking`, emphasis: 'warn' as const }
      : { text: `${missing.length} missing — package incomplete`, emphasis: 'block' as const };
  return [
    { label: 'Documents present', value: present.length > 0 ? present.map(humanizeDocName).join(' · ') : '—' },
    { label: 'Missing', value: missing.length > 0 ? missing.join(' · ') : '—' },
    { label: 'Verdict', value: verdict.text, emphasis: verdict.emphasis },
  ];
}

function rowsForLookupBudget(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const b = packet?.budget;
  const acv = asNumber(record.args_summary.acv);
  if (!b) {
    return rowsFallback(record);
  }
  const costCenterValue = b.department
    ? <>{b.department} <span className="mono">({b.cost_center})</span></>
    : <span className="mono">{b.cost_center}</span>;
  const verdict: DisplayRow = !b.found
    ? { label: 'Verdict', value: 'Cost center not found', emphasis: 'block' }
    : b.sufficient_for_contract === false
      ? { label: 'Verdict', value: 'Insufficient budget', emphasis: 'block' }
      : { label: 'Verdict', value: 'Within budget', emphasis: 'ok' };
  return [
    { label: 'Cost center', value: costCenterValue },
    { label: 'Annual budget remaining', value: <span className="mono">{formatMoney(b.annual_budget_remaining)}</span> },
    { label: 'Owner', value: b.budget_owner ?? '—' },
    {
      label: 'Headroom after this contract',
      value: <span className="mono">{formatMoney(b.headroom_after_contract)}</span>,
    },
    { label: 'Contract ACV', value: <span className="mono">{formatMoney(acv)}</span> },
    verdict,
  ];
}

function rowsForExistingVendor(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const dup = packet?.duplicate_vendor;
  const searched = asString(record.args_summary.vendor_name);
  if (!dup) return rowsFallback(record);
  const matchValue = dup.matched_vendor
    ? <>{dup.matched_vendor.vendor_name} <span className="mono">({dup.matched_vendor.vendor_id})</span></>
    : 'No match';
  const confidenceValue = dup.match_type === 'exact'
    ? `Exact (${dup.confidence.toFixed(2)})`
    : dup.match_type === 'fuzzy'
      ? `Fuzzy (${dup.confidence.toFixed(2)})`
      : 'None';
  const statusValue = dup.matched_vendor
    ? `${capitalize(dup.matched_vendor.status)} · category ${dup.matched_vendor.category}`
    : '—';
  const verdict: DisplayRow = dup.match_type === 'none'
    ? { label: 'Verdict', value: 'Net new vendor — full onboarding required' }
    : dup.matched_vendor?.status === 'inactive'
      ? { label: 'Verdict', value: 'Inactive vendor — reactivation review', emphasis: 'warn' }
      : { label: 'Verdict', value: 'Existing vendor — renewal path', emphasis: 'ok' };
  return [
    { label: 'Searched name', value: searched || '—' },
    { label: 'Match', value: matchValue },
    { label: 'Match confidence', value: confidenceValue },
    { label: 'Status', value: statusValue },
    verdict,
  ];
}

function rowsForTcv(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const t = packet?.tcv;
  if (!t) return rowsFallback(record);
  const tier = t.tcv_usd >= 100_000
    ? { text: 'CFO + Executive sponsor approval threshold', emphasis: 'warn' as const }
    : t.tcv_usd >= 50_000
      ? { text: 'VP Finance approval threshold', emphasis: 'warn' as const }
      : { text: 'Below executive approval threshold', emphasis: 'ok' as const };
  return [
    { label: 'Annual contract value', value: <span className="mono">{formatMoney(t.acv_usd)}</span> },
    { label: 'Term', value: <span className="mono">{t.term_months} months</span> },
    { label: 'One-time fees', value: <span className="mono">{formatMoney(t.one_time_usd)}</span> },
    { label: 'Formula', value: <span className="mono">{t.formula}</span> },
    { label: 'Total contract value', value: <span className="mono">{formatMoney(t.tcv_usd)}</span> },
    { label: 'Verdict', value: tier.text, emphasis: tier.emphasis },
  ];
}

function rowsForDataSensitivity(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const dataClass = packet?.data_class;
  const signalCount = asNumber(record.result_summary.signal_count);
  if (!dataClass) return rowsFallback(record);
  const verdict = dataClass === 'restricted'
    ? { text: 'Triggers Security & Legal review', emphasis: 'block' as const }
    : dataClass === 'confidential'
      ? { text: 'Triggers Security & Legal review', emphasis: 'warn' as const }
      : dataClass === 'internal'
        ? { text: 'Standard internal handling', emphasis: 'ok' as const }
        : { text: 'Public — no special handling', emphasis: 'ok' as const };
  return [
    { label: 'Class', value: capitalize(dataClass) },
    { label: 'Signal count', value: signalCount > 0 ? `${signalCount} signal${signalCount === 1 ? '' : 's'} detected` : 'No sensitivity signals detected' },
    { label: 'Verdict', value: verdict.text, emphasis: verdict.emphasis },
  ];
}

function rowsForApprovals(record: ToolCallRecord, packet: DecisionPacket | null): DisplayRow[] {
  const approvers = packet?.required_approvers ?? asArray(record.result_summary.approvers);
  if (approvers.length === 0) return rowsFallback(record);
  return [
    { label: 'Approvers required', value: approvers.map(humanizeRecipient).join(' · ') },
    { label: 'Count', value: <span className="mono">{approvers.length}</span> },
    {
      label: 'Verdict',
      value: approvers.length >= 3 ? 'Multi-stakeholder routing' : 'Standard routing',
      emphasis: approvers.length >= 3 ? 'warn' : 'ok',
    },
  ];
}

function rowsForValidateCitations(record: ToolCallRecord): DisplayRow[] {
  const checked = asNumber(record.args_summary.citation_count);
  const unverified = asNumber(record.result_summary.unverified_count);
  const verified = checked - unverified;
  const verdict: DisplayRow = unverified === 0
    ? { label: 'Verdict', value: 'All citations verified verbatim', emphasis: 'ok' }
    : { label: 'Verdict', value: `${unverified} citation${unverified === 1 ? '' : 's'} unverified — demoted to warn`, emphasis: 'warn' };
  return [
    { label: 'Citations checked', value: <span className="mono">{checked}</span> },
    { label: 'Verified', value: <span className="mono">{verified}</span> },
    { label: 'Unverified', value: <span className="mono">{unverified}</span> },
    verdict,
  ];
}

function rowsForDraftFollowup(record: ToolCallRecord): DisplayRow[] {
  const subject = asString(record.result_summary.subject);
  const lineCount = asNumber(record.result_summary.body_line_count);
  return [
    { label: 'Subject', value: subject || '—' },
    { label: 'Body lines', value: <span className="mono">{lineCount}</span> },
    { label: 'Status', value: 'DRAFT — awaiting operator copy', emphasis: 'warn' },
  ];
}

function rowsForEscalate(record: ToolCallRecord): DisplayRow[] {
  return [
    { label: 'Reason', value: asString(record.args_summary.reason) || '—' },
    { label: 'Routed to', value: asArray(record.args_summary.routed_to).map(humanizeRecipient).join(' · ') || '—' },
    { label: 'Severity', value: asString(record.args_summary.severity) || '—' },
  ];
}

function rowsForReadPolicy(record: ToolCallRecord): DisplayRow[] {
  return [
    { label: 'Policy', value: humanizePolicyDoc(asString(record.args_summary.policy_doc) as PolicyDoc) },
    { label: 'Section', value: asString(record.args_summary.section) || '—' },
    { label: 'Bytes returned', value: <span className="mono">{asNumber(record.result_summary.bytes)}</span> },
  ];
}

function rowsFallback(record: ToolCallRecord): DisplayRow[] {
  return [
    ...Object.entries(record.args_summary).map(([k, v]) => ({
      label: humanizeKey(k),
      value: formatGeneric(v),
    })),
    ...Object.entries(record.result_summary).map(([k, v]) => ({
      label: humanizeKey(k),
      value: formatGeneric(v),
    })),
  ];
}

/* ─── Cited-by mapping ─────────────────────────────────────────────────── */

const CITED_BY_DOCS: Record<string, PolicyDoc[]> = {
  validate_required_documents: ['procurement_policy'],
  lookup_budget: ['finance_approval_matrix'],
  check_existing_vendor: ['procurement_policy', 'vendor_risk_policy'],
  calculate_total_contract_value: ['finance_approval_matrix'],
  classify_data_sensitivity: [
    'data_handling_policy',
    'security_review_policy',
    'legal_review_policy',
  ],
  determine_required_approvals: ['procurement_policy', 'finance_approval_matrix'],
  draft_vendor_followup: ['communication_policy'],
  escalate_to_human: ['procurement_policy'],
  read_policy: [],
  validate_citations: [],
};

function citedByFor(
  toolName: string,
  flags: PolicyFlag[]
): Array<{ label: string; citation: PolicyCitation }> {
  const docs = new Set<PolicyDoc>(CITED_BY_DOCS[toolName] ?? []);
  if (docs.size === 0) return [];
  const seen = new Set<string>();
  const out: Array<{ label: string; citation: PolicyCitation }> = [];
  for (const flag of flags) {
    const matchingCitation = flag.citations.find((c) => docs.has(c.policy_doc));
    if (!matchingCitation) continue;
    const recipient = humanizePolicyArea(matchingCitation.policy_doc);
    const issue = shortenIssue(flag.issue);
    const label = `${recipient}: ${issue}`;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, citation: matchingCitation });
    if (out.length >= 3) break;
  }
  return out;
}

/* ─── Formatting helpers ───────────────────────────────────────────────── */

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v);
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x));
  return [];
}

function formatMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `$${Math.round(v).toLocaleString()}`;
}

function formatGeneric(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="mono">—</span>;
  if (typeof v === 'boolean') return <span className={v ? 'ok' : 'mono'}>{v ? 'Yes' : 'No'}</span>;
  if (typeof v === 'number') return <span className="mono">{Number.isInteger(v) ? v.toString() : v.toFixed(2)}</span>;
  if (typeof v === 'string') return <span>{v}</span>;
  if (Array.isArray(v)) return <span>{v.map((x) => String(x)).join(', ') || '—'}</span>;
  return <span className="mono">{JSON.stringify(v)}</span>;
}

function humanizeKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeToolName(name: string): string {
  const map: Record<string, string> = {
    validate_required_documents: 'Document validator',
    lookup_budget: 'Finance system',
    check_existing_vendor: 'Vendor register',
    calculate_total_contract_value: 'Finance calculator',
    classify_data_sensitivity: 'Policy-driven',
    determine_required_approvals: 'Approvals matrix',
    draft_vendor_followup: 'Drafting (LLM)',
    escalate_to_human: 'Escalation queue',
    read_policy: 'Policy reader',
    validate_citations: 'Citation verifier',
  };
  return map[name] ?? name;
}

function humanizeRecipient(r: string): string {
  const map: Record<string, string> = {
    business_owner: 'Business owner',
    procurement_manager: 'Procurement manager',
    vp_finance: 'VP Finance',
    cfo: 'CFO',
    executive_sponsor: 'Executive sponsor',
    legal: 'Legal',
    security: 'Security',
  };
  return map[r] ?? r;
}

function humanizePolicyArea(doc: PolicyDoc): string {
  const map: Record<PolicyDoc, string> = {
    procurement_policy: 'Procurement',
    vendor_risk_policy: 'Vendor risk',
    finance_approval_matrix: 'Finance',
    legal_review_policy: 'Legal',
    security_review_policy: 'Security',
    data_handling_policy: 'Data handling',
    communication_policy: 'Comms',
  };
  return map[doc];
}

function humanizePolicyDoc(doc: PolicyDoc | string): string {
  if (typeof doc !== 'string') return '—';
  return doc.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function humanizeDocName(name: string): string {
  const map: Record<string, string> = {
    intake_xlsx: 'Intake form',
    vendor_email_txt: 'Vendor email',
    quote_csv: 'Quote',
    security_questionnaire_md: 'Security questionnaire',
    contract_pdf: 'Contract',
  };
  return map[name] ?? humanizeKey(name);
}

function shortenIssue(s: string, maxLen = 80): string {
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut) + '…';
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0].toUpperCase() + s.slice(1);
}
