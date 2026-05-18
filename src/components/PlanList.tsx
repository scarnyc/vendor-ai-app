'use client';

import type { RunStatus } from '@/lib/agent/schemas';
import type { ToolName } from '@/lib/agent/events';

const STEPS = [
  { node: 'await_run', label: 'Await operator Run' },
  { node: 'parse_inputs', label: 'Parse inputs' },
  { node: 'normalize_facts', label: 'Normalize facts' },
  { node: 'run_deterministic_tools', label: 'Run deterministic tools' },
  { node: 'classify_data_sensitivity', label: 'Classify data sensitivity' },
  { node: 'determine_required_approvals', label: 'Determine required approvals' },
  { node: 'extract_candidate_clauses', label: 'Extract candidate clauses' },
  { node: 'prepare_decision_packet', label: 'Prepare decision packet' },
  { node: 'validate_citations', label: 'Validate citations' },
  { node: 'human_approval', label: 'Human approval' },
] as const;

// Reverse map of NODE_TOOL_MAP: tools_called record → plan step node name.
// Used to surface step progress from the streaming TOOL_CALL_START events
// even when the server hasn't yet emitted a STATE_DELTA setting current_node.
const TOOL_TO_NODE: Partial<Record<ToolName, (typeof STEPS)[number]['node']>> = {
  validate_required_documents: 'parse_inputs',
  lookup_budget: 'run_deterministic_tools',
  check_existing_vendor: 'run_deterministic_tools',
  calculate_total_contract_value: 'run_deterministic_tools',
  classify_data_sensitivity: 'classify_data_sensitivity',
  determine_required_approvals: 'determine_required_approvals',
  validate_citations: 'validate_citations',
};

interface Props {
  currentNode: string | null;
  runStatus: RunStatus;
  activeToolName?: ToolName | null;
}

export function PlanList({ currentNode, runStatus, activeToolName }: Props) {
  // Prefer the live in-flight tool's mapped node when the server hasn't yet
  // pushed a current_node delta — gives the operator instant step feedback
  // as TOOL_CALL_START arrives.
  const liveNode =
    activeToolName && TOOL_TO_NODE[activeToolName]
      ? TOOL_TO_NODE[activeToolName]
      : currentNode;

  const idx = STEPS.findIndex((s) => s.node === liveNode);
  const allDone = runStatus === 'decided' || runStatus === 'escalated';

  return (
    <section className="plan" aria-label="Agent run plan">
      <div className="plan-header">Run plan · {STEPS.length} steps</div>
      <ol>
        {STEPS.map((step, i) => {
          const cls = allDone
            ? 'done'
            : i < idx
              ? 'done'
              : i === idx
                ? 'active'
                : 'pending';
          return (
            <li key={step.node} className={cls}>
              <span className="step-dot" aria-hidden />
              {step.label}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
