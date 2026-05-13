# vendor-ai eval dataset

A small but deliberately-shaped dataset for grading the vendor onboarding
triage agent. The dataset is JSON so coverage can grow without changing
runner code, and so it can be sliced (coverage tag → conditional accuracy)
when looking for systematic blind spots.

- **Source of truth:** `dataset.json` (schema v0.9)
- **Materialized cases:** `case_001`, `case_002`, `case_003` — have real
  fixture documents under `../cases/<id>/` and run end-to-end through the
  graph today.
- **Designed cases:** `case_004 … case_011` — coverage holes documented
  with expected verdicts; fixtures can be added later without changing the
  scoring contract.

The dataset deliberately overlaps with `src/lib/agent/mocks.ts` (which is
the same three materialized cases, frozen at v0.8). Mocks drive the UI
smoke path; this dataset drives the live LLM accuracy bench.

---

## Coverage matrix

Six dimensions are tagged on every case so the bench can compute
conditional accuracy:

| Dimension          | Values                                                                                   |
|--------------------|------------------------------------------------------------------------------------------|
| `risk_tier`        | `low` · `medium` · `high`                                                                |
| `vendor_stage`     | `new` · `renewal` · `amendment` · `expansion`                                            |
| `data_sensitivity` | `none` · `public` · `internal` · `pii` · `restricted_pii` · `restricted_phi`             |
| `acv_band_usd`     | `<10k` · `10-50k` · `50-100k` · `100-500k` · `>500k`                                     |
| `ai_involvement`   | `none` · `general` · `training_on_customer_data`                                         |
| `doc_completeness` | `complete` · `missing_w9` · `missing_security_artifact` · `missing_dpa` · `missing_ai_optout` · `multiple_missing` |

Cases are picked to cover the discrimination boundaries, not the full
Cartesian product. Each case targets one or two specific failure modes
the v0.7→v0.8 work surfaced.

### What each case tests

| Case   | Status        | Tests                                                                                  |
|--------|---------------|----------------------------------------------------------------------------------------|
| 001    | materialized  | Most-common shape — mid-market new vendor + PII + 4-approver routing breadth.          |
| 002    | materialized  | Floor case — low-risk renewal, no data, paperwork-only follow-up. Tests no-escalate.   |
| 003    | materialized  | Ceiling case — restricted PII + AI training + multiple blockers → escalate not block.  |
| 004    | designed      | Negative control — sub-$10k renewal, complete docs. Tests agent does NOT manufacture flags. |
| 005    | designed      | Middle data tier — Internal data + missing security questionnaire (paperwork warn).    |
| 006    | designed      | `risk:high` + complete docs — tests that risk tier alone does NOT trigger escalate.    |
| 007    | designed      | $780k expansion — Board-tier ACV with no policy blockers. Tests ACV → approver routing. |
| 008    | designed      | PHI / HIPAA BAA path — distinct from generic DPA. Tests BAA-specific citation.         |
| 009    | designed      | Amendment-only — should skip full security sweep when terms unchanged.                 |
| 010    | designed      | Discrimination — AI training opt-out gap on Internal (warn) vs Restricted (block, c.f. case_003). |
| 011    | designed      | 1099 individual contractor edge — different W-9 / IRS form path than corporate vendor. |

---

## Scoring rubric (5 points per case)

Defined in `dataset.json::scoring_rubric` so the runner can't drift:

1. **`flag_count_within_range`** — actual count is inside `expected.flag_count.range`.
2. **`flag_count_exact`** — actual count equals `expected.flag_count.target`.
3. **`action_match`** — `recommended_action` exactly matches.
4. **`risk_match`** — `risk_tier` exactly matches.
5. **`severity_mix_block_match`** — presence of any `block`-severity flag
   matches the expected mix (`severity_mix.block > 0` ↔ at least one
   block flag emitted). Catches the "right action, wrong content" failure
   where the agent picks `escalate` but emits no `block` flag.

Aggregate score is `sum(case.points) / (n_materialized * 5)`.

---

## How to run

```bash
# Smoke (3 cases, original runner, scored against mocks.ts):
pnpm eval:live

# Dataset bench (materialized cases only, scored against dataset.json):
pnpm eval:dataset
```

Both runners read `.env.local` via Node's native `--env-file`. The
provider chain is whatever `LLM_PROVIDER` selects (default: Anthropic
Sonnet 4.6 with thinking + DeepSeek fallback). Force one lane with e.g.
`LLM_PROVIDER=deepseek-only pnpm eval:dataset`.

---

## How to extend

### Adding a designed case (no fixture)

