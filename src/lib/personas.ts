import type { PolicyFlag, RequiredApprover } from './agent/schemas';

/**
 * Persona-as-lens config (DESIGN.md §16.3). One operator (procurement) can
 * drive the agent + HITL; six recipient lenses are read-along previews of
 * what each downstream approver would see if Priya routed to them. The
 * permissions table is enforced in <ConfirmationCard /> and <CanvasShell />.
 */

export type LensId =
  | 'procurement'
  | 'business_owner'
  | 'legal'
  | 'security'
  | 'vp_finance'
  | 'cfo'
  | 'executive';

export interface Lens {
  id: LensId;
  label: string;
  /** Single role string used to drive recipient-flag filtering */
  recipients: RequiredApprover[];
  /** Operator (procurement) is the only lens that can act. */
  is_operator: boolean;
}

export const LENSES: Lens[] = [
  {
    id: 'procurement',
    label: 'Procurement',
    recipients: [
      'business_owner',
      'procurement_manager',
      'vp_finance',
      'cfo',
      'executive_sponsor',
      'legal',
      'security',
    ],
    is_operator: true,
  },
  {
    id: 'business_owner',
    label: 'Business Owner',
    recipients: ['business_owner'],
    is_operator: false,
  },
  {
    id: 'legal',
    label: 'Legal',
    recipients: ['legal'],
    is_operator: false,
  },
  {
    id: 'security',
    label: 'Security',
    recipients: ['security'],
    is_operator: false,
  },
  {
    id: 'vp_finance',
    label: 'VP Finance',
    recipients: ['vp_finance'],
    is_operator: false,
  },
  {
    id: 'cfo',
    label: 'CFO',
    recipients: ['cfo'],
    is_operator: false,
  },
  {
    id: 'executive',
    label: 'Executive',
    recipients: ['executive_sponsor'],
    is_operator: false,
  },
];

export const DEFAULT_LENS: LensId = 'procurement';

/** Filter flags by recipient. Operator lens shows everything. */
export function filterFlagsForLens(flags: PolicyFlag[], lensId: LensId): PolicyFlag[] {
  const lens = LENSES.find((l) => l.id === lensId);
  if (!lens || lens.is_operator) return flags;
  return flags.filter((f) => lens.recipients.includes(f.recipient));
}
