# Productionization

What it takes to put this in front of a real procurement team. Four phases, each with the metric that decides "ship" vs. "iterate."

## What's mocked today (and why each is OK for the demo)

| Mocked surface | Today | Production swap |
|---|---|---|
| Budget data | `tools/budget_lookup.csv` (10 cost centers) | Workday / SAP / NetSuite read API; cache 5min; fall back to last-known on outage |
| Vendor register | `tools/vendor_register.csv` (~30 vendors, fuzzy via fuse.js) | NetSuite vendor table or Salesforce account search; same fuzzy-match guardrails |
| Case folder intake | Filesystem under `cases/` | Email-in (`procurement@…` forwarder) + Slack `/onboard-vendor` slash command + S3 drop bucket |
| Contract parsing | `unpdf` reads text-layer PDFs | Add OCR fallback (`pdfplumber`-equivalent) for scanned PDFs; route ambiguous parses to manual review |
| LLM provider | Cheap `deepseek-direct` model | Anthropic Sonnet / OpenAI 4o for production accuracy; routing layer (LangSmith costs dashboard) by case complexity |
| Checkpointer | `MemorySaver` (in-memory, lost on cold start) | `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres`; durable threads survive restarts |
| Auth | None; demo URL is unauthenticated | SSO (Okta / Azure AD); per-procurement-owner identity threaded through to `human_decision.decided_by` |
| Audit log | In-memory `tools_called` array on the packet | Append-only Postgres table with WORM semantics; per-case immutable history |

## The four phases

### Phase 1 — Trust & evaluation (weeks 1–4)

The agent doesn't ship until I can prove its verdicts are within tolerance of the human reviewers it's standing in for. Concretely:

- **Labeled eval set**: 50–100 historical cases with ground-truth verdicts and flag lists from the procurement team. Every PR runs the eval.
- **Metrics**:
  - Verdict alignment ≥ 90% on `recommended_action` + `risk_tier`.
  - Policy-flag precision ≥ 85% (procurement-owner confirmed).
  - Policy-flag recall ≥ 95% on labeled blocking issues. Silent misses are the failure mode I care about most.
- **Drift detection**: file-watcher on `docs/*.md`. Any policy edit triggers a full re-eval; the deploy blocks until it passes.
- **Feedback loop**: every operator edit becomes a labeled example. Aggregated weekly into the eval set, or surfaced as few-shot context for the LLM.
- **Tracing**: LangSmith on for every prod run, with a public dashboard the team can open.

### Phase 2 — Integrations (weeks 4–12)

Phase 2 is where the agent stops being a demo and starts taking real cases off real channels. Three integration surfaces have to land together; partial coverage breaks the inbound funnel.

- **Inbound channels**: email-in via SES, Slack slash command, S3 drop. All three normalize to the same case-folder schema before the agent sees them.
- **Connectors**: CSVs out, real systems in. Workday for budget. NetSuite for the vendor register. DocuSign or Ironclad for contracts. Salesforce for vendor records. Jira for escalation tickets.
- **Auth**: Okta SSO with three RBAC tiers (viewer, operator, admin). The `decided_by` field becomes the SSO subject, not the string "operator".
- **Audit log**: Postgres-backed with WORM semantics enforced at the DB level. Once approved, a decision packet is immutable.

### Phase 3 — Scale & governance (Q2)

By Q2 the agent has to defend itself under audit: multi-tenant, cost-controlled, and traceable back to the policy text in force at the time of decision.

- **Policy versioning**: every flag cites `policy_doc@commit_sha`. A flag from last quarter still resolves to what the policy said *then*, not what it says today.
- **Cost controls**: cache by case-content hash. Cheaper models for parsing, premium models only for reasoning + drafting. Per-tenant cost caps with circuit breakers.
- **Override budgets**: track per-procurement-owner override rate. Above 40% in a category, the agent is miscalibrated for that flow. Below 5%, the human has stopped reading; that's a different failure but no less dangerous.
- **Guardrails**: red-team for prompt injection in vendor emails (every email goes through a sanitizer first). LLM-as-judge output validators reject any packet that violates `communication_policy.md` (e.g. claims to have sent an email). Schema-level enforcement of the four hard product lines stays.
- **Observability**: LangSmith → Datadog forwarders for SLOs. p95 latency, error rate, cost-per-case, and override rate as a leading indicator.

### Phase 4 — Org-fit (ongoing)

Phase 4 is the one nobody writes a runbook for: proving the agent actually changed how procurement works.

