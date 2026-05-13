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
| LLM provider | Free OpenRouter `:free` models | Anthropic Sonnet / OpenAI 4o for production accuracy; routing layer (LangSmith costs dashboard) by case complexity |
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

What I'd resist building first, even if asked: a vendor-facing portal, a
multi-step approval routing engine, a mobile UI. All of those are downstream of
proving the agent's verdicts are within tolerance, and proving that takes the
eval set in Phase 1.
