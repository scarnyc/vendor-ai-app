# Vendor AI — Claude Code Working Notes

Take-home: a vendor onboarding triage agent. Reads a case package, evaluates
against seven internal policies, emits a `DecisionPacket` for one human
(Priya, the procurement owner) to review, edit, approve, or reject.

## Read these first

- `SPEC.md` — product spec. **§9 contains the four hard product lines.**
- `DESIGN.md` — UI/UX requirements that drive `mock/` and the production
  build. If a component disagrees with DESIGN.md, the component is wrong.
- `mock/index.html` + `mock/architecture.html` — visual + state-graph
  references the implementation must match.
- Provided assets:
  - `cases/case_001/` … `case_003/` — vendor packages (xlsx · pdf · csv · md · txt)
  - `docs/*.md` — the seven policy docs the agent cites
  - `tools/` — `Agent process flow.png`, `budget_lookup.csv`, `vendor_register.csv`

## SPEC §9 hard product lines (do not break)

The agent **never** approves spend, **never** sends external messages,
**never** accepts contract language, **never** makes the final security or
privacy decision. Every code path, schema field, and UI button is designed
*against* these constraints. See `DESIGN.md §10` for the
hard-line → component → control mapping.

## Stack (planned — scaffold not yet in repo)

- Next.js 16 + React 19 + TypeScript 5 + Tailwind 4 (App Router)
- LangGraph.js + CopilotKit 1.56 + AG-UI (single Vercel deploy)
- Zod 4 schemas (Pydantic-equivalent; **no field can express "approved" or "sent"**)
- LLM provider switch: `mock` (AIMock for dev/CI) | `openrouter` (free `:free` models) | `deepseek-direct` (Anthropic-compat endpoint)
- `MemorySaver` checkpointer + URL-keyed thread (`?case=001&thread=<uuid>`) — Vercel ephemeral fs
- Streaming nodes — Vercel Hobby's 10s timeout resets per chunk

## Where things live (target layout)

```
src/app/                 — Next.js App Router pages + api/copilotkit/route.ts
src/components/          — Rail, CaseTabs, CanvasShell, PlanList,
                           ToolAuditCard, DecisionPacketCard,
                           ConfirmationCard, CitationChip, PolicyDrawer,
                           AmbientPromptPill (see DESIGN.md §5)
src/lib/agent/           — graph.ts, nodes.ts, tools.ts (the 8 PNG-named
                           tools), schemas.ts (Zod), policies.ts,
                           prompts.ts, llm.ts (provider switch)
cases/ docs/ tools/      — provided assets (read-only)
mock/                    — static HTML mocks (visual + state-graph reference)
```

## The 8 PNG-named tools (deterministic — no LLM inside)

`validate_required_documents` · `lookup_budget` · `check_existing_vendor`
· `calculate_total_contract_value` · `classify_data_sensitivity` ·
`determine_required_approvals` · `draft_vendor_followup` ·
`escalate_to_human`

Names are load-bearing — the take-home rubric checks for these exact
names. Don't rename, don't merge, don't omit. Tool I/O contracts are in
`mock/architecture.html` (tool catalog table).

## Hot rails

- **Secrets** — `OPENROUTER_API_KEY`, optional `DEEPSEEK_API_KEY` live in
  Vercel env vars. `.env.example` ships placeholders only. Never commit
  real keys; never paste them into the repo.
- **Citations are verbatim** — `validate_citations` node enforces every
  flag's quoted policy text is a substring of the cited doc. If you're
  paraphrasing, the guard will flag the run.
- **HITL is the only writer** — no node may emit a final packet, send a
  message, or mark anything approved without a `Command(resume=...)` from
  the operator. Adding a "Send" button anywhere is a SPEC §9 violation
  (see DESIGN.md §5.8 forbidden behavior).
- **One operator, six recipients** — Procurement (Priya) is the only
  persona that can drive the agent. The other six lenses are read-only
  preview. Adding action buttons to recipient lenses is scope creep and a
  policy violation (see DESIGN.md §2).
- **Humanized UI copy** — no snake_case, no raw JSON, no curly braces in
  user-visible strings. Audit cards use `<dl>` label/value (see DESIGN.md
  §5.6 worked example).

## Commands (will land as the build progresses)

| Command | Purpose |
|---|---|
| `pnpm dev` | Local dev server with AIMock LLM (no API costs) |
| `LLM_PROVIDER=openrouter pnpm dev` | Local dev hitting OpenRouter free models |
| `pnpm test` | Unit + golden-case tests (3/3 cases produce policy-aligned verdicts) |
| `pnpm build && pnpm start` | Production build verification |
| `vercel deploy` | Push to Vercel (env vars set in dashboard) |

## Stop-chain before commits

1. Verify the §9 hard lines are intact — grep for any new "Send" /
   "Approve" / "Sent" / "Approved" string near button copy or schema
   fields. Each new instance needs a paired control.
2. Verify `validate_citations` would still pass — no paraphrased quotes
   slipped into prompts or examples.
3. Verify no real API key leaked into a committed file
   (`grep -rE 'sk-|nvapi-|or-' . --include='*.ts' --include='*.tsx' --include='*.json'`).
4. Verify the mock + DESIGN.md still agree (visual diff if you touched
   either).

## Things this repo is NOT

- A multi-tenant production system (auth, RBAC, real connectors are
  productionization concerns documented separately).
- A chat application. The DecisionPacket is the artifact; the ambient
  prompt pill is for ad-hoc Q&A only — not a chat feed.
- A vendor self-service portal. The vendor never logs in.
- A 4–6 hour project that needs polish over judgment. The rubric weights
  *judgment, architecture, and practical execution* — not pretty pixels.
  Time-box accordingly.
