# Vendor AI — Procurement Workbench

A take-home prototype for an AI agent that triages vendor onboarding cases against
seven internal policy docs and produces an editable decision packet for a procurement
owner to approve, edit, or reject. Built for the Accelerant Tech PM exercise.

## What it does

1. Reads a vendor case folder (`cases/case_NNN/`) — intake xlsx, vendor email, quote
   csv, security questionnaire, contract pdf.
2. Walks a LangGraph state machine that mirrors the assignment's PNG flow 1:1:
   parse → validate → branch on completeness → run 8 deterministic tools →
   classify data sensitivity → determine approvers → assemble decision packet →
   validate every policy citation → **stop at a human approval gate**.
3. Surfaces the packet in a canvas-first workbench (no chat feed). The procurement
   owner can edit risk tier, add an approver, edit the vendor draft, then choose
   **Approve**, **Edit & re-run** (loops back through classification with their
   edits), or **Reject + escalate**.

The agent **never** approves spend, sends external messages, accepts contract
language, or makes the final security/privacy decision. These constraints are
baked into the schema (no field can express "approved" or "sent") and the system
prompt.

## Quick start

```bash
pnpm install
LLM_PROVIDER=mock pnpm dev   # zero network, deterministic fixtures by case_id
# open http://localhost:3000
```

Click a case pill at the top, press **Run agent**, watch the plan stream, then
edit/approve in the confirmation card.

### Run a real LLM

Default chain: **Anthropic Sonnet 4.6 (thinking adaptive) primary, DeepSeek
fallback.** Anthropic supplies native Structured Outputs
(`withStructuredOutput(schema, { method: 'jsonSchema' })`) so the one LLM call
this app makes is grammar-constrained; DeepSeek catches Anthropic rate-limits /
outages mid-demo without changing config.

```bash
echo 'ANTHROPIC_API_KEY=sk-ant-…'    >> .env.local
echo 'DEEPSEEK_API_KEY=sk-…'         >> .env.local   # REQUIRED for production deploys — Anthropic→DeepSeek fallback keeps the URL alive when Anthropic 429s or hits the spend cap
echo 'LLM_PROVIDER=anthropic'        >> .env.local
pnpm dev
```

Other modes: `LLM_PROVIDER=anthropic-only` (Anthropic, no fallback — used by
`pnpm eval:dataset`), `LLM_PROVIDER=deepseek` (DeepSeek primary with OpenRouter
fallback, legacy), `LLM_PROVIDER=deepseek-direct`, `LLM_PROVIDER=openrouter`.
Defaults: `claude-sonnet-4-5-20250929` (Anthropic), `deepseek-chat` (DeepSeek),
`deepseek/deepseek-chat:free` (OpenRouter); override with `ANTHROPIC_MODEL` /
`DEEPSEEK_MODEL` / `OPENROUTER_MODEL`.

| Env var | Default | Purpose |
|---|---|---|
| `LLM_PROVIDER` | `mock` | `anthropic` \| `anthropic-only` \| `deepseek` \| `deepseek-direct` \| `openrouter` \| `mock` |
| `ANTHROPIC_API_KEY` | — | Required for `anthropic`/`anthropic-only` |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-5-20250929` | Override Anthropic model id |
| `ANTHROPIC_EFFORT` | `medium` | Thinking effort: `low` \| `medium` \| `high` (applied when thinking is enabled) |
| `ANTHROPIC_THINKING_BUDGET` | (model default) | Override the thinking-token budget if a single case stalls |
| `DEEPSEEK_API_KEY` | — | **Required** for production deploys — composeWithFallback routes here when Anthropic 429s or hits the spend cap. Also required for `deepseek` / `deepseek-direct` modes. |
| `LLM_PIPELINE_MODE` | `single` | `single` (one structured call) or `3step` (decompose; experimental, default off) |
| `LLM_DEBUG_BINDING` | unset | When `=1`, logs the wire-format binding payload once on each LLM call — verify `thinking` + `output_config.format.type === 'json_schema'` both present |

> **Stale-env-var warning**: `LLM_PROVIDER=mock` left in your shell silently
> serves fixtures even on a real-key build. The dev server logs the active
> provider on startup; verify before claiming a real run.

## Repo layout

```
src/
  app/
    page.tsx                    # mounts <Workbench/>
    api/run/[case]/route.ts     # POST: seed + invoke; GET: snapshot
    api/resume/route.ts         # POST: Command(resume=HumanDecision)
    api/policy/[doc]/route.ts   # GET: raw policy text for the drawer
  components/                   # 11 presentational React components
    Workbench.tsx               # the only stateful component
    PersonaRail.tsx             # operator + 6 recipient lenses
    CaseTabs.tsx                # case_001 | case_002 | case_003
    CanvasHeader.tsx            # case + run_status + lens chip
    PlanList.tsx                # streaming PNG-node progress
    ToolAuditCard.tsx           # humanized tool call cards (no JSON)
    DecisionPacketCard.tsx      # the centerpiece artifact
    ConfirmationCard.tsx        # HITL inline (operator only)
    CitationChip.tsx            # opens PolicyDrawer
    PolicyDrawer.tsx            # verbatim quote + highlighted source
    RunEmpty.tsx                # pre-run CTA
  lib/
    agent/
      graph.ts                  # 14-node StateGraph + MemorySaver
      nodes.ts                  # node bodies; LLM nodes branch on activeProvider()
      tools.ts                  # 8 PNG-named tools (deterministic TypeScript)
      schemas.ts                # Zod (one-to-one with the spec's Pydantic shapes)
      policies.ts               # loads docs/*.md into prompts + drawer
      prompts.ts                # system prompt with hard product lines
      llm.ts                    # 3-mode provider switch
      mocks.ts                  # deterministic fixtures keyed by case_id
    cases.ts                    # case metadata + IDs
    personas.ts                 # operator/recipient lens definitions
