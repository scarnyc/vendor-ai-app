# Vendor AI — Procurement Workbench

> The agent never approves spend, never sends external messages, never accepts contract language, never makes the final security or privacy decision.

That sentence is SPEC §9. It's the reason this prototype is interesting and
the reason the schema, the prompts, and every button in the UI were designed
the way they were. A vendor-onboarding triage agent that ships *recommendations*
to one named human (Priya, the procurement owner), then stops. The agent reads
five document types per case, walks fourteen LangGraph nodes against seven
internal policy docs, and produces an editable `DecisionPacket`. Priya
approves, edits, rejects, or asks for a follow-up. Nothing leaves the building
without her click.

## What you'll see when it runs

1. Land on `localhost:3000`, click the **Case 001** pill, hit **Run agent**.
2. Audit cards stream in one at a time as the deterministic tools fire
   (`validate_required_documents`, `lookup_budget`, `check_existing_vendor`,
   …). No two-minute JSON blob. No spinner-of-faith.
3. The `DecisionPacketCard` renders with a verdict, a recommended action, and
   every flag citing the policy doc + section + verbatim quote it came from.
   Click a citation to open the policy drawer.
4. The HITL confirmation card appears inline: Approve, Reject, Request
   follow-up, Escalate. The graph is paused on `interrupt()` until you click.

## Setup

Three paths. Pick one.

**(a) Zero-config — mock LLM, no API keys, deterministic by case_id.**

```bash
pnpm install
pnpm dev
# open http://localhost:3000
```

Mock mode is the dev default. Fixtures are keyed by `case_id`, so the
verdicts match the eval golden set exactly.

**(b) Real LLM via `.env.local` — Anthropic Sonnet 4.6 primary, DeepSeek
fallback.**

```bash
pnpm install
cp .env.example .env.local
# edit .env.local:
#   ANTHROPIC_API_KEY=sk-ant-...
#   DEEPSEEK_API_KEY=sk-...          # optional but recommended for live demo
#   LLM_PROVIDER=anthropic
pnpm dev
```

The Anthropic key must be the *console* key (`sk-ant-…`), not an OAuth token.
The OAuth tokens in some envchain namespaces (`hermes-llm/ANTHROPIC_TOKEN`)
are *not* compatible with the LangChain Anthropic binding.

**(c) envchain on macOS — my preferred setup, keeps keys out of files.**

```bash
brew install envchain
envchain --set vendor-ai ANTHROPIC_API_KEY DEEPSEEK_API_KEY LLM_PROVIDER
# at the prompt for LLM_PROVIDER type: anthropic
envchain vendor-ai pnpm dev
```

envchain reads from macOS Keychain and injects env vars into the child
process. The dev server logs the active provider on startup so you can
confirm the right key is being used.

## Provider switch

`LLM_PROVIDER` selects the LLM lane. The same switch drives `pnpm dev`,
`pnpm eval:dataset`, and the Vercel deploy.

| `LLM_PROVIDER` | Needs | Behavior |
|---|---|---|
| `mock` *(default when unset)* | nothing | Deterministic fixtures from `mocks.ts` keyed by `case_id`. No network. |
| `anthropic` *(recommended)* | `ANTHROPIC_API_KEY`; `DEEPSEEK_API_KEY` for fallback | Anthropic Sonnet 4.6 with extended thinking via native Structured Outputs. When the DeepSeek key is present, `composeWithFallback` routes there on Anthropic 429 / spend-cap / 5xx without changing config. |
| `anthropic-only` | `ANTHROPIC_API_KEY` | Anthropic, no fallback. Used by `pnpm eval:dataset` so eval failures surface as eval failures. |
| `deepseek-only` | `DEEPSEEK_API_KEY` | DeepSeek `deepseek-chat`. Cost lane. Legacy aliases `deepseek` and `deepseek-direct` map here. |
| `openrouter` | nothing required | `:free` model via OpenRouter (`deepseek/deepseek-chat:free` default). Keyless escape hatch; rate-limited under load. |

