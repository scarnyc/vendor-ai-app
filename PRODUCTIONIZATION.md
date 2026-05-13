# Productionization

How this prototype becomes a system you can put in front of real procurement
teams. Phased; each phase has explicit gates and the metrics that decide
"ship" vs. "iterate."

## What's mocked today (and why each is OK for the demo)

| Mocked surface | Today | Production swap |
|---|---|---|
| Budget data | `tools/budget_lookup.csv` (10 cost centers) | Workday / SAP / NetSuite read API; cache 5min; fall back to last-known on outage |
| Vendor register | `tools/vendor_register.csv` (~30 vendors, fuzzy via fuse.js) | NetSuite vendor table or Salesforce account search; same fuzzy-match guardrails |
| Case folder intake | Filesystem under `cases/` | Email-in (`procurement@…` forwarder) + Slack `/onboard-vendor` slash command + S3 drop bucket |
| Contract parsing | `unpdf` reads text-layer PDFs | Add OCR fallback (`pdfplumber`-equivalent) for scanned PDFs; route ambiguous parses to manual review |
| LLM provider | Cheap `deepseek-direct` model | Anthropic Sonnet / OpenAI 4o for production accuracy; routing layer (LangSmith costs dashboard) by case complexity |
| Checkpointer | `MemorySaver` (in-memory, lost on cold start) | `PostgresSaver` from `@langchain/langgraph-checkpoint-postgres` — durable threads survive restarts |
| Auth | None — demo URL is unauthenticated | SSO (Okta / Azure AD); per-procurement-owner identity threaded through to `human_decision.decided_by` |
| Audit log | In-memory `tools_called` array on the packet | Append-only Postgres table with WORM semantics; per-case immutable history |

## The four phases

### Phase 1 — Trust & evaluation (weeks 1–4)

Goal: prove the agent's verdicts are within tolerance of human reviewers.

- **Labeled eval set**: 50–100 historical cases with ground-truth verdicts and
  flag lists from the procurement team. Every PR runs the eval.
- **Metrics**:
  - Verdict alignment ≥ 90% on `recommended_action` + `risk_tier`.
  - Policy-flag precision ≥ 85% (procurement-owner confirmed).
  - Policy-flag recall ≥ 95% on labeled blocking issues — silent misses are
    the failure mode we care about most.
- **Drift detection**: file-watcher on `docs/*.md`; any policy edit triggers a
  full re-eval. Block deploys until eval passes.
- **Feedback loop**: every operator edit becomes a labeled example. Aggregate
  weekly into the eval set or use as few-shot for the LLM.
- **Tracing**: LangSmith on for every prod run. Public dashboard for the team.

### Phase 2 — Integrations (weeks 4–12)

Goal: take real cases off real channels, hit real systems.

- **Inbound channels**: email-in via SES + Slack slash command + S3 drop. All
  produce a normalized case folder schema before hitting the agent.
- **Connectors**: replace CSVs with Workday (budget), NetSuite (vendor
  register), DocuSign / Ironclad (contract intake), Salesforce (vendor
  records), Jira (escalation tickets).
- **Auth**: Okta SSO; RBAC tiers — viewer / operator / admin. `decided_by` is
  the SSO subject, not "operator".
- **Audit log**: Postgres-backed; WORM semantics enforced at the DB level.
  Decision packets are immutable once approved.

### Phase 3 — Scale & governance (Q2)

Goal: multi-tenant, cost-controlled, defensible under audit.

- **Policy versioning**: every flag cites `policy_doc@commit_sha`. A flag from
  last quarter still resolves to the policy text in force *then*.
- **Cost controls**: cache by case-content hash; run cheaper models for
  parsing, premium model only for the reasoning + draft steps. Per-tenant cost
  caps with circuit breakers.
- **Override budgets**: track per-procurement-owner override rate. If it crosses
  40% in a category, alert: the agent is miscalibrated for that flow. If it
  drops below 5%, alert: the human is rubber-stamping (different failure mode).