cases/                          # provided — case_001…003
docs/                           # provided — 7 policy md files
tools/                          # provided — budget_lookup.csv, vendor_register.csv, PNG
```

## The three cases

| Case | Vendor | ACV | Expected |
|------|--------|-----|----------|
| 001 | Northstar Analytics (CRM AI) | $85k + $10k OT | High · approve_with_followup (Legal + Security review) |
| 002 | Workspace Depot (renewal) | $12k | Medium · approve_with_followup (gather missing intake) |
| 003 | TalentPulse AI (HR analytics) | $120k + $20k OT | High · escalate (executive sponsor; multiple blockers) |

Mock-mode verdicts match this table deterministically.

## Tools implemented (PNG names preserved)

| Tool | Source |
|------|--------|
| `validate_required_documents(case_folder)` | `cases/<id>/` filesystem |
| `lookup_budget(cost_center)` | `tools/budget_lookup.csv` |
| `check_existing_vendor(vendor_name)` | `tools/vendor_register.csv` (fuse.js fuzzy match) |
| `calculate_total_contract_value(acv, term_months, one_time)` | finance policy formula |
| `classify_data_sensitivity(data_description)` | `data_handling_policy.md` enum |
| `determine_required_approvals(...)` | `finance_approval_matrix.md` + legal + security |
| `draft_vendor_followup(missing_items, vendor_email)` | LLM-drafted, clearly labeled DRAFT |
| `escalate_to_human(reason, severity)` | structured ticket payload |
| `read_policy(name)` *(extra)* | exposes verbatim policy text for citation |
| `validate_citations()` *(extra)* | substring-checks every quote against source policy |

## Verification

```bash
pnpm typecheck   # tsc --noEmit
pnpm build       # next build
pnpm dev         # then click each case + Run + Approve
```

### Accuracy bench

`pnpm eval:dataset` scores the 3 materialized cases against
`eval/dataset.json` using a 5-point rubric (flag count in range,
flag count exact, action match, risk match, severity-mix block match).

| Provider                                       | Overall      | Notes |
|------------------------------------------------|--------------|-------|
| `mock` (deterministic fixtures)                | 15/15 100%   | Floor — graph plumbing |
| `anthropic-only` (sonnet 4.6 · thinking)       | **14/15 93%** (2026-05-13) | action / risk / severity all 3/3; flag-count-exact 2/3 |

Latency on the same run: case_001 174s · case_002 44s · case_003
140s (mean 119s, p95 ~170s). The single thinking-adaptive structured
call is the bottleneck — see [`PRODUCTIONIZATION.md`](./PRODUCTIONIZATION.md)
"Next steps — accuracy and latency" for the specific levers I'd
pull next. Full per-check breakdown and run logs in
[`eval/README.md`](./eval/README.md).

## Deploy

Single Vercel project. Set `LLM_PROVIDER` and the matching API key in **Project
Settings → Environment Variables**. Push to `main` (or any branch — preview
deploys work) and Vercel does the rest. No FastAPI, no second service.

## Read the architecture & productionization notes

- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — state graph, schema, tool catalog,
  HITL pattern, the four hard product lines and where they're enforced.
- [`PRODUCTIONIZATION.md`](./PRODUCTIONIZATION.md) — what's mocked, what would
  change at scale, the four phases to take this from prototype to production.
- [`DESIGN.md`](./DESIGN.md) — design tokens, component inventory, accessibility,
  operator/recipient permission matrix.
- [`SPEC.md`](./SPEC.md) — the original PRD-shaped spec.
