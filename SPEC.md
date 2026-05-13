# Vendor Onboarding Triage Agent — Product Spec

> **Status:** v1 draft for take-home prototype.
> **Owner:** Procurement Ops (PM-facing).
> **Audience:** Engineering + Procurement + Security/Legal reviewers.
> **Out of scope for v1:** Production rollout — covered separately in [PRODUCTIONIZATION.md](./PRODUCTIONIZATION.md).

---

## 1. Problem Statement

Procurement owners drown in incomplete vendor onboarding packages. A typical
case requires reconciling five document types (intake form, vendor email, quote,
security questionnaire, contract excerpt) against seven internal policies —
classifying risk, computing total contract value, checking the budget, matching
against existing vendors, and routing to the correct approvers. The work is
mechanical but high-attention-cost, and the consequences of missing a
policy-blocking issue (e.g. missing SOC 2 II on customer-PII, AI-training
opt-outs absent from the quote, cross-border subprocessors without a DPA) are
real: regulatory exposure, duplicate spend, and stalled deals.

Today, this triage takes a procurement owner ~30 minutes per case and competes
for attention with vendor follow-up and negotiation. Errors are silent — a
missed flag becomes Legal's problem six weeks later.

---

## 2. Goals

- **G1 — Cut triage time per case** from ~30 min of assembly to <5 min of
  *review*. Procurement owners read and approve a pre-filled packet; they no
  longer chase down inputs themselves.
- **G2 — Catch every policy-blocking issue** the policy docs codify (missing
  SOC 2 II on high-risk; AI-training opt-out gaps; cross-border subprocessors;
  ACV/TCV approval thresholds; data classification mismatches). Recall is more
  important than precision: a false flag costs 30 seconds of review; a missed
  one costs a quarter.
- **G3 — Keep humans in the loop on every decision.** The agent produces a
  structured *recommendation*; nothing ships externally and no spend is
  approved without a procurement-owner click. Agent autonomy is bounded by
  product surface, not by trust.
- **G4 — Make reasoning legible.** Every flag cites the policy doc + section it
  came from, with a verbatim quote. Procurement owners can verify in seconds
  without opening seven docs.
- **G5 — Demonstrate end-to-end on three diverse cases** from a public URL with
  zero local setup, so reviewers can validate the prototype in <2 minutes.

---

## 3. Non-Goals

- **N1 — The agent does not approve spend, sign contracts, or commit terms.**
  Per [communication_policy.md](./docs/communication_policy.md), final
  authority sits with named humans. Bake this into the schema: there is no
  `approved` field the agent can write to. *Why this is a non-goal, not a
  limitation:* lowering the autonomy ceiling is the entire reason a
  procurement org will trust this in week one.
- **N2 — The agent does not send external messages.** Vendor follow-up emails
  are drafted and clearly labelled DRAFT; the procurement owner reviews and
  sends. *Rationale:* one unauthorized email to a vendor can break a
  negotiation; the upside of full automation here is small.
- **N3 — No vendor self-service portal, no chat interface.** Single-user
  workbench only. *Rationale:* widening the surface for a take-home dilutes the
  core demonstration; vendor-facing flows are a separate product surface.
- **N4 — No persistent state across sessions in v1.** Each case run is
  independent; audit log is in-memory + downloadable. *Rationale:* persistence
  needs auth, RBAC, and WORM semantics — see [PRODUCTIONIZATION.md](./PRODUCTIONIZATION.md).
- **N5 — No real Salesforce / Workday / NetSuite / HRIS / Slack integrations.**
  `lookup_budget` reads `tools/budget_lookup.csv`; `check_existing_vendor`
  reads `tools/vendor_register.csv`. *Rationale:* the take-home is graded on
  judgment + architecture, not on connector plumbing. Adapter pattern keeps the
  swap to production cheap.
- **N6 — No auth / RBAC on the demo URL.** *Rationale:* cases are synthetic;
  reviewers need to click and run. Production auth strategy lives in the
  productionization doc.

---

## 4. Personas & User Stories

### Primary persona — Procurement Owner ("Priya")

