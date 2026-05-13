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
    <aside className="rail" aria-label="Persona rail">
      <div className="rail-brand">
        <div className="rail-brand-mark" aria-hidden>
          V
        </div>
        <div className="rail-brand-text">Vendor AI</div>
      </div>

      <div>
        <div className="rail-section-label">Operator</div>
        <ul className="rail-list" role="listbox" aria-label="Operator">
          <RailItem
            key={operator.id}
            id={operator.id}
            label={operator.label}
            sub={operator.sub}
            active={lens === operator.id}
            onClick={() => onChange(operator.id)}
          />
        </ul>
      </div>

      <div>
        <div className="rail-section-label">Recipients (preview)</div>
        <ul className="rail-list" role="listbox" aria-label="Recipients">
          {recipients.map((r) => (
            <RailItem
              key={r.id}
              id={r.id}
              label={r.label}
              sub={r.sub}
              active={lens === r.id}
              onClick={() => onChange(r.id)}
              locked
            />
          ))}
        </ul>
      </div>
    </aside>
  );
}

function RailItem({
  id,
  label,
  sub,
  active,
  onClick,
  locked,
}: {
  id: string;
  label: string;
  sub: string;
  active: boolean;
  onClick: () => void;
  locked?: boolean;
}) {
  return (
    <li
      className={`rail-item${active ? ' active' : ''}`}
      role="option"
      aria-selected={active}
      aria-current={active ? 'true' : undefined}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      tabIndex={0}
      data-lens={id}
    >
      <span className="rail-item-label">
        <span>{label}</span>
        <span className="rail-item-sub">{sub}</span>
      </span>
      {locked && <span className="rail-item-lock">read</span>}
    </li>
  );
}
