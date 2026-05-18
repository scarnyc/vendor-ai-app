# Architecture

## One-paragraph summary

One Next.js 16 app on Vercel. The frontend is a canvas-first workbench
(React 19 + Tailwind 4) talking to four endpoints under `/api/`. The two
write endpoints (`POST /api/run/[case]`, `POST /api/resume`) return
**AG-UI events over Server-Sent Events** so the operator sees tool audit
cards stream in one-by-one rather than waiting two minutes for a single
JSON blob. Those endpoints drive a LangGraph.js state machine of 14 nodes
that mirror the spec's PNG flow, and surface the agent's output as a
structured `DecisionPacket`. A human approval interrupt sits between
packet assembly and the final emit. Nothing leaves the agent without an
operator click. The whole TypeScript stack is intentional: it collapses
to one Vercel deploy and lets the state schema, the API contract, the
SSE event vocabulary, and the React props share a single Zod source of
truth.

## State graph

A live visual of this graph (color-coded nodes, edges, HITL gate) lives
at `mock/architecture.html`. Open it in a browser for the rendered view.

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
classify_data_sensitivity
  │
  ▼
determine_required_approvals
  │
  ▼
extract_candidate_clauses
  │  (heuristic clause indexer; keyword-density-ranked
  │   policy lines fed into the LLM's user message so it
  │   can quote verbatim; ≥99% verified citations target)
  ▼
prepare_decision_packet
  │
  ▼
validate_citations
  │
  ▼
human_approval
  │
  │ approved · rejected · escalated · follow_up
  ▼
