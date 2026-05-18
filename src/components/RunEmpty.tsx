'use client';

import type { CaseMeta } from '@/lib/cases';

interface Props {
  caseMeta: CaseMeta;
  busy: boolean;
  countdownSecondsRemaining: number | null;
  onRun: () => void;
  onCancelCountdown: () => void;
}

/**
 * Pre-run affordance. Three visual states driven by `countdownSecondsRemaining`:
 *   - number > 0  → first-visit auto-start countdown with a Cancel button
 *   - null + idle → static "▶ Run agent" button (post-cancel or returning visit
 *                   with no cached state)
 *   - busy        → "Running…" pending state on the run button
 *
 * The countdown ticks down externally (useStreamingRun owns the timer); this
 * component is presentational. Cancel maps to onCancelCountdown so the hook
 * tears down the timer cleanly.
 */
export function RunEmpty({
  caseMeta,
  busy,
  countdownSecondsRemaining,
  onRun,
  onCancelCountdown,
}: Props) {
  const counting =
    countdownSecondsRemaining != null && countdownSecondsRemaining > 0;

  return (
    <div className="run-empty">
      <div className="run-empty-title">
        {counting
          ? `Auto-running triage for ${caseMeta.vendor_name} in ${countdownSecondsRemaining}…`
          : `Ready to triage ${caseMeta.vendor_name}`}
      </div>
      <div className="run-empty-sub">{caseMeta.one_liner}</div>
      <div className="run-empty-sub" style={{ fontSize: 12 }}>
        Parses the package, runs the deterministic tools, classifies risk,
        and prepares a Decision Packet for your review. The agent never
        approves spend or sends external messages on its own.
      </div>
      {counting ? (
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            className="btn"
            onClick={onCancelCountdown}
            style={{ marginTop: 12 }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRun}
            disabled={busy}
            style={{ marginTop: 12 }}
          >
            Start now
          </button>
        </div>
      ) : (
        <button
          type="button"
          className="btn btn-primary"
          onClick={onRun}
          disabled={busy}
          style={{ marginTop: 12 }}
        >
          {busy ? 'Running…' : '▶ Run agent'}
        </button>
      )}
    </div>
  );
}
