'use client';

import type { RunStatus } from '@/lib/agent/schemas';

const STEPS = [
  { node: 'await_run', label: 'Await operator Run' },
  { node: 'parse_inputs', label: 'Parse inputs' },
  { node: 'normalize_facts', label: 'Normalize facts' },
  { node: 'run_deterministic_tools', label: 'Run deterministic tools' },
  { node: 'classify_data_sensitivity', label: 'Classify data sensitivity' },
  { node: 'determine_required_approvals', label: 'Determine required approvals' },
  { node: 'prepare_decision_packet', label: 'Prepare decision packet' },
  { node: 'validate_citations', label: 'Validate citations' },
  { node: 'human_approval', label: 'Human approval' },
] as const;

interface Props {
  currentNode: string | null;
  runStatus: RunStatus;
}

export function PlanList({ currentNode, runStatus }: Props) {
  const idx = STEPS.findIndex((s) => s.node === currentNode);
  // run_status === 'decided' means the graph has reached emit_final or end —
  // every step is done.
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