Model overrides: `ANTHROPIC_MODEL`, `DEEPSEEK_MODEL`, `OPENROUTER_MODEL`,
`ANTHROPIC_EFFORT` (`low` | `medium` | `high`), `ANTHROPIC_THINKING_BUDGET`.
Set `LLM_DEBUG_BINDING=1` to log the wire-format binding payload once per
call (verify both `thinking` and `output_config.format.type === 'json_schema'`
are present).

## Three gotchas worth surfacing

1. **envchain wins over `.env.local`.** Next.js loads dotenv before envchain
   injects, but envchain's child-process env merges in *last* and overwrites.
   If you set `LLM_PROVIDER=anthropic` via envchain and `LLM_PROVIDER=mock`
   in `.env.local`, the server runs Anthropic. The startup log prints the
   active provider; trust the log over the file.
2. **The Anthropic *console* key is what works.** `sk-ant-…` from the
   Anthropic console. OAuth tokens issued through Claude Code or partner
   integrations are not compatible with the LangChain binding and will 401
   on first call.
3. **`LLM_PROVIDER` unset on Vercel silently fixtures every request.** The
   default is `mock`. If you deploy without setting `LLM_PROVIDER` in
   **Project Settings → Environment Variables**, prod serves the same
   deterministic fixtures the dev box does. Not a bug; a footgun.

## Evals

```bash
envchain vendor-ai bash -c 'LLM_PROVIDER=anthropic-only pnpm eval:dataset'
# target ≥14/15 across the 3 cases
node scripts/qa-packet-render.mjs
# manual Playwright smoke for the Decision Packet render
```

Latest run (2026-05-13, `anthropic-only`): **14/15 (93%)**. Per-case latency
case_001 174s · case_002 44s · case_003 140s, mean 119s, p95 ~170s. The
single thinking-adaptive structured call is the bottleneck. The specific
levers I'd pull next live in `PRODUCTIONIZATION.md` under "Next steps —
accuracy and latency."

## What's where

```
src/app/                 Next.js App Router + /api endpoints
  api/run/[case]/        POST: seed + drive graph (SSE); GET: state snapshot
  api/resume/            POST: Command(resume=HumanDecision) (SSE)
  api/policy/[doc]/      GET: verbatim policy text for the drawer
src/components/          Pure presentational React (Workbench is the only stateful one)
src/lib/agent/
  graph.ts               14-node StateGraph + MemorySaver
  nodes.ts               node bodies; LLM nodes branch on activeProvider()
  tools.ts               the 8 PNG-named deterministic tools
  schemas.ts             Zod source of truth (one-to-one with the spec's Pydantic)
  policies.ts            loads docs/*.md into prompts + drawer
  llm.ts                 5-mode provider switch + Anthropic→DeepSeek composer
  mocks.ts               deterministic fixtures by case_id
cases/                   provided assets — case_001, 002, 003
docs/                    provided assets — 7 policy markdown files
tools/                   provided assets — budget_lookup.csv, vendor_register.csv, PNG flow
mock/                    static HTML mocks — visual + state-graph reference
```

## Read these next

- [`SPEC.md`](./SPEC.md) — product spec. §9 is the four hard product lines.
- [`ARCHITECTURE.md`](./ARCHITECTURE.md) — system view: state graph, schema,
  HITL pattern, where the §9 constraints are enforced in code.
- [`DESIGN.md`](./DESIGN.md) — UI contracts per component. If a component
  disagrees with this file, the component is wrong.
- [`PRODUCTIONIZATION.md`](./PRODUCTIONIZATION.md) — the gap between
  prototype and production. Four phases, deliberately conservative.

## Verify before you commit

```bash
pnpm typecheck     # tsc --noEmit, required before every commit
pnpm build         # next build, catches App Router edge cases
pnpm test          # unit + integration; the integration tests gate DESIGN.md contracts
```

Then read SPEC §9 once more and check you haven't added anything that
contradicts it.