emit_final ──► END
```

One structural change vs. the spec's original PNG (DESIGN §16.7):

1. **`await_run` initial state.** The operator's Run button issues
   `Command({ resume: "run" })` to get past it. This stops the graph from
   auto-running on every cold-start of a fresh thread.

An edit-and-re-run loop-back from `human_approval` to
`classify_data_sensitivity` was scoped but deferred. `postHumanRouter`
currently always routes to `emit_final`. The operator's "Edit & re-run"
affordance is tracked in `PRODUCTIONIZATION.md` ("Operator 'Edit'
affordance"). The schema reserves no state for it; if/when it lands it
will re-run only the LLM-driven downstream nodes and reuse the cached
deterministic tool outputs.

`validate_citations` runs after packet assembly and before the human
gate. It substring-checks every `PolicyCitation.quote` against the cited
policy file. Failures get demoted to `severity: "warn"` and an
`agent_citation_unverified` flag is appended. This closes the
no-hallucination loop.

## API surface

| Method | Path | Response | Purpose |
|---|---|---|---|
| POST | `/api/run/[case]` | **SSE event stream** | Seed thread + drive the graph until it pauses at the HITL gate. Streams AG-UI events; closes on `RUN_PAUSED_AWAITING_HUMAN`. Idempotent: a re-POST on an already-paused thread replays the cached event stream from the in-memory checkpoint. |
| GET | `/api/run/[case]` | JSON snapshot | Snapshot current thread state without advancing. Used for case-tab rehydration. |
| POST | `/api/resume` | **SSE event stream** | Resume a thread stopped at the human approval interrupt. Body: `{ case_id, decision: HumanDecision }`. Streams `RUN_RESUMED → STATE_DELTA(human_decision) → RUN_FINISHED`. |
| GET | `/api/policy/[doc]` | JSON | Verbatim policy text + section index for the policy drawer. |

The two SSE endpoints both pin `runtime = 'nodejs'` and
`dynamic = 'force-dynamic'` so Vercel doesn't buffer chunks. They share
a single async-generator core (`src/lib/agent/stream.ts: streamRun`)
that emits typed events. The route handlers are thin transport wrappers
around it, which also makes the streaming tests trivial (no HTTP
needed).

**`thread_id === case_id`.** One MemorySaver thread per case; case tabs
in the UI map directly to thread persistence. URL-keyed thread
restoration survives Vercel cold-start within a single warm container.

## AG-UI event protocol

The SSE endpoints stream events drawn from the AG-UI event vocabulary.
Typed builders live in `src/lib/agent/events.ts`, parsed against
`AgUiEventSchema` on the client for defense-in-depth. No CopilotKit
runtime; just the vocabulary, hand-rolled over SSE.

| Event | Carries | When |
|---|---|---|
| `RUN_STARTED` | `case_id`, `thread_id`, `provider` | First frame of `/api/run`. |
| `TOOL_CALL_START` | `tool_name`, `args` | Synthesized before each deterministic-tool node executes (via `NODE_TOOL_MAP`). |
| `TOOL_CALL_END` | `tool_name`, `result`, `duration_ms` | After each tool's `tools_called[]` record lands. |
| `STATE_DELTA` | `path: string[]`, `value` | Incremental state writes. `path` is an array of keys; `'-'` means array-append. |
| `STATE_SNAPSHOT` | `decision_packet` | Fires **exactly once**, post-`validate_citations`. The "packet now safe to render" semaphore that gates `DecisionPacketCard`. |
| `RUN_PAUSED_AWAITING_HUMAN` | *(no body)* | Terminal frame of `/api/run` when the graph hits `humanApprovalNode`. Deliberately *not* `RUN_FINISHED`; the event name keeps the §9 boundary structurally legible. |
| `RUN_RESUMED` | `human_decision` | First frame of `/api/resume`. |
| `RUN_FINISHED` | `final_state` | Terminal frame of `/api/resume` once `emit_final` runs. |
| `RUN_ERROR` | `code`, `message`, `recoverable` | Any unhandled error; the client surfaces a Retry affordance for recoverable codes. |

The reducer's source of truth is the `STATE_DELTA` stream;
`STATE_SNAPSHOT` is a one-shot render gate, not a state-rebuild source.
Server emits events through typed builders (`events.runStarted(...)`,
etc.); client parses each frame with `AgUiEventSchema.parse()`, so
schema drift surfaces as a Zod error rather than a silent UI hang.

The HITL pause closes the stream on the server side. The client opens a
*new* SSE stream against `/api/resume` once the operator clicks. No
keepalive on an idling interrupt; fewer Vercel function-minutes burned
sitting on a paused graph.

## Schema (Zod)

`src/lib/agent/schemas.ts` is the single source of truth. Highlights:

- **`PolicyCitation`**: `policy_doc` (enum of 7), `section`, `quote`
  (≤200 chars), `verified: boolean` (set by `validate_citations`).
- **`PolicyFlag`**: `severity` (info | warn | block), `issue`,
  `recipient` (which approver this routes to), and at least one citation.
- **`DecisionPacket`**: case_id, intake summary, missing items, risk
  tier, data class, budget check, TCV, duplicate check, flags, required
  approvers, recommended action (`approve_with_followup` | `escalate` |
  `block`), optional vendor draft (clearly DRAFT), internal ticket
  draft, audit trail of tool calls, optional `human_decision` (set
  after HITL).
- **`HumanDecision`**: `verdict` (approved | rejected | escalated |
  follow_up), notes, decided_at/by, optional `edits_applied`. The 4th
  state (`follow_up`) covers the most-common case-folder shape: vendor
  isn't bad, paperwork isn't done. See `PRODUCTIONIZATION.md` "The
  Grey Area" for why a 3-state model forced this decision into either
  premature-Approve or overstated-Reject.

The schema deliberately has **no field that can express "approved by
the agent"** or **"sent to vendor"**. Approval lives only on
`human_decision`, which the agent cannot write itself (only the
`humanApprovalNode` consumes the resume value). Vendor email is always
`draft_vendor_email`, never `sent_email`.

## Frontend

The workbench is one page, three logical zones:

1. **Canvas header**: vendor name, ACV, run status, provider chip.
2. **Case tabs**: case_001 / case_002 / case_003 pills drive `?case=00N`
   deep links and per-case state via React state keyed by case_id.
3. **Canvas body**: streams top-down as the agent runs. PlanList →
   ToolAuditCard stack → DecisionPacketCard (the artifact) →
   ConfirmationCard (HITL inline, operator-only).

`Workbench.tsx` is the only stateful component, and its single source of
state is the `useStreamingRun(caseId)` hook
(`src/hooks/useStreamingRun.ts`). The hook owns the SSE lifecycle: GETs
`/api/run/[case]` on mount for rehydration, opens the SSE POST stream
behind an `AbortController`, runs a small reducer that turns each AG-UI
event into `AgentState` shape, and surfaces a `phase` ('idle' |
'countdown' | 'streaming' | 'paused' | 'finished' | 'error') the
components key off. Children are pure presentational (props in,
callbacks out). A module-scoped in-flight set dedupes by `case_id` so
React 19 strict-mode's double-mount can't fire two paid POSTs per
arrival.

The first arrival to a case in a session arms the §5.2 3-second
countdown card via the same hook; cancelling reverts to the static
`▶ Run agent` button (§5.4). Return visits to a case whose state is
still in `MemorySaver` rehydrate instantly with no countdown.

The workbench is operator-only (Procurement) by deliberate scope; the
ambient prompt pill (bottom-of-canvas slash-command input) was likewise
removed before the v0.10 cycle. Neither changed the operator's
decision path. The recipient-lens preview views (filtered renders for
Legal, Security, CFO, etc.) are deferred per `PRODUCTIONIZATION.md`
"Recipient-lens preview views"; the canvas IS the artifact view today.

## HITL pattern

Inside `humanApprovalNode` (in `nodes.ts`):

```typescript
const verdict = interrupt({
  type: 'human_approval_required',
  case_id: state.case_id,
  decision_packet: state.decision_packet,
}) as HumanDecision;
```

`interrupt()` pauses the graph; the next
`graph.invoke(new Command({ resume: X }))` returns `X` as the value of
that call. `/api/resume` accepts the operator's verdict, casts it to
`HumanDecision`, and the graph routes via `postHumanRouter` to
`emit_final`. The router is a constant returner today; all four
verdicts (`approved`, `rejected`, `escalated`, `follow_up`) terminate
at `emit_final` (see `nodes.ts:postHumanRouter` and the
`addConditionalEdges('human_approval', …)` binding in `graph.ts`). The
edit-and-re-run loop-back back through `classify_data_sensitivity` is
documented as deferred (`PRODUCTIONIZATION.md` "Operator 'Edit'
affordance"). One small idempotency wart: `/api/run` checks
`(existing.next ?? []).length > 0` and no-ops on re-POST so a stray
`/run case_xxx` doesn't inject `'run'` into an already-active
interrupt.

## LLM provider switch

`activeProvider()` reads `LLM_PROVIDER`. Five modes:

- **`mock`**: graph nodes branch on `activeProvider() === 'mock'` and
  pull responses from `mocks.ts` keyed by `case_id`. No network,
  deterministic, free. Used for dev/CI/PRs. Default when `LLM_PROVIDER`
  is unset.
- **`anthropic`** *(recommended for production demo)*: Anthropic Claude
  Sonnet 4.6 with adaptive extended thinking via native Structured
  Outputs (`withStructuredOutput(schema, { method: 'jsonSchema' })`).
  When `DEEPSEEK_API_KEY` is also set, a hand-rolled
  `composeWithFallback` wraps the primary against a DeepSeek backup;
  catches Anthropic rate-limits, spend-cap 429s, or transient 5xx
  without changing config.
- **`anthropic-only`**: Anthropic, no fallback. Used by
  `pnpm eval:dataset` so eval failures surface as eval failures, not
  silently masked by a weaker fallback.
- **`deepseek-only`**: DeepSeek only, no fallback (`deepseek-chat`
  default, `https://api.deepseek.com`). Cost lane; legacy aliases
  `deepseek` and `deepseek-direct` map here.