- **Guardrails**:
  - Red-team for prompt injection in vendor emails (every email goes through a
    sanitizer before the agent sees it).
  - LLM-as-judge output validators reject any packet that violates
    `communication_policy.md` (e.g. claims to have sent an email).
  - Schema-level enforcement of the four hard product lines remains.
- **Observability**: LangSmith → Datadog forwarders for SLOs (p95 latency,
  error rate, cost-per-case, override rate as a leading indicator).

### Phase 4 — Org-fit (ongoing)

Goal: prove this changes how procurement actually works.

- **A/B test** agent-on vs. agent-off for case throughput per owner. North-star
  metric is **median time from case-received to approval-routed** (target <5 min
  vs. the ~30 min manual baseline).
- **Quarterly review** with Legal + Security on policy docs and the system
  prompt. They own the cadence; agent team owns the diff.
- **Continuous education**: when the agent flags something the owner overrides,
  the override note is fed back into the prompt's few-shot examples (with
  attribution + opt-out).

## Hard product lines stay hard at every phase

The agent **never** approves spend, sends external messages, accepts contract
language, or makes the final security or privacy decision. These are baked into
the schema (no field can express "approved" or "sent") and the system prompt.
Productionization adds layers — auth, RBAC, audit — but does not relax these
constraints. A v3 with a "send email on approve" toggle is a different product
and would require a fresh policy review.

## Next steps — accuracy and latency (the caveats I'd improve first if given more time)

On the 2026-05-13 dataset bench, `LLM_PROVIDER=anthropic-only`
landed at **14/15 (93%)** with these per-case wall times:

| Case      | Wall time | Notes                                |
|-----------|-----------|--------------------------------------|
| case_001  | 173.7s    | Medium risk, PII, 4 flags emitted    |
| case_002  | 44.3s     | Low risk, renewal, 2 flags emitted   |
| case_003  | 140.3s    | High risk, restricted PII + AI, 6 flags · escalate |
| Mean      | 119.4s    |                                      |
| p95       | ~170s     | n=3                                  |

Accuracy is at target. Latency is the standing caveat — a single
**~2-minute mean wall time per case** isn't a UX a procurement owner
will tolerate even once a day, let alone for a queue of 20 vendors.
The bottleneck is the single thinking-adaptive Structured Outputs
call in `runLlmComposition` (Sonnet 4.6, `max_tokens=16000`, thinking
on). Treating each lever in order of impact:

1. **Stream the structured output to the UI.** Today the
   `/api/run/[case]` POST blocks for the full duration, then the
   client renders the packet in one frame. Streaming the JSON chunks
   into a partial packet renderer turns 120s of "blank canvas" into
   120s of progressive build-out — same wall time, completely
   different perceived latency. The Vercel 10s function timeout
   resets per chunk on streaming, which is why this is the obvious
   first move.
2. **Tier the model by case complexity.** case_002 (low-risk
   renewal, 2 flags, 44s) doesn't need thinking-adaptive — Haiku 4.5
   with thinking off would land it in under 10s. Route by
   `(data_class, risk_tier, doc_completeness)` before the LLM call:
   simple cases → Haiku, borderline cases → Sonnet, restricted-data
   cases → Sonnet + thinking. The classifier already produces all
   three signals deterministically.
3. **Decompose the single structured call into a 3-step pipeline.**
   The scaffold is already in `LLM_PIPELINE_MODE=3step` (default off,
   shipped in v0.10.2 Item 12 but not wired into the default path).
   Three small structured calls — flags → action → drafts —
   parallelize cleanly (drafts can run while action is being
   determined), and each chunk is small enough that grammar
   compilation overhead drops. Expected mean wall time: 40–60s with
   thinking still on, 15–25s with thinking off for non-borderline
   cases.
4. **Cache the citation pre-extraction.** `extractCandidateClauses`
   (the heuristic clause indexer) re-runs on every case but the
   policy docs only change when Legal updates them. Hash the
   `(trigger_set, policy_doc@commit_sha)` tuple and cache the
   candidate clauses; saves ~50ms per case today, more once the
   ranking complexity grows.
