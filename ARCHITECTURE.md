# Architecture

## One-paragraph summary

A single Next.js 16 app deployed on Vercel. The frontend is a canvas-first
workbench (React 19 + Tailwind 4) that talks to three REST endpoints under
`/api/`. Those endpoints drive a LangGraph.js state machine — 14 nodes that
mirror the take-home's PNG flow — and surface the agent's output as a structured
`DecisionPacket`. A human approval interrupt sits between packet assembly and
the final emit; nothing leaves the agent without an operator click. The whole
TypeScript stack is intentional: it collapses to one Vercel deploy and lets the
state schema, the API contract, and the React props all share a single Zod
source of truth.

## State graph

```
START
  │
  ▼
await_run                              ◄── operator presses "Run agent"
  │  Command(resume="run")             ◄── /api/run POST seeds + invokes
  ▼
parse_inputs ── isPackageComplete? ─── No ──► identify_missing
  │ Yes                                            │
  ▼                                                ▼
normalize_facts                            draft_vendor_followup
  │                                                │
  ▼                                                ▼
run_deterministic_tools                    escalate_to_human ──► END
  │  (lookup_budget, check_existing_vendor,
  │   calculate_total_contract_value)
  ▼
classify_data_sensitivity ◄────────┐
  │                                │
  ▼                                │ edit_and_rerun
determine_required_approvals       │ (carries operator edits as forwardedProps;
  │                                │  deterministic tool outputs are cached
  ▼                                │  in state and not recomputed)
extract_candidate_clauses          │
  │  (heuristic clause indexer — keyword-density-ranked
  │   policy lines fed into the LLM's user message so it
  │   can quote verbatim; ≥99% verified citations target)
  ▼                                │
prepare_decision_packet            │
  │                                │
  ▼                                │
validate_citations                 │
  │                                │
  ▼                                │
human_approval ──┬─────────────────┘
                 │
                 │ approve · reject · request_followup
                 ▼
              emit_final ──► END
```

Two structural changes vs. the spec's original PNG (DESIGN §16.7):
1. **`await_run` initial state** — the operator's Run button issues
   `Command({ resume: "run" })` to get past it. This stops the graph from
   auto-running on every cold-start of a fresh thread.
2. **Edit-and-re-run loop edge** from `human_approval` back to
   `classify_data_sensitivity`. Re-runs only the LLM-driven downstream nodes;
   deterministic tool results stay memoized in state.

`validate_citations` runs after packet assembly and before the human gate. It
substring-checks every `PolicyCitation.quote` against the cited policy file.
Failures get demoted to `severity: "warn"` and an `agent_citation_unverified`
flag is appended. This closes the no-hallucination loop.

## API surface

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/run/[case]` | Seed thread + invoke. If thread already mid-execution (interrupt active), return current snapshot unchanged (idempotent). |
| GET | `/api/run/[case]` | Snapshot current thread state without advancing. Used for case-tab restoration. |
| POST | `/api/resume` | Resume a thread that's stopped at the human approval interrupt. Body: `{ case_id, decision: HumanDecision }`. |
| GET | `/api/policy/[doc]` | Return verbatim policy text + section index for the policy drawer. |

**`thread_id === case_id`** — one MemorySaver thread per case; case tabs in the
UI map directly to thread persistence. URL-keyed thread restoration survives
Vercel cold-start within a single warm container.

## Schema (Zod)

`src/lib/agent/schemas.ts` is the single source of truth. Highlights:

- **`PolicyCitation`** — `policy_doc` (enum of 7), `section`, `quote` (≤200 chars),
  `verified: boolean` (set by `validate_citations`).
- **`PolicyFlag`** — `severity` (info | warn | block), `issue`, `recipient` (which
  approver this routes to), and at least one citation.
- **`DecisionPacket`** — case_id, intake summary, missing items, risk tier,
  data class, budget check, TCV, duplicate check, flags, required approvers,
  recommended action (`approve_with_followup` | `escalate` | `block`),
  optional vendor draft (clearly DRAFT), internal ticket draft, audit trail of
  tool calls, optional `human_decision` (set after HITL).
- **`HumanDecision`** — `verdict` (approved | rejected | edit_and_rerun |
  request_followup), notes, decided_at/by, optional `edits_applied`.

The schema deliberately has **no field that can express "approved by the
agent"** or **"sent to vendor"**. Approval lives only on `human_decision`,
which the agent cannot write itself (only the `humanApprovalNode` consumes the
resume value). Vendor email is always `draft_vendor_email`, never "sent_email".

## Frontend

The workbench is one page, four logical zones:

1. **Persona rail** (240px left) — operator (Procurement) + 6 read-only
   recipient lenses. Switching to a recipient filters `policy_flags` by
   `recipient` and hides the operator-only ConfirmationCard buttons.
2. **Canvas header + case tabs** — case_001 / case_002 / case_003 pills drive
   `?case=00N` deep links and per-case state via React state keyed by case_id.
3. **Canvas body** — streams as the agent runs:
   PlanList → ToolAuditCard stack → DecisionPacketCard → ConfirmationCard.
4. **Ambient prompt pill** — small input at canvas bottom for `/run case_xxx`
   slash commands.

`Workbench.tsx` is the only stateful component. Children are pure presentational
(props in, callbacks out). `useEffect` runs one GET per case per session to
restore previously-decided state when switching tabs.

## HITL pattern

Inside `humanApprovalNode` (in `nodes.ts`):

```typescript
const verdict = interrupt({
  type: 'human_approval_required',
  case_id: state.case_id,
  decision_packet: state.decision_packet,
}) as HumanDecision;
```

`interrupt()` pauses the graph; the next `graph.invoke(new Command({ resume: X }))`
returns `X` as the value of that call. `/api/resume` accepts the operator's
verdict, casts it to `HumanDecision`, and routes via `postHumanRouter` to
either `classify_data_sensitivity` (edit_and_rerun) or `emit_final` (every other
verdict). One small idempotency wart: `/api/run` checks `(existing.next ?? []).length > 0`
and no-ops on re-POST so a stray `/run case_xxx` doesn't inject `'run'` into an
already-active interrupt.

## LLM provider switch

`activeProvider()` reads `LLM_PROVIDER`. Four modes:

- **`mock`** — graph nodes branch on `activeProvider() === 'mock'` and pull
  responses from `mocks.ts` keyed by `case_id`. No network, deterministic,
  free. Used for dev/CI/PRs.
- **`deepseek`** *(recommended for production demo)* — DeepSeek primary
  (`https://api.deepseek.com`, `deepseek-chat` default), wrapped in
  `Runnable.withFallbacks()` against an OpenRouter client when
  `OPENROUTER_API_KEY` is also set. The fallback fires automatically on any
  primary error (rate-limit, 5xx, timeout) — single demo URL keeps working
  through DeepSeek hiccups.