Owns the case from intake to approval routing. Reviews ~15 vendor packages per
week. Trusts the policy docs (helped write them) but doesn't enjoy re-reading
them. Cares about audit trail. Will *not* tolerate a tool that quietly takes
actions she didn't approve.

- **US1 (must-have):** As a procurement owner, I want to load a case folder and
  receive a structured decision packet in <60 seconds, so I can spend my time
  *reviewing* not *assembling*.
- **US2 (must-have):** As a procurement owner, I want every flag to cite the
  policy doc and section it came from, so I can verify the agent's reasoning in
  seconds without opening seven docs.
- **US3 (must-have):** As a procurement owner, I want to edit the proposed risk
  tier, data classification, and required approver list before approving, so I
  retain final judgment on contested cases.
- **US4 (must-have):** As a procurement owner, when intake is incomplete, I
  want a draft vendor follow-up email pre-written and clearly labelled DRAFT,
  so I can review and send in two clicks without composing from scratch.
- **US5 (must-have):** As a procurement owner, I want a single button to
  *Approve*, *Reject with notes*, or *Request follow-up*, each producing a
  distinct artifact appended to the audit trail.
- **US6 (should-have):** As a procurement owner, I want to download the
  decision packet as JSON, so I can attach it to the ticket in our system of
  record.

### Secondary persona — Take-Home Reviewer ("Sam")

Accelerant engineer evaluating the prototype. Has ~10 minutes per candidate.
Wants to see judgment, architecture, and that the brief was read carefully.
Does *not* want to install anything.

- **US7 (must-have):** As a reviewer, I want a single public URL where I can
  run all three cases end-to-end, so I can evaluate the prototype with zero
  setup.
- **US8 (should-have):** As a reviewer, I want to see the agent's internal
  trace (tool calls, prompts, structured outputs), so I can evaluate
  architectural choices without reading every file.

---

## 5. Requirements

### P0 — Must-Have

**R1 — Read all five input document types** for any case folder under
`cases/`: intake `.xlsx`, vendor email `.txt`, quote `.csv`, security
questionnaire `.md`, contract `.pdf`.
- AC: All three provided cases parse cleanly; parse failures surface as
  `missing_items[]` entries with the filename and reason, not as crashes.

**R2 — Implement all eight tools** named in
`tools/Agent process flow - Convert into tool for agent.png`:
`validate_required_documents`, `lookup_budget`, `check_existing_vendor`,
`calculate_total_contract_value`, `classify_data_sensitivity`,
`determine_required_approvals`, `draft_vendor_followup`, `escalate_to_human`.
- AC: Each tool is a deterministic Python function registered with the agent
  framework as a callable tool, with type-checked Pydantic args + return.
- AC: Unit tests in `tests/test_tools.py` cover each tool's happy path + one
  edge case (e.g. unknown cost center, fuzzy vendor near-match).

**R3 — Produce a `DecisionPacket`** Pydantic model capturing the agent's full
output: intake summary, missing items, risk tier (`low|medium|high`), data
classification, budget check, total contract value, duplicate vendor check,
policy flags (each with severity + cited policy doc + section + verbatim
quote), required approvers, recommended action (`approve_with_followup |
escalate | block`), draft messages, tool-call audit trail, and a `human_decision`
field that is `None` until the procurement owner clicks.
- AC: No field exists on the schema that could express "spend approved" or
  "email sent" — those are reserved for human action downstream.
- AC: Schema validates on all three cases.

**R4 — Match the PNG state graph 1:1.** Parse → validate → branch on
completeness → either (normalize facts + run deterministic tools + determine
approvals + prepare packet) OR (identify missing items + draft vendor
follow-up + escalate). Both branches converge at a *human-in-the-loop
interrupt*; final packet only emits after the procurement owner clicks.
- AC: The state graph is drawn (Mermaid in [ARCHITECTURE.md](./ARCHITECTURE.md))
  and the agent cannot emit a final decision without a resume signal.