5. **Move flag-count-exact onto a deterministic post-filter.** The
   only rubric point we drop is case_001's flag-count-exact (4 vs.
   target 3). Once flags are emitted, a deterministic dedupe pass
   over `(policy_doc, section, recipient)` tuples could close that
   gap without further LLM calls — at the cost of trading off some
   recall on legitimately-distinct flags that cite the same section.
   Worth landing only after the streaming/tiering work above, since
   it's a tighter scope change.
6. **Loosen the eval rubric or add a "rationale faithfulness" check.**
   The 5-point rubric is structural — it doesn't check that the
   recommendation prose matches the deterministic tool outputs.
   Catching the kind of "approve with follow-up — request missing
   items" prose that ships even when `validate_required_documents`
   says all docs present requires a 6th check (LLM-as-judge or a
   regex contradiction-finder against the tool audit trail). Higher
   value than chasing the last 1-2 points of the structural rubric.

What I would *not* do first: swap the model out for a faster
provider (DeepSeek, gpt-4o-mini). Anthropic Sonnet 4.6 with
thinking is where the accuracy lift came from — losing it to save
latency is a regression on the harder dimension. The streaming +
tiering moves above keep the model and shrink the experienced wait.

## Faithfulness audit

The agent emits four free-form fields that the deterministic tools can't pin
down: `intake_summary`, `policy_flags[].issue`, `draft_internal_ticket`, and
`rationale`. Each is a drift surface — the LLM can hallucinate a number, a
recipient, or a policy quote that the tool audit trail doesn't support.

`validate_citations` is the existing post-validation layer, and it catches the
one that matters most: every `PolicyCitation.quote` is substring-checked
against the cited policy file before the human gate. The canonical worked
example is case_003's `"opt-out"` citation. The policy section actually reads
"Company, customer, and employee data may not be used for vendor model
training... unless explicitly approved by Legal, Security, and an executive
sponsor." The substring `"opt-out"` is not in that text, so
`validate_citations` correctly marks the citation unverified and the
CitationChip renders ⚠ — the designed behavior, not a regression.