- **`deepseek-direct`** — DeepSeek only, no fallback. Useful when you want to
  fail loudly instead of silently switching to a free-tier model.
- **`openrouter`** — `ChatOpenAI` pointed at `https://openrouter.ai/api/v1`
  with `:free` models by default (`deepseek/deepseek-chat:free`, override via
  `OPENROUTER_MODEL`). Free, but rate-limited under load and subject to the
  Vercel 10s function timeout on cold queues.

Caller-side responsibility: `MockChatModel.invoke()` throws loudly so any node
that forgets to short-circuit on mock mode fails fast instead of silently
hitting the network.

The single LLM call site is `runLlmComposition` in `nodes.ts:524` — it
composes the five narrative fields of the `DecisionPacket` (intake summary,
policy flags with citations, recommended action, draft internal ticket,
vendor follow-up draft) from the deterministic facts the tools already
gathered. Citations are then verbatim-checked by `validate_citations` before
the human gate, so a fallback model with weaker quoting just produces more
`agent_citation_unverified` warn flags — never silent hallucinations.

## Hard product lines (SPEC §9 — where they're enforced)

| Constraint | Enforcement |
|---|---|
| Agent never approves spend | Schema has no agent-writable approval field; `human_decision` is only written by `humanApprovalNode` from the resume value. |
| Agent never sends external messages | Vendor email is `draft_vendor_email`. UI button is "Copy draft", not "Send". No SMTP, no mailto, no integration. |
| Agent never accepts contract language | No `contract_modifications` or `accepted_terms` field exists. Contract PDF is read-only input. |
| Agent never makes the final security/privacy decision | Security flags route to `recipient: "security"` and require human approver acknowledgment. The packet's `recommended_action` is a *recommendation*, not a decision. |

## Constraints from Vercel

- **10s function timeout** (Hobby tier) — all LLM calls stream so the timer
  resets per chunk. Worst case is a `:free` OpenRouter model under load; mock
  mode is the safety lane.
- **Ephemeral filesystem** — no SqliteSaver; we use `MemorySaver`. In-flight
  HITL state is lost on cold start. Documented as acceptable for a demo;
  productionization note covers the Postgres-backed checkpointer swap.

## Tracing (P1, optional)

Set `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT=vendor-triage`. Every node + tool
call appears in the LangSmith dashboard. Free observability for the reviewer.

## Fixture surfaces

Two case-shaped fixture surfaces sit side by side and are intentionally
hand-synced for the take-home. `src/lib/cases.ts` is a UI-only metadata
fixture — `vendor_name`, `short_name`, `acv_short`, `one_liner` — consumed by
the case-tab strip and canvas header so the operator can scan the queue
without invoking the agent. It is *not* ground truth: the agent never reads
it. Ground truth lives under `cases/<id>/` (`intake_xlsx`, `vendor_email_txt`,
`quote_csv`, `security_questionnaire_md`, `contract_pdf`) and is the only
input `parse_inputs` sees. The two are kept in sync by hand for the three
demo cases; production swap is a Workday / NetSuite vendor read against the
real vendor master, which removes the hand-sync entirely.
