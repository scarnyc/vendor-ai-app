/**
 * Case metadata for the case-tab strip and the canvas header. The CASE_IDS
 * array is the single source of truth for which cases the UI knows about;
 * all per-case file IO happens inside src/lib/agent/tools.ts.
 */

export const CASE_IDS = ['case_001', 'case_002', 'case_003'] as const;
export type CaseId = (typeof CASE_IDS)[number];

export interface CaseMeta {
  id: CaseId;
  vendor_name: string;
  short_name: string;
  acv_short: string;
  one_liner: string;
}

export const CASES: Record<CaseId, CaseMeta> = {
  case_001: {
    id: 'case_001',
    vendor_name: 'Northstar Analytics',
    short_name: 'Northstar',
    acv_short: '$85k',
    one_liner: 'CRM AI overlay, $85k ACV, customer PII',
  },
  case_002: {
    id: 'case_002',
    vendor_name: 'Workspace Depot',
    short_name: 'Workspace Depot',
    acv_short: '$12k',
    one_liner: 'Office supplies renewal, $12k ACV, no data access',
  },
  case_003: {
    id: 'case_003',
    vendor_name: 'TalentPulse AI',
    short_name: 'TalentPulse',
    acv_short: '$120k',
    one_liner: 'HR analytics, $120k ACV, employee PII + AI training',
  },
};