**R5 — Cite every policy flag.** Each `PolicyFlag` includes ≥1 `PolicyCitation`
with `policy_doc` name, `section` heading, and a verbatim `quote` (≤200 chars).
Quotes must be grep-able against the loaded policy markdown (no hallucinated
text).
- AC: A `validate_citations` step rejects packets where any quote fails an
  exact-substring match against the source policy doc.

**R6 — Workbench UI** lets the procurement owner see the packet, edit risk
tier / data class / approvers / draft text, and click *Approve*, *Reject (with
notes)*, or *Request follow-up*. Each action produces a distinct audit-log
entry and a distinct artifact (approved packet / rejection record / follow-up
ticket).
- AC: A reviewer can run case_001 end-to-end in the browser in <90 seconds.

**R7 — Policy-aligned verdicts on the case set:**

| Case | Vendor | Expected verdict |
|---|---|---|
| 001 | Northstar Analytics | **Medium–High** — Legal + Security review required; Finance approval ≥ $50k threshold |
| 002 | Workspace Depot | **Low** — gather missing intake (tax form, vendor setup form); business-owner approval |
| 003 | TalentPulse AI | **High + Executive escalation** — multiple blocking issues; cannot recommend approval |

- AC: Golden tests in `tests/test_cases.py` assert `recommended_action` +
  `risk_tier` + presence of key flags per case.

**R8 — Public deploy** at a URL a reviewer can open from any browser. No
local setup required.
- AC: URL is in README.md; cases 001–003 all run on the deployed instance.

**R9 — Documentation:** `README.md` (run + deploy + tradeoffs in one page),
`ARCHITECTURE.md` (diagram + tool catalog + data flow), and
`PRODUCTIONIZATION.md` (phased rollout plan).

### P1 — Nice-to-Have

- **R10 — Trace observability (LangSmith or equivalent):** one env var,
  public trace links in README. Saves the reviewer from reading every file.
- **R11 — "Why this verdict" expandable panel** per flag, showing the policy
  excerpt verbatim alongside the agent's interpretation.
- **R12 — Download decision packet as JSON.**
- **R13 — Eval harness:** `pytest tests/test_cases.py` runs the full agent
  against all three cases and asserts policy-aligned verdicts. Live LLM call,
  marked `@pytest.mark.slow`.

### P2 — Future Considerations (do not foreclose architecturally)

- **R14 — Real connector adapters** for Workday/SAP (budget), NetSuite
  (vendor register), DocuSign/Ironclad (contracts), Salesforce (vendor
  records). Today's CSV lookups should sit behind an `Adapter` interface.
- **R15 — Persistent state + audit log** with WORM semantics (Postgres +
  append-only audit table).
- **R16 — Auth + RBAC**; procurement-owner identity threaded through to
  approvals and audit log.
- **R17 — Inbound channels:** forward `procurement@` for email-in case
  intake; Slack `/onboard-vendor` slash command.
- **R18 — Multi-tenant policy versioning** — every flag cites
  `policy_name@commit_sha`. Today's `policy_doc` field should already include a
  version stub.
- **R19 — Feedback loop** — every procurement-owner edit becomes a labelled
  example for prompt iteration or fine-tuning.

---

## 6. Success Metrics

### Leading indicators (this take-home — measurable now)

| Metric | Target | Measurement |
|---|---|---|
| Verdict alignment on case set | 3/3 cases policy-aligned | Golden test assertions |
| PNG tool coverage | 8/8 tools implemented + called ≥1× across cases | Audit trail in packet |
| HITL gate integrity | 0 final decisions emitted without `Command(resume)` | Graph-state assertion in test |
| Citation fidelity | 0 hallucinated quotes (all exact-match in policy docs) | `validate_citations` step |
| Cold-start time | <30 sec from URL click to packet render | Manual timing on deployed instance |
| End-to-end run time | <90 sec for any of the three cases | Manual timing |

### Lagging indicators (production hypothesis — for the PRODUCTIONIZATION doc)