- **A/B test** agent-on vs. agent-off for case throughput per owner. North-star metric: median time from case-received to approval-routed. Target <5 min vs. the ~30 min manual baseline.
- **Quarterly review** with Legal and Security on policy docs + the system prompt. They own the cadence; my team owns the diff.
- **Continuous education**: when the agent flags something the owner overrides, the override note feeds back into the prompt's few-shot examples (with attribution and opt-out).

## Hard product lines stay hard at every phase

The agent **never** approves spend, sends external messages, accepts contract language, or makes the final security or privacy decision. These are baked into the schema (no field can express "approved" or "sent") and the system prompt. Productionization adds layers (auth, RBAC, audit); it does not relax these constraints. A v3 with a "send email on approve" toggle is a different product and would require a fresh policy review.

## Next steps — accuracy and latency

The 2026-05-13 dataset bench on `LLM_PROVIDER=anthropic-only` landed at **14/15 (93%)** with these per-case wall times:

| Case      | Wall time | Notes                                |
|-----------|-----------|--------------------------------------|
| case_001  | 173.7s    | Medium risk, PII, 4 flags emitted    |
| case_002  | 44.3s     | Low risk, renewal, 2 flags emitted   |
| case_003  | 140.3s    | High risk, restricted PII + AI, 6 flags · escalate |
| Mean      | 119.4s    |                                      |
| p95       | ~170s     | n=3                                  |

Accuracy is at target. Wall time is unchanged but **perceived latency is solved**: the AG-UI-over-SSE refactor (see ARCHITECTURE.md "AG-UI event protocol") turned 120s of blank canvas into 120s of progressive build-out. Tool audit cards land one-by-one as each deterministic tool completes, and the DecisionPacket renders the moment `validate_citations` clears. Same wall-clock, very different UX. The levers below shrink the actual wait:

1. **Tier the model by case complexity.** case_002 (low-risk renewal, 2 flags, 44s) doesn't need thinking-adaptive. Haiku 4.5 with thinking off would land it in under 10s. Route by `(data_class, risk_tier, doc_completeness)` before the LLM call: simple cases → Haiku, borderline → Sonnet, restricted-data → Sonnet + thinking. The classifier already produces all three signals deterministically.
2. **Decompose the single structured call into a 3-step pipeline.** The scaffold is already in `LLM_PIPELINE_MODE=3step` (default off, shipped in v0.10.2 Item 12 but not wired into the default path). Three small structured calls (flags → action → drafts) parallelize cleanly; drafts can run while action is being determined, and each chunk is small enough that grammar compilation overhead drops. Expected mean wall time: 40–60s with thinking on, 15–25s with thinking off for non-borderline cases.
3. **Cache the citation pre-extraction.** `extractCandidateClauses` (the heuristic clause indexer) re-runs on every case but the policy docs only change when Legal updates them. Hash the `(trigger_set, policy_doc@commit_sha)` tuple and cache the candidate clauses. Saves ~50ms per case today; more as the ranking complexity grows.
4. **Move flag-count-exact onto a deterministic post-filter.** The one rubric point I drop is case_001's flag-count-exact (4 vs. target 3). Once flags are emitted, a deterministic dedupe pass over `(policy_doc, section, recipient)` tuples could close that gap without further LLM calls — at the cost of trading off some recall on legitimately-distinct flags that happen to cite the same section. Worth landing only after the streaming and tiering work above; it's a tighter scope change.
5. **Loosen the eval rubric or add a "rationale faithfulness" check.** The 5-point rubric is structural; it doesn't check that the recommendation prose matches the deterministic tool outputs. Catching "approve with follow-up; request missing items" prose that ships even when `validate_required_documents` says all docs present needs a 6th check (LLM-as-judge, or a regex contradiction-finder against the tool audit trail). Higher value than chasing the last 1-2 points of the structural rubric.
6. **Per-session cache eviction + authenticated SSE session keys.** Today `MemorySaver` is a process-global map keyed by `case_id`, and the SSE endpoints accept any anonymous request. Fine for a single-operator demo, untenable in multi-tenant. The productionization move pairs two changes: (a) swap to a per-session-scoped checkpointer (`<tenant_id>:<operator_id>:<case_id>`) with an eviction policy (LRU plus a hard TTL; 4h matches the procurement workday), and (b) require an authenticated session key on every SSE open. The first prevents one operator's run from showing up in another's tab via shared process memory on the same Vercel worker; the second prevents an attacker from opening `POST /api/run/[case]` and burning paid LLM tokens against any case_id they can guess. Both unlock Phase 2 multi-tenant routing; until they land, treat the demo URL as single-operator.