1. Add a new entry to `dataset.json::cases`. Mirror an existing case's
   shape: `id`, `vendor_name`, `status: "designed"`, `fixture_dir: null`,
   `inputs`, `expected`, `coverage_tags`, `notes`.
2. Pick `coverage_tags` from the matrix above so the slicing report sees
   the new case.
3. Document in `notes` what discrimination the case is targeting — future
   readers (and you, three weeks later) need to know why the case earns
   its slot.

A designed case alone is enough to lock in an expected verdict; it just
won't be scored by `eval:dataset` until fixtures land.

### Promoting a designed case to materialized

1. Create `cases/<id>/` with the five-file shape:
   - `*_intake.xlsx`
   - `*_quote.csv`
   - `*_vendor_email.txt`
   - `*_security_questionnaire.md`
   - `*_contract.pdf`
2. Wire the case into `seedState` (`src/lib/agent/graph.ts`) and
   `MOCK_LLM_OUTPUT` (`src/lib/agent/mocks.ts`) so the UI smoke path can
   render it.
3. Flip `status: "designed"` → `"materialized"` and set `fixture_dir:
   "cases/<id>/"`.
4. Rerun `pnpm eval:dataset` and confirm the case scores against its own
   declared expectation.

---

## Current bench results (v0.10.2 — 2026-05-13)

Bench: 3 materialized cases × 5-point rubric (flag-count-in-range,
flag-count-exact, action-match, risk-match, severity-mix block match).

### Accuracy

| Provider                                  | Overall      | Notes                                                                 |
|-------------------------------------------|--------------|-----------------------------------------------------------------------|
| `mock` (deterministic fixtures)           | 15/15 100%   | Floor — proves the scoring + graph plumbing works end-to-end.        |
| **`anthropic-only` (sonnet 4.6 · thinking adaptive)** | **14/15 93%** | Latest run 2026-05-13. case_002 5/5, case_003 5/5, case_001 4/5 (flag-count-exact off by 1 — emitted 4 flags vs. target 3, still inside the 2–4 range). Run-to-run variance ±1 under thinking-on stochastic decoding (13–14/15 envelope). |
| `deepseek-only` (deepseek-chat)           | (legacy)     | Pre-v0.10.2 path; not the default chain. Use as a fallback only.       |

Per-check breakdown for the 2026-05-13 run:

| Check                       | Score |
|-----------------------------|-------|
| flag count within range     | 3/3   |
| flag count exact            | 2/3   |
| action match                | 3/3   |
| risk match                  | 3/3   |
| severity mix (block) match  | 3/3   |

Where 2026-05-13 leaves accuracy: the rubric's structural dimensions
(action, risk tier, severity-mix, flag-count range) are all 3/3.
Flag-count-exact is the only soft miss and it's case_001 (off by +1,
still in the acceptable range).

### Latency (2026-05-13 run, anthropic-only, thinking adaptive)

| Case      | Wall time | Flags emitted | Action                   | Risk    |
|-----------|-----------|---------------|--------------------------|---------|
| case_001  | 173.7s    | 4             | `approve_with_followup`  | medium  |
| case_002  | 44.3s     | 2             | `approve_with_followup`  | low     |
| case_003  | 140.3s    | 6             | `escalate`               | high    |
| **Mean**  | **119.4s** |               |                          |         |
| **p95**   | **~170s** (n=3) |          |                          |         |

Latency is dominated by the single structured LLM call inside
`runLlmComposition` — thinking-adaptive on Sonnet 4.6 with
`max_tokens=16000` (the budget that survived the v0.10.2 JSON-output
starvation). Wall time scales with reasoning depth: case_002 (low
risk, 2 flags) is ~3× faster than case_001/003. **This is the bench's
biggest weakness today**; the productionization doc lists the
specific levers (streaming, tiered models, pipeline decomposition) in
the "Next steps — accuracy and latency" section.

### How we got to 14/15

Anthropic Sonnet 4.6 with adaptive thinking + native Structured
Outputs is the default. v0.10.2 lifts the bench from 8/15 (mid-cycle
post-swap) to 14/15 on target via Items 18 (PII classifier
narrowing), 21 (thinking re-enabled on structured path with
`max_tokens=16000` budget), 19a/19b (intake-field-driven trigger
routing + ranked clause selection), 19c (tuple-keyed exemplar
lookup), plus the LlmCompositionSchema length cap on
`draft_internal_ticket` that stopped the case_001 mode-collapse /
JSON truncation.

LangSmith project: `vendor-ai`. Inspect any outlier trace with:
```bash
poetry run langsmith-fetch traces --last-n-minutes 10 --format raw
```