| Metric | Target | Why it matters |
|---|---|---|
| Median triage time per case | <5 min (vs. ~30 min baseline) | The core ROI claim |
| Policy-flag recall | ≥95% on a labeled eval set of historical cases | Missed flags = silent compliance risk |
| Policy-flag precision | ≥85% | Below 85% and procurement learns to ignore the agent |
| Override rate (procurement edits before approving) | 10–40% sweet spot | <10% = rubber-stamping risk; >40% = miscalibrated defaults |
| % of cases requiring vendor follow-up | Measured baseline; track if our intake form changes reduce it | Drives upstream form improvement |

---

## 7. Open Questions

| # | Question | Owner | Blocking? |
|---|---|---|---|
| OQ1 | PDF parser choice — `pypdf` for text-PDFs vs. fallback to `pdfplumber` if image-based contracts appear. Decide after first parse attempt on the provided cases. | engineering | No |
| OQ2 | LLM provider lock-in — picking Anthropic Claude Sonnet 4.6 for the prototype (existing key, strong tool-calling). Production should treat this as a plug-in via an LLM adapter. | engineering | No |
| OQ3 | Inline-all-policies-in-prompt vs. `read_policy()` tool — picking *both*: inline for context, tool for explicit citation. Costs a few tokens, gains verbatim quotes. | engineering | No |
| OQ4 | Approver routing notation — the finance approval matrix uses cost-center owners by name; should the agent name people or roles? Decision: names from `budget_lookup.csv` for v1; roles + an identity lookup in production. | PM | No |
| OQ5 | Public GitHub repo OK? — cases are synthetic, no real customer data. Confirmed in the assignment brief. | PM | No |
| OQ6 | What's the right scope for the "request follow-up" action? Today's draft attaches the email + escalation ticket; should it also create a Jira issue? Production: yes; v1: no. | PM | No |

No blocking questions for v1.

---

## 8. Timeline & Phasing

- **v1 (this take-home, ~4 hours target / 6 hours ceiling):** Ship P0
  requirements R1–R9 to a public URL. All three cases produce
  policy-aligned verdicts; reviewer can run end-to-end in the browser; docs
  explain decisions.
- **v1.1 (stretch within take-home if time):** P1 requirements R10–R13
  — LangSmith tracing, "why this verdict" panel, JSON download, eval harness.
- **v2+ (post-hire, productionization):** P2 requirements R14–R19. Spec
  lives in [PRODUCTIONIZATION.md](./PRODUCTIONIZATION.md) (separate doc).

No hard external deadlines. The "demonstration must be reproducible from a URL"
constraint is binding on v1.

---

## 9. Hard Product Lines (Never Crossed)

Codified here so they survive future scope debates:

1. **The agent never approves spend.** Final spend authority is human, per
   `finance_approval_matrix.md`.
2. **The agent never sends external messages.** All vendor communication is
   drafted and clearly labelled DRAFT, awaiting human review.
3. **The agent never accepts contract language on behalf of the company.**
   Legal review is non-delegable, per `legal_review_policy.md`.
4. **The agent never makes the final security/privacy decision.** Security
   review is non-delegable for restricted-data vendors, per
   `security_review_policy.md`.

These are enforced in the Pydantic schema (no fields exist that could express
the violating state) and in the system prompt. Any future PR that adds a field
expressing one of these states is a P0 design review item.

---

## 10. Acceptance Summary (Reviewer Quick-Check)

A reviewer should be able to verify v1 in <5 minutes by:

1. Opening the public URL → seeing all three cases listed.
2. Running case_001 → seeing a Medium–High verdict with cited flags for
   missing SOC 2 II + DPA, customer PII + EU subprocessor, Finance approval
   ≥ $50k.
3. Running case_002 → seeing a Low verdict with missing-intake follow-up draft.
4. Running case_003 → seeing a High + Executive escalation verdict with
   blocking flags for AI-training opt-out missing from quote, employee PII
   + APAC subprocessor, missing SOC 2 II + DPA.
5. Clicking *Approve* / *Reject* / *Request follow-up* → seeing the audit
   trail update.
6. Skimming README + ARCHITECTURE + PRODUCTIONIZATION docs in <3 min.

If any of those steps fail, v1 is not done.