The next-step automated check is T2.1's `rationale_faithfulness` rubric — a
6th eval-bench check covering three sub-checks the structural rubric can't
see: missing-items contradiction (recommendation prose claims "all docs
present" while `validate_required_documents` reports gaps),
hard-product-line violation (recommendation prose drifts toward approval/send
language the schema can't express), and ticket-severity vs.
`policy_flags`-max disagreement (the draft ticket downgrades severity
relative to the highest `policy_flag.severity`).

## What I'd build first

If this prototype landed in a real codebase Monday morning, my week-1 priorities
in order:

1. **PostgresSaver swap + eval harness** — without durable threads and a
   regression gate, every deploy is risky. Fix this before anything else.
2. **SSO + audit log** — operator identity is the load-bearing concept once
   real money flows through. Don't let the "operator" string in
   `human_decision.decided_by` become tech debt.
3. **OCR fallback for scanned contracts** — case_001's PDF parses today
   because it's text-layer. Real contracts are 50/50 scans; failing closed on
   parse errors is the right behavior, but it'd block the demo within a week.
4. **LangSmith + Datadog forwarders** — you can't tune what you can't see.
   Cost-per-case + override-rate dashboards before scale, not after.
5. **Policy-doc versioning** — when Legal updates a policy mid-quarter, every
   in-flight case needs to re-evaluate. `policy_doc@commit_sha` is the cheapest
   way to make that auditable.
6. **Ambient prompt pill (deferred)** — v0.6 mocks shipped a bottom-of-canvas
   prompt bar for ad-hoc policy Q&A and slash commands (`/run case_xxx`,
   `/explain <flag>`, `/show audit`). Removed from the prototype because it had
   no backing handler — the affordance promised conversation it couldn't
   deliver. Productionizing it means a real Q&A surface backed by the LangGraph
   policy-RAG path plus a slash-command router; ship only once procurement
   owners ask for it (the Run button + case tabs already cover the demo flow).
7. **Operator "Edit" affordance — deferred.** Today the operator binds to one
   of three terminal actions (Approve / Reject / Escalate). Edit restores the
   ability for the operator to override fields the agent computed but the
   operator has out-of-band context for: risk tier misclassified (operator
   knows data scope is narrower than the agent inferred from the SQ); approver
   list missing a stakeholder; vendor draft email needs a sentence the agent
   didn't produce. Scope when picked up: a fourth "Edit & re-derive" button
   that opens an inline edit drawer on the operator card; risk-tier override
   re-runs the policy-flag + approver derivation (LangGraph re-entry from
   `classify_data_sensitivity`); approver-list additions and vendor-draft
   edits ship as-is with the decision (no re-run) — preserves the agent's
   audit trail; edits logged into the `human_decision` payload alongside the
   verdict so the audit trail captures what the human changed.
8. **Recipient-lens preview views — deferred.** Today the workbench shows only
   the procurement owner's view. The agent already computes everything the 6
   downstream recipients (Legal, Security/Privacy, CFO, VP Finance,
   Procurement Manager, Business Owner) each need, but the UI doesn't surface
   those filtered views. Preview views let the operator confirm, before
   sending, what each recipient will see and which fields are highlighted for
   their role. Scope when picked up: restore the `LENSES` fixture in
   `src/lib/personas.ts` with the 6 recipient entries; re-mount `PersonaRail`
   as a 7-tile switcher (operator + 6 recipients); each recipient lens renders
   `DecisionPacketCard` in readonly mode with a role-specific field filter
   (e.g., CFO sees ACV breakdown + budget fit; Legal sees DPA/BAA-relevant
   flags + contract redlines). Hooks-bug guard when this comes back:
   `ConfirmationCard`'s hook order must be preserved correctly —
   `useCallback(submit)` + `useEffect(keyboard shortcuts)` must remain *above*
   both early returns, with their bodies guarded internally via
   `if (!operator || packet.human_decision) return`. This is the canonical
   React fix for "Rendered fewer hooks than expected": hooks at top of
   function, conditional behavior inside hook bodies. The current
   `ConfirmationCard` already follows this pattern.

What I'd resist building first, even if asked: a vendor-facing portal, a
multi-step approval routing engine, a mobile UI. All of those are downstream of
proving the agent's verdicts are within tolerance, and proving that takes the
eval set in Phase 1.

## Deferred from the initial demo deploy

The take-home demo URL ships as a single Vercel project on Pro tier — enough to
let an HM click through case_001/002/003 end-to-end without hitting the 10s
Hobby function ceiling. The six items below are conscious omissions, each
load-bearing in production but not in a 4–6 hour take-home judged on judgment
and architecture. Calling them out so the line between "demo trade-off" and
"would absolutely ship this" is explicit.

1. **Docker / container packaging.** A single Vercel function bundle covers the
   demo. Containers matter in Phase 2 once integrations (Workday, NetSuite,
   Ironclad) need sidecar workers and a queue. Premature for one URL.
2. **PostgresSaver checkpointer swap.** First-priority Phase 1 item per
   "What I'd build first" §1. `MemorySaver` is acceptable for the demo because
   threads are explicitly OK to lose on Vercel cold start — every HM click
   re-runs the agent from scratch by design.
3. **SSO / Okta auth.** Phase 2 per §"Phase 2 — Integrations." The demo URL is
   intentionally unauthenticated — a take-home reviewer shouldn't have to log
   in. `human_decision.decided_by` is the literal string "operator" until SSO
   threads a real subject in.
4. **Custom domain.** `*.vercel.app` is the correct domain for a take-home —
   the URL is ephemeral, the work is what's being evaluated. Custom domains
   arrive with SSO and tenant routing in Phase 2.
5. **LangSmith tracing on the initial deploy.** Phase 1 observability per §3.1.
   Deferred from the first deploy to keep the failure surface small — every
   extra env var is a place the demo can silently break. Flip on via
   `LANGCHAIN_TRACING_V2=true` if HMs ask about observability mid-review.
6. **GitHub Actions / CI wiring.** Vercel auto-runs `pnpm build` on every push
   — that's the only CI a take-home demo needs. Real CI (eval bench as a
   regression gate per Phase 1, drift detection on `docs/*.md`) is Phase 1
   work, not deploy-day work.