What I would *not* do first: swap the model for something faster (DeepSeek, gpt-4o-mini). Anthropic Sonnet 4.6 with thinking is where the accuracy lift came from; losing it to save latency is a regression on the harder dimension. Tiering and the 3-step pipeline keep the model and shrink the experienced wait.

## Faithfulness audit

The agent emits four free-form fields the deterministic tools can't pin down: `intake_summary`, `policy_flags[].issue`, `draft_internal_ticket`, and `rationale`. Each is a drift surface; the LLM can hallucinate a number, a recipient, or a policy quote that the tool audit trail doesn't support.

`validate_citations` is the post-validation layer, and it catches the one that matters most: every `PolicyCitation.quote` is substring-checked against the cited policy file before the human gate. The canonical worked example is case_003's `"opt-out"` citation. The policy section actually reads "Company, customer, and employee data may not be used for vendor model training... unless explicitly approved by Legal, Security, and an executive sponsor." The substring `"opt-out"` is not in that text, so `validate_citations` marks the citation unverified and the CitationChip renders ⚠. Designed behavior, not a regression.

The next-step automated check is T2.1's `rationale_faithfulness` rubric, a 6th eval-bench check covering three sub-checks the structural rubric can't see: missing-items contradiction (recommendation prose claims "all docs present" while `validate_required_documents` reports gaps), hard-product-line violation (recommendation prose drifts toward approval/send language the schema can't express), and ticket-severity disagreement (the draft ticket downgrades severity relative to the highest `policy_flag.severity`).

## The Grey Area — why a 4th verdict (Pending Follow-up) earns its keep

The agent's `recommended_action` enum has four values: `approve | approve_with_followup | escalate | block`. The first two are success states; the last two are failure states. Mapping these onto a 3-state operator model (Approve / Reject / Escalate) forced `approve_with_followup` into either Approve (premature; paperwork hasn't arrived) or Reject (overstated; the vendor isn't "rejected", they're "pending"). Most case folders land in this grey area: SOC 2 Type II evidence is mid-cycle, the DPA is unsigned, the W-9 hasn't been refreshed. The vendor isn't bad. They're just incomplete.

The 4th verdict (**Pending Follow-up**) is the operator's "send the email, wait for the artifact, then re-evaluate" state. It's the most-used button in the dataset (2 of 3 materialized cases) and the reason the draft vendor email exists in the first place. The label deliberately leads with "Pending" so the operator never confuses this with an approval; nothing has been approved until the vendor's paperwork is in.

## Vendor Follow-up Email — generated but display deferred

The agent generates `draft_vendor_email.body` on every `approve_with_followup` case. It's a polished, vendor-facing message requesting the missing artifacts (SOC 2 Type II, executed DPA, etc.). The prototype UI does NOT currently render this field. The inline textarea was removed alongside the operator-edit affordance in a prior pass.

**Why it's deferred, not deleted:** the operator's Pending Follow-up verdict is meaningless without an artifact attached to it. In production, clicking Pending Follow-up should:

1. Open the draft email in a panel below the operator buttons.
2. Allow the operator to edit / append context before sending.
3. POST to a transactional email service (Postmark, SES, SendGrid) addressed to the vendor's primary contact.
4. Persist the sent message into the case audit trail.

For the prototype, generation is proven; transport is deferred. The operator selecting Pending Follow-up logs the verdict plus a placeholder note ("follow-up email queued (transport stub)"). Wireable in <2 hours of production work.

## What I'd build first

If this landed in a real codebase Monday morning, my week-1 ordering:

1. **PostgresSaver swap + eval harness.** Without durable threads and a regression gate, every deploy is risky. Fix this first.
2. **SSO + audit log.** Operator identity matters the moment real money flows through. Don't let the string "operator" in `human_decision.decided_by` become tech debt.
3. **OCR fallback for scanned contracts.** case_001's PDF parses today because it's text-layer. Real contracts are 50/50 scans. Failing closed on parse errors is the right behavior, but it would block the demo inside a week.
4. **LangSmith + Datadog forwarders.** You can't tune what you can't see. Cost-per-case and override-rate dashboards before scale, not after.
5. **Policy-doc versioning.** When Legal updates a policy mid-quarter, every in-flight case needs to re-evaluate. `policy_doc@commit_sha` is the cheapest way to make that auditable.
6. **Ambient prompt pill (deferred).** v0.6 mocks shipped a bottom-of-canvas prompt bar for ad-hoc policy Q&A and slash commands (`/run case_xxx`, `/explain <flag>`, `/show audit`). Pulled from the prototype because it had no backing handler; the affordance promised conversation it couldn't deliver. Productionizing it means a real Q&A surface backed by the LangGraph policy-RAG path plus a slash-command router. Ship only once procurement owners ask for it; the Run button + case tabs already cover the demo flow.
7. **Operator "Edit" affordance (deferred).** Today the operator binds to one of three terminal actions (Approve / Reject / Escalate). Edit would restore the ability to override fields the agent computed but the operator has out-of-band context for: risk tier misclassified (operator knows data scope is narrower than the agent inferred from the SQ), approver list missing a stakeholder, vendor draft email needs a sentence the agent didn't produce. Scope when picked up: a fourth "Edit & re-derive" button opens an inline edit drawer on the operator card. Risk-tier overrides re-run the policy-flag + approver derivation (LangGraph re-entry from `classify_data_sensitivity`). Approver-list additions and vendor-draft edits ship as-is with the decision (no re-run), preserving the agent's audit trail. Every edit logs into the `human_decision` payload alongside the verdict so the audit captures what the human changed.
8. **Recipient-lens preview views (deferred).** Today the workbench shows only the procurement owner's view. The agent already computes everything the 6 downstream recipients (Legal, Security/Privacy, CFO, VP Finance, Procurement Manager, Business Owner) each need; the UI doesn't surface those filtered views. Preview views let the operator confirm, before sending, what each recipient will see and which fields are highlighted for their role. Scope when picked up: restore the `LENSES` fixture in `src/lib/personas.ts` with the 6 recipient entries; re-mount `PersonaRail` as a 7-tile switcher (operator + 6 recipients); each recipient lens renders `DecisionPacketCard` in readonly mode with a role-specific field filter (CFO sees ACV breakdown + budget fit; Legal sees DPA/BAA-relevant flags + contract redlines). Hooks-bug guard when this comes back: `ConfirmationCard`'s hook order must be preserved — `useCallback(submit)` + `useEffect(keyboard shortcuts)` stay *above* both early returns, with their bodies guarded internally via `if (!operator || packet.human_decision) return`. Canonical React fix for "Rendered fewer hooks than expected": hooks at top of function, conditional behavior inside hook bodies. The current `ConfirmationCard` already follows this pattern.

What I'd resist even if asked: a vendor-facing portal, a multi-step approval routing engine, a mobile UI. All three are downstream of proving the agent's verdicts are within tolerance, and proving that takes the eval set in Phase 1.

## What we left out, and why

The demo URL ships as a single Vercel project on Pro tier — enough for an HM to click through case_001/002/003 end-to-end without hitting the 10s Hobby function ceiling. The six items below are conscious omissions. Each matters in production. None of them matter for a 4–6 hour prototype judged on judgment and architecture. Calling them out so the line between "demo trade-off" and "would absolutely ship this" stays explicit.

1. **Docker / container packaging.** A single Vercel function bundle covers the demo. Containers matter in Phase 2 once Workday, NetSuite, and Ironclad need sidecar workers and a queue. Premature for one URL.
2. **PostgresSaver checkpointer swap.** First-priority Phase 1 item per "What I'd build first" §1. `MemorySaver` is acceptable for the demo because threads are explicitly OK to lose on Vercel cold start; every HM click re-runs the agent from scratch by design.
3. **SSO / Okta auth.** Phase 2 work per "Phase 2 — Integrations". The demo URL is intentionally unauthenticated; a prototype reviewer shouldn't have to log in. `human_decision.decided_by` is the literal string "operator" until SSO threads a real subject in.
4. **Custom domain.** `*.vercel.app` is the right domain for a prototype. The URL is ephemeral; the work is what's being evaluated. Custom domains arrive with SSO and tenant routing in Phase 2.
5. **LangSmith tracing on the initial deploy.** Phase 1 observability per §3.1. Deferred from the first deploy to keep the failure surface small; every extra env var is a place the demo can silently break. Flip on via `LANGCHAIN_TRACING_V2=true` if HMs ask about observability mid-review.
6. **GitHub Actions / CI wiring.** Vercel auto-runs `pnpm build` on every push, which is the only CI a prototype demo needs. Real CI (eval bench as a regression gate per Phase 1, drift detection on `docs/*.md`) is Phase 1 work, not deploy-day work.

Read ARCHITECTURE.md next for the system view, or DESIGN.md for the UI contracts behind every component.