- **`openrouter`**: `ChatOpenAI` pointed at
  `https://openrouter.ai/api/v1` with `:free` models by default
  (`deepseek/deepseek-chat:free`, override via `OPENROUTER_MODEL`).
  Keyless escape hatch; rate-limited under load and subject to the
  Vercel 10s function timeout on cold queues.

The Anthropic→DeepSeek composer (`composeWithFallback` in `llm.ts`)
catches both transport errors and `LlmStructuredOutputError` (a
Zod-refinement failure on the grammar-constrained output) and emits a
structured `llm.fallback.fired` JSON log so the signal is queryable in
LangSmith / Vercel log aggregation.

Caller-side responsibility: `MockChatModel.invoke()` throws loudly so
any node that forgets to short-circuit on mock mode fails fast instead
of silently hitting the network.

The single LLM call site is `runLlmComposition` in `nodes.ts:777`. It
composes the five narrative fields of the `DecisionPacket` (intake
summary, policy flags with citations, recommended action, draft
internal ticket, vendor follow-up draft) from the deterministic facts
the tools already gathered. Citations are then verbatim-checked by
`validate_citations` before the human gate, so a fallback model with
weaker quoting just produces more `agent_citation_unverified` warn
flags. Never silent hallucinations.

## Hard product lines (SPEC §9 — where they're enforced)

| Constraint | Enforcement |
|---|---|
| Agent never approves spend | Schema has no agent-writable approval field; `human_decision` is only written by `humanApprovalNode` from the resume value. |
| Agent never sends external messages | Vendor email is `draft_vendor_email`. UI button is "Copy draft", not "Send". No SMTP, no mailto, no integration. |
| Agent never accepts contract language | No `contract_modifications` or `accepted_terms` field exists. Contract PDF is read-only input. |
| Agent never makes the final security/privacy decision | Security flags route to `recipient: "security"` and require human approver acknowledgment. The packet's `recommended_action` is a *recommendation*, not a decision. |

## Constraints from Vercel

- **10s function timeout** (Hobby tier). All LLM calls stream so the
  timer resets per chunk. Worst case is a `:free` OpenRouter model
  under load; mock mode is the safety lane.
- **Ephemeral filesystem.** No SqliteSaver; we use `MemorySaver`.
  In-flight HITL state is lost on cold start. Documented as acceptable
  for a demo; productionization note covers the Postgres-backed
  checkpointer swap.

## Tracing (P1, optional)

Set `LANGSMITH_API_KEY` + `LANGSMITH_PROJECT=vendor-triage`. Every node
and tool call appears in the LangSmith dashboard. Free observability
for the reviewer.

## Fixture surfaces

Two case-shaped fixture surfaces sit side by side and are intentionally
hand-synced for the prototype. `src/lib/cases.ts` is a UI-only metadata
fixture (`vendor_name`, `short_name`, `acv_short`, `one_liner`),
consumed by the case-tab strip and canvas header so the operator can
scan the queue without invoking the agent. It is *not* ground truth:
the agent never reads it. Ground truth lives under `cases/<id>/`
(`intake_xlsx`, `vendor_email_txt`, `quote_csv`,
`security_questionnaire_md`, `contract_pdf`) and is the only input
`parse_inputs` sees. The two are kept in sync by hand for the three
demo cases; production swap is a Workday / NetSuite vendor read
against the real vendor master, which removes the hand-sync entirely.

Read `DESIGN.md` next for the UI contracts that turn every node above
into a visible component.
