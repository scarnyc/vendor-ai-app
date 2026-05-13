/**
 * Persona-as-lens config (DESIGN.md §16.3) — collapsed to procurement-only
 * for the take-home build. The 6 recipient lenses (business_owner, legal,
 * security, vp_finance, cfo, executive) were removed alongside the
 * three-button operator action simplification — see
 * PRODUCTIONIZATION.md ("Recipient-lens previews — deferred") for the
 * scope of restoring them, plus the hooks-bug guard note that must be
 * applied to <ConfirmationCard /> before non-operator lenses come back.
 */

export type LensId = 'operator';

export interface Lens {
  id: LensId;
  label: string;
  is_operator: boolean;
}

export const LENSES: Lens[] = [
  {
    id: 'operator',
    label: 'Procurement',
    is_operator: true,
  },
];

export const DEFAULT_LENS: LensId = 'operator';
