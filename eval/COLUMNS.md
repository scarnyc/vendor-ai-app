# `dataset.csv` column reference

One row per case. Arrays are joined with `;`. All `exp_*` columns describe
the **expected** verdict — what the agent should produce — not the actual
result. The runner (`pnpm eval:dataset`) compares the live verdict to
these columns to compute the per-case score.

## Identity

| Column        | Meaning                                                                                       |
|---------------|-----------------------------------------------------------------------------------------------|
| `id`          | Stable case identifier (`case_NNN`). Used as the graph thread id and as the fixture dir name. |
| `vendor_name` | Human label. Not used in scoring.                                                             |
| `status`      | `materialized` = has real fixture documents and is scored by the runner. `designed` = coverage hole, expected verdict declared but no fixtures yet (skipped by runner). |
| `fixture_dir` | Path (repo-relative) to the case's fixture folder, or empty for designed cases.               |

## Inputs (what the agent receives)

| Column                | Meaning                                                                                   | Allowed values |
|-----------------------|-------------------------------------------------------------------------------------------|----------------|
| `vendor_category`     | Free-form business category. Drives narrative, not routing.                                | free text |
| `vendor_stage`        | Lifecycle stage of the engagement.                                                         | `new` · `renewal` · `amendment` · `expansion` |
| `acv_usd`             | Annual contract value, USD. Triggers ACV-band approver routing.                            | integer |
| `one_time_usd`        | One-time fees (setup, professional services).                                              | integer |
| `term_months`         | Contract term length in months.                                                            | integer |
| `payment_terms`       | Net-N or similar.                                                                          | free text |
| `data_sensitivity`    | Highest data class the vendor would touch. Drives security routing + risk_tier.            | `none` · `public` · `internal` · `pii` · `restricted_pii` · `restricted_phi` |
| `ai_involvement`      | How the vendor uses AI on customer data.                                                   | `none` · `general` · `training_on_customer_data` |
| `subprocessor_region` | Where downstream subprocessors live. Empty means none / N/A.                               | `EU` · `APAC` · `US` · free text · empty |
| `docs_present`        | Documents already supplied by the vendor. `;`-joined.                                      | subset of {`intake_xlsx`, `quote_csv`, `vendor_email`, `security_questionnaire`, `contract_pdf`, `dpa_pdf`, `w9_pdf`, `baa_pdf`} |
| `open_items`          | Outstanding items keyed to common policy gaps. `;`-joined.                                 | free text tokens, e.g. `soc2_type_ii_pending`, `executed_dpa_pending`, `w9`, `ai_training_optout_missing`, `baa_missing` |

## Expected verdict (what the agent should output)

| Column                | Meaning                                                                                                                    | Allowed values |
|-----------------------|----------------------------------------------------------------------------------------------------------------------------|----------------|
| `exp_flag_target`     | Intended exact policy-flag count. Used by `flag_count_exact` rule (1 pt).                                                  | integer |
| `exp_flag_min`        | Lower bound on acceptable flag count. Used by `flag_count_within_range` rule (1 pt).                                       | integer |
| `exp_flag_max`        | Upper bound on acceptable flag count. Same rule as above.                                                                  | integer |
| `exp_recommended_action` | Required `recommended_action` value. Used by `action_match` rule (1 pt).                                                | `approve_with_followup` · `escalate` · `block` |
| `exp_risk_tier`       | Required `risk_tier` value. Used by `risk_match` rule (1 pt).                                                              | `low` · `medium` · `high` |
| `exp_severity_block`  | Expected number of `block`-severity flags. The runner only checks `presence` (>0 vs ==0) — used by `severity_mix_block_match` rule (1 pt). | integer |
| `exp_severity_warn`   | Expected number of `warn`-severity flags. Not scored today; reserved for future severity-mix scoring.                      | integer |
| `exp_severity_info`   | Expected number of `info`-severity flags. Not scored today; reserved for future severity-mix scoring.                      | integer |
| `exp_approvers_routed` | Approver roles the case should route to. `;`-joined. Not scored today; reserved for routing-accuracy rule.               | subset of {`procurement_manager`, `business_owner`, `vp_finance`, `cfo`, `executive_sponsor`, `legal`, `security`} |

## Coverage + provenance

| Column          | Meaning                                                                                                      |
|-----------------|--------------------------------------------------------------------------------------------------------------|
| `coverage_tags` | `dim:value`-style tags (`;`-joined) used by the runner's coverage breakdown report. Pick from `dataset.json::coverage_dimensions`. |
| `notes`         | Free-text description of what the case is *testing* — the discrimination it targets, why it earns its slot. Read this when extending the dataset; it explains the design intent. |

## Scoring rubric (5 points per materialized case)

Defined in `dataset.json::scoring_rubric` so the runner can't drift. Each rule binds to one or more columns above:

| Rule                       | Binds to                                                  |
|----------------------------|-----------------------------------------------------------|
| `flag_count_within_range`  | `exp_flag_min`, `exp_flag_max`                            |
| `flag_count_exact`         | `exp_flag_target`                                         |
| `action_match`             | `exp_recommended_action`                                  |
| `risk_match`               | `exp_risk_tier`                                           |
| `severity_mix_block_match` | `exp_severity_block` (presence check: `>0` vs `==0`)      |

The remaining `exp_severity_warn`, `exp_severity_info`, and `exp_approvers_routed` columns are documented expectations that aren't bound to a rule yet — they're there so the bench can grow without re-shaping the dataset.
