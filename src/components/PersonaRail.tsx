'use client';

import { LENSES, type LensId } from '@/lib/personas';

interface Props {
  lens: LensId;
  onChange: (lens: LensId) => void;
}

export function PersonaRail({ lens, onChange }: Props) {
  const operator = LENSES.find((l) => l.is_operator)!;
  const recipients = LENSES.filter((l) => !l.is_operator);

  return (
    <aside className="rail" aria-label="Persona lens rail">
      <div className="rail-brand">
        <div className="rail-brand-mark" aria-hidden>
          V
        </div>
        <div className="rail-brand-title">Vendor AI</div>
      </div>

      <div className="rail-section-label">Operator</div>
      <RailItem
        key={operator.id}
        id={operator.id}
        label={operator.label}
        lock="operator"
        active={lens === operator.id}
        onClick={() => onChange(operator.id)}
      />

      <div className="rail-section-label">Recipients (preview)</div>
      {recipients.map((r) => (
        <RailItem
          key={r.id}
          id={r.id}
          label={r.label}
          lock="read-only"
          active={lens === r.id}
          onClick={() => onChange(r.id)}
        />
      ))}
    </aside>
  );
}

function RailItem({
  id,
  label,
  lock,
  active,
  onClick,
}: {
  id: string;
  label: string;
  lock: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`rail-item${active ? ' active' : ''}`}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      data-lens={id}
    >
      <span className="label">{label}</span>
      <span className="lock">{lock}</span>
    </button>
  );
}
