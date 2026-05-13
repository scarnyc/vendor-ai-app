import { describe, it, expect } from 'vitest';
import {
  validateRequiredDocuments,
  lookupBudget,
  checkExistingVendor,
  calculateTotalContractValue,
  classifyDataSensitivity,
  determineRequiredApprovals,
  buildVendorFollowupDraft,
  escalateToHuman,
} from '../tools';
import {
  DocumentInventorySchema,
  BudgetCheckSchema,
  DuplicateCheckResultSchema,
  TotalContractValueSchema,
  DataSensitivityResultSchema,
  DataClassSchema,
  RequiredApprovalsSchema,
  VendorFollowupDraftSchema,
  EscalationTicketSchema,
} from '../schemas';

/**
 * One happy-path smoke per PNG-named deterministic tool. The schema
 * `.parse(...)` guards the shape contract; the explicit asserts capture the
 * load-bearing fields the rubric checks for.
 */

describe('PNG-named deterministic tools — happy paths', () => {
  it('validateRequiredDocuments (case_001) → inventory has all required document keys true', async () => {
    const inv = await validateRequiredDocuments('case_001');
    DocumentInventorySchema.parse(inv);

    expect(inv.intake_xlsx).toBe(true);
    expect(inv.vendor_email_txt).toBe(true);
    expect(inv.quote_csv).toBe(true);
    expect(inv.security_questionnaire_md).toBe(true);
    expect(inv.contract_pdf).toBe(true);
    expect(typeof inv.parsed_fields).toBe('object');
  });

  it('lookupBudget (REVOPS-042) → found: true with numeric annual_budget_remaining', async () => {
    const budget = await lookupBudget('REVOPS-042', 85_000);
    BudgetCheckSchema.parse(budget);

    expect(budget.found).toBe(true);
    expect(budget.cost_center).toBe('REVOPS-042');
    expect(typeof budget.annual_budget_remaining).toBe('number');
    expect(budget.annual_budget_remaining).toBeGreaterThan(0);
  });

  it('checkExistingVendor for a known-bogus name → match_type: "none", confidence: 0', async () => {
    const dup = await checkExistingVendor('Zzz Nonexistent Vendor Co. 9999');
    DuplicateCheckResultSchema.parse(dup);

    expect(dup.match_type).toBe('none');
    expect(dup.confidence).toBe(0);
    expect(dup.matched_vendor).toBeNull();
  });

  it('calculateTotalContractValue (acv=100000, term=12, one_time=0) → tcv_usd === 100000', () => {
    const tcv = calculateTotalContractValue(100_000, 12, 0);
    TotalContractValueSchema.parse(tcv);

    expect(tcv.tcv_usd).toBe(100_000);
    expect(tcv.acv_usd).toBe(100_000);
    expect(tcv.term_months).toBe(12);
    expect(tcv.one_time_usd).toBe(0);
  });

  it('classifyDataSensitivity (case_001 data signals) → valid DataClass enum', () => {
    const out = classifyDataSensitivity(
      'customer names, customer email addresses, CRM opportunity history, sales activity'
    );
    DataSensitivityResultSchema.parse(out);

    // The enum membership is the contract; the specific class can drift with
    // pattern updates — assert by enum membership, not by literal value.
    expect(DataClassSchema.options).toContain(out.data_class);
    expect(typeof out.rationale).toBe('string');
    expect(Array.isArray(out.signals)).toBe(true);
  });

  it('determineRequiredApprovals (low risk, tcv=50k, internal) → at least one approver', () => {
    const approvals = determineRequiredApprovals({
      acv: 50_000,
      tcv: 50_000,
      term_months: 12,
      payment_terms: 'Net 30',
      data_class: 'internal',
      budget_sufficient: true,
      budget_found: true,
      has_personal_data: false,
      has_foreign_subprocessor: false,
      uses_ai_on_company_data: false,
      has_soc2_type_ii: true,
      has_dpa: true,
      risk_tier_hint: 'low',
    });
    RequiredApprovalsSchema.parse(approvals);

    expect(approvals.approvers.length).toBeGreaterThanOrEqual(1);
    expect(approvals.approvers).toContain('business_owner');
  });

  it('buildVendorFollowupDraft → is_draft: true and missing items embedded', () => {
    const missing = ['soc2_type_ii', 'dpa'];
    const draft = buildVendorFollowupDraft('Northstar Analytics', 'Jordan', missing);
    VendorFollowupDraftSchema.parse(draft);

    expect(draft.is_draft).toBe(true);
    expect(draft.missing_items).toEqual(missing);
    expect(draft.subject).toContain('Northstar Analytics');
    expect(draft.body).toContain('[DRAFT');
  });

  it('escalateToHuman (severity=block) → ticket with routed_to non-empty', () => {
    const ticket = escalateToHuman(
      'restricted data with no DPA',
      'block',
      ['security', 'legal']
    );
    EscalationTicketSchema.parse(ticket);

    expect(ticket.severity).toBe('block');
    expect(ticket.routed_to.length).toBeGreaterThan(0);
    expect(ticket.routed_to).toContain('security');
    expect(typeof ticket.created_at).toBe('string');
  });
});
