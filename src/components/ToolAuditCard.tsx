'use client';

import type { ToolCallRecord } from '@/lib/agent/schemas';

interface Props {
  record: ToolCallRecord;
  defaultOpen?: boolean;
}

export function ToolAuditCard({ record, defaultOpen = false }: Props) {
  const seconds = (record.duration_ms / 1000).toFixed(2);
  return (
    <details className="audit" open={defaultOpen}>
      <summary>
        <span className="audit-title">{record.display_label}</span>
        <span className="audit-meta">
          {humanizeToolName(record.tool_name)} · {seconds}s
        </span>
      </summary>
      <div className="audit-body">
        <dl className="audit-dl">
          {Object.entries(record.args_summary).map(([k, v]) => (
            <Row key={`a-${k}`} k={k} v={v} />
          ))}
          {Object.entries(record.result_summary).map(([k, v]) => (
            <Row key={`r-${k}`} k={k} v={v} />
          ))}
        </dl>
      </div>
    </details>
  );
}

function Row({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <dt>{humanizeKey(k)}</dt>
      <dd>{formatValue(v)}</dd>
    </>
  );
}

function humanizeKey(k: string): string {
  return k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatValue(v: unknown): React.ReactNode {
  if (v === null || v === undefined) return <span className="mono">—</span>;
  if (typeof v === 'boolean') {
    return <span className={v ? 'ok' : 'mono'}>{v ? 'Yes' : 'No'}</span>;
  }
  if (typeof v === 'number') {
    return <span>{Number.isInteger(v) ? v.toString() : v.toFixed(2)}</span>;
  }
  if (typeof v === 'string') return <span>{v}</span>;
  if (Array.isArray(v)) {
    return <span>{v.map((x) => String(x)).join(', ') || '—'}</span>;
  }
  return <span className="mono">{JSON.stringify(v)}</span>;
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
