# Vendor AI — Design Specification (v0.6)

> Source of truth for `mock/index.html` and the production `apps/web/` build.
> Companion to `SPEC.md` (product) and `mock/architecture.html` (state graph).
> When DESIGN.md disagrees with the mock, the mock is wrong.

---

## 1. Purpose

Vendor AI is a single-operator workbench for procurement triage. It reads a
vendor onboarding case package (intake xlsx, vendor email, quote csv,
security questionnaire, contract pdf), evaluates it against seven internal
policies, and renders a pre-filled **DecisionPacket** for one human —
**Priya, the procurement owner** — to review, edit, approve, or reject.

Six recipient personas (Business Owner, Legal, Security, VP Finance, CFO,
Executive) get **read-only preview lenses** that show what the routed packet
would look like to them. They cannot drive the agent. The vendor never
appears in this UI.

**Hard product lines** (SPEC §9 — every component below is designed
*against* these constraints):

- The agent never approves spend.
- The agent never sends external messages.
- The agent never accepts contract language on behalf of the company.
- The agent never makes the final security or privacy decision.

Anything in the UI that could be misread as the agent crossing one of these
lines is a design bug.

---

## 2. Personas & Permissions

| Persona | Role | Operator? | Can run agent? | Can edit packet? | Can approve / reject? | Sees draft? |
|---|---|---|---|---|---|---|
| **Procurement (Priya)** | Owner of intake triage | ✓ | ✓ | ✓ | ✓ | ✓ (can copy) |
| Business Owner | Cost-center owner | — | ✗ (button hidden) | ✗ | ✗ (banner: *Preview — recipient cannot act here*) | ✓ (can copy) |
| Legal | DPA / contract clauses / AI-training opt-out | — | ✗ | ✗ | ✗ | ✓ (can copy) |
| Security | SOC 2 / data class / restricted-data / subprocessors | — | ✗ | ✗ | ✗ | ✓ (can copy) |
| VP Finance | Spend ≥ $50k | — | ✗ | ✗ | ✗ | ✓ (can copy) |
| CFO | Spend ≥ $100k OR term > 3 yr | — | ✗ | ✗ | ✗ | ✓ (can copy) |
| Executive | High-risk escalation path (case 003 pattern) | — | ✗ | ✗ | ✗ | ✓ (can copy) |

**Rationale for one operator:** `procurement_policy.md` §"Approval routing"
states *"Procurement owns initial triage for all new vendors."* Recipients
act in their own systems (Slack, email, Workday) once Priya routes to them
— never inside Vendor AI. Inventing operator views for them is scope creep
and would imply approval flows the agent doesn't own.

---

## 3. Design Tokens

### 3.1 Color (OKLCH dark theme)

| Token | Value | Use |
|---|---|---|
| `--bg` | `oklch(0.145 0 0)` | App background |
| `--surface` | `oklch(0.205 0 0)` | Rail, panels, cards |
| `--surface-2` | `oklch(0.255 0 0)` | Stat tiles, audit-card body, recessed inputs |
| `--surface-3` | `oklch(0.305 0 0)` | Hover surfaces |
| `--border` | `oklch(0.32 0 0)` | Strong dividers |
| `--border-soft` | `oklch(0.26 0 0)` | Default borders |
| `--text` | `oklch(0.96 0 0)` | Primary text |
| `--text-dim` | `oklch(0.72 0 0)` | Secondary text |
| `--text-mute` | `oklch(0.55 0 0)` | Tertiary, labels, captions |
| `--accent` | `#8E89FF` | Primary actions, focus rings, status dots |
| `--accent-soft` | `rgba(142, 137, 255, 0.14)` | Lens chip, primary-tinted backgrounds |
| `--success` | `oklch(0.78 0.16 155)` | Done steps, "ok for ACV" |
| `--warn` | `oklch(0.82 0.16 80)` | Medium-risk, missing-but-not-blocking |
| `--danger` | `oklch(0.72 0.21 25)` | Block-severity flags, reject button |
| `--info` | `oklch(0.78 0.13 230)` | Data-class chip, informational flags |

Severity → flag mapping is **fixed**: `block` → danger bar, `warn` → warn
bar, `info` → info bar. Don't introduce a fifth severity.

### 3.2 Typography

| Token | Font | Use |
|---|---|---|
| `--font-chat` | Plus Jakarta Sans (400/600/700) | Display: packet title, brand, headlines |
| `--font-ui` | Geist (400/500/600/700) | Body, buttons, labels — the workhorse |
| `--font-mono` | Geist Mono (400/500) | Case IDs, vendor IDs, cost centers, dollar figures inside stat tiles |

Body size is `14px`, line-height `1.5`. Section labels are `11px` uppercase
with `0.08em` letter-spacing. **No font smaller than 10.5px** anywhere.

### 3.3 Spacing & Radius

- Base unit: 4px. Common steps: 4 / 6 / 8 / 10 / 12 / 14 / 18 / 22 / 28.
- Radius: `--radius-sm: 6px` (chips, inputs, small buttons), `--radius: 10px`
  (cards, tool-call panels), `--radius-lg: 14px` (the DecisionPacket frame).
- Card padding: `16-20px` outside, `12-14px` inside nested elements.
- Canvas content max-width: **880px**, centered. Wider feels like a CRUD app;
  narrower wastes the screen on a workbench.

### 3.4 Shadow

`--shadow-card: 0 1px 0 oklch(0.30 0 0 / 0.4), 0 12px 40px -16px rgba(0,0,0,0.6)`
— a single elevation level for the DecisionPacket. Tool-call cards and audit
cards stay flat (border-only). Don't introduce a second elevation tier.

### 3.5 Motion

- Plan-step "active" dot pulses at 1.4s ease-in-out (signals streaming).
- Disclosure carets rotate 90° on `<details open>`, 0.15s ease.
- Hover transitions on rail items + buttons are instant — no lingering fade.
- **No scroll-jacked animations**, no parallax, no toast slide-ins. This is
  a working surface, not a marketing page.

---

## 4. Layout

```
┌────────────────┬──────────────────────────────────────────────────────────┐
│                │  Canvas header (case title · vendor meta · status pill)  │
│  Persona Rail  ├──────────────────────────────────────────────────────────┤
│   240px        │  Case tabs   [ 001 Northstar ] [ 002 Workspace ] [ 003 ] │
│                ├──────────────────────────────────────────────────────────┤
│  ─────────     │                                                          │
│  Operator      │   PlanList (collapsed once done)                         │
│   Procurement  │   Tool audit cards (humanized, default-collapsed)        │
│                │   DecisionPacket                                         │
│  Recipients    │     ├ Stats (ACV / TCV / budget headroom)                │
│   Business     │     ├ Intake summary                                     │
│   Legal        │     ├ Policy flags (grouped by recipient)                │
│   Security     │     ├ Required approvers                                 │
│   VP Finance   │     ├ Recommended action                                 │
│   CFO          │     └ HITL ConfirmationCard (inline, bottom of packet)   │
│   Executive    │                                                          │
│                ├──────────────────────────────────────────────────────────┤
│                │  Ambient prompt pill (collapsed default)                 │
└────────────────┴──────────────────────────────────────────────────────────┘
```

Single screen. No second route. No right sidecar. Switching cases swaps the
artifact in place. Switching lenses re-filters flags + adjusts the system
prompt for the ambient pill — it does **not** re-run the agent.

---

## 5. Component Inventory

Each component spec includes: **purpose**, **required behavior**, **forbidden
behavior**. Forbidden behavior calls out the way each component could
quietly violate SPEC §9 if built carelessly.

### 5.1 Rail

- **Purpose:** persona lens switcher.
- **Items:** 1 brand block + 1 operator (Procurement) + 6 recipients = 7
  rail items. **No "All Cases" item** — case selection moves to canvas tabs.
- **Required:** text-only labels (no icons); operator item carries an
  "operator" lock chip; recipient items carry a "read-only" lock chip;
  selected item uses `--accent-soft` background + `aria-current="true"`.
- **Forbidden:** clicking a recipient lens must NOT enable Approve/Reject.
  If the button shows up, the build is wrong.

### 5.2 Case Tabs

- **Purpose:** select which of the 3 cases is active.
- **Required:** horizontal segmented control directly below the canvas
  header. Selected pill drives `?case=00N` for shareable links. Three pills:
  `case_001 · Northstar`, `case_002 · Workspace Depot`, `case_003 · TalentPulse`.
  Each shows the vendor name in `--font-ui` plus the ACV in `--font-mono`.
- **Forbidden:** auto-running on tab switch. Tabs load metadata only; the
  Run button (§5.4) is the only thing that fires the LangGraph stream.

### 5.3 Canvas Header

- **Purpose:** name the artifact in view + show its status.
- **Required:** vendor name (`--font-chat` 15px), case meta line in
  `--font-mono`, status pill on the right.
- **Status pill copy:** `Awaiting input` (pre-run) · `Working` (streaming) ·
  **`Ready for review`** (HITL gate) · `Decided` (post-resume).
- **Lens chip** (`viewing as: <persona>`) appears **only on persona lenses**,
  not on the operator default. Avoids visual noise when Priya is acting.
- **Forbidden:** showing the lens chip when in operator view. Showing
  "Approved" or "Sent" anywhere — both states are not expressible.

### 5.4 Run Button

- **Purpose:** explicit operator-driven trigger. Selecting a case loads
  metadata only; the agent does nothing until Run is pressed.
- **Required:** a primary-styled button rendered inside the canvas above
  the PlanList region when `run_status === "await_run"`. Disappears once
  the stream starts; replaced by the live PlanList.
- **Forbidden:** any auto-run on case-tab switch. Auto-run would defeat
  cost discipline and surprises the operator.

### 5.5 PlanList

- **Purpose:** show the 8 PNG state-graph nodes streaming as the agent runs.
- **Required:** node states are `done` (green dot), `active` (pulsing accent
  dot), `pending` (hollow). Once the run completes, the entire list collapses
  to a single line: *"Triage complete · 8 of 8 steps · completed in N.Ns."*
  Click to re-expand.
- **Forbidden:** hiding a failed step. If a node errors, surface it with a
  danger-bar replacement card and route to `escalate_to_human`.

### 5.6 Tool Audit Cards (the §16.5 humanization rule)

- **Purpose:** prove to Priya which tool returned which fact. Audit, not
  debug.
- **Required content shape** — a small typeset card:
  - **Title:** humanized in `--font-ui` 13.5px (e.g. *"Budget lookup"*,
    *"Existing-vendor check"*, *"Data-sensitivity classification"*).
  - **Body:** `<dl>` grid of label → value rows. Values use `--font-mono`
    only for IDs and dollar figures; everything else is `--font-ui`.
  - **Footer chip:** if the tool's result drove a flag, link to the
    citation that flag opened (e.g. budget-lookup → finance_approval_matrix).
- **Forbidden in user-visible text:** raw JSON, curly braces, double quotes,
  snake_case identifiers, function-call syntax (`tool_name(arg=...)`).
  snake_case stays in code; the UI translates. Default-collapsed.

**Worked example — Budget lookup card:**

| Label | Value |
|---|---|
| Cost center | Revenue Operations (`REVOPS-042`) |
| Annual budget remaining | $120,000 |
| Owner | Maya Patel |
| Headroom after this contract | $35,000 |
| Verdict | Within budget |

Footer chip: *Cited by → Finance: ACV crosses $50k threshold*.

### 5.7 DecisionPacket Card

- **Purpose:** the artifact Priya reviews.
- **Required regions, in order:**
  1. **Header** — title, risk badge, data-class badge.
  2. **Stat grid** — 3 tiles: ACV, TCV, budget headroom.
  3. **Intake summary** — 1 short paragraph, ≤200 words, plain prose.
  4. **Policy flags** — list, grouped by recipient persona (`→ Security`,
     `→ Legal`, etc.). Each flag has a severity bar, the issue text, and
     citation chips.
  5. **Required approvers** — chip list.
  6. **Recommended action** — accent-bordered banner with one of three
     verbs: *Approve with follow-up* · *Escalate* · *Block*.
- **Forbidden:** any field that expresses "approved" or "sent" pre-HITL.
  Per Zod schema, `human_decision` is `null` until the operator clicks.

### 5.8 HITL ConfirmationCard

- **Purpose:** the gate. Nothing leaves the agent without this.
- **Required:**
  - **Header copy:** **"Additional approval required"** (replaces
    v0.5's "Human approval required" — clearer that this is a step
    in a known process, not a roadblock).
  - **Subhead:** "Review, edit, then choose an action. The agent will not
    act without you."
  - **Editable fields:** risk-tier select, add-an-approver select,
    draft vendor email textarea (labeled **"Draft · not sent"**).
  - **Buttons, in order:**
    1. **Approve recommendation** — primary, accent fill.
    2. **Copy vendor draft** — neutral, copies the draft to clipboard.
       *No mailto, no Send button.*
    3. **Edit & re-run** — warn-tinted; re-runs the LLM-driven nodes
       only (classify → approvals → packet → guard → HITL). Deterministic
       tools short-circuit via memoized state.
    4. **Reject + escalate** — danger-tinted; calls `escalate_to_human`
       with Priya's reason, marks packet rejected, badge flips to
       "Escalated". Nothing leaves the app.
- **Forbidden:** a "Send" button of any kind. A button labeled in a way
  that implies the agent itself emits messages. A path that resolves the
  HITL without an explicit operator click.

### 5.9 Citation Chip + Policy Drawer

- **Purpose:** prove no-hallucination — every flag's quoted policy text is
  a verbatim substring of the cited doc (enforced by `validate_citations`
  node, see §13 finding #2).
- **Required:** chip in `--font-mono` 11px, accent-tinted; click opens a
  global slide-over showing the policy doc with the cited section
  highlighted.
- **Forbidden:** chips that don't open the drawer. Citations to docs not in
  the 7-policy set. Paraphrased quotes.

### 5.10 Ambient Prompt Pill

- **Purpose:** ad-hoc Q&A without a chat feed.
- **Required:** small input docked at canvas bottom, default-collapsed to
  one line. On focus, a slash-menu surfaces: `/run case_00N`, `/explain
  <flag>`, `/show audit`. Replies appear as ephemeral overlay above the
  pill, **not** as a persistent message log.
- **Forbidden:** turning into a chat feed. If responses persist past the
  next user input, the pattern has drifted.

---

## 6. Empty / Loading / Error States

| State | Surface | Copy |
|---|---|---|
| No case selected (cold load) | Canvas body | *"Pick a case to begin."* + 3 case tabs highlighted. |
| Case loaded, agent not run | Canvas body | Run button + intake file inventory list (5 files: present ✓ / missing ✗). |
| Agent streaming | PlanList | Active node pulses. Tool cards appear as each tool returns. |
| HITL gate | ConfirmationCard | Header *"Additional approval required"*. |
| Decided (approved / rejected / escalated) | Status pill flips, ConfirmationCard collapses | *"Decided by Priya · HH:MM"* stamp. |
| Tool error | Replaces tool card | Danger bar + *"Could not parse contract.pdf — escalating."* + auto-route to `escalate_to_human`. |
| Cold-start mid-HITL (Vercel ephemeral fs) | Canvas | *"Session expired — reload to resume."* + re-hydrates from `?case=00N&thread=<uuid>`. |

---

## 7. Accessibility

- Focus ring: `2px solid var(--accent)` with `2px` outline-offset. Visible
  on every interactive element. Don't suppress.
- `aria-current="true"` on the selected rail item and case tab.
- `role="region"` + `aria-label` on the ConfirmationCard.
- Status pill is `<span>` with semantic text — not color-only. Color
  reinforces, never conveys.
- Tab order: rail → case tabs → canvas content (top-to-bottom) → ambient
  pill. Skip-to-content link sits before the rail.
- Min target size: 32×32 for icon-only controls, 36px tall for text buttons.
- Contrast: all body text ≥ 4.5:1; muted captions ≥ 3:1 against their
  background tier.
- Reduced motion: the active-step pulse uses `@media (prefers-reduced-motion)`
  to fall back to a solid dot. No essential information conveyed by motion.

---

## 8. Copy Rules

- **No snake_case** in user-visible strings. `lookup_budget` → *"Budget
  lookup"*. `validate_required_documents` → *"Required documents check"*.
- **No raw JSON** in audit cards. Use the `<dl>` label/value pattern.
- **Drafts are always labeled** — "Draft · not sent" on every generated
  message, per `communication_policy.md` §"Human approval".
- **Verbs in HITL buttons** are operator-actions, not agent-actions.
  *"Approve recommendation"* (Priya approves), not *"Send for approval"*.
  *"Copy vendor draft"* (Priya copies), not *"Send to vendor"*.
- **Status copy** is a noun: *Working*, *Ready for review*, *Decided*,
  *Escalated*. Avoid *"Done"* — it implies the agent finished the deal.

---

## 9. State Graph Hooks (companion to `mock/architecture.html`)

Two structural changes from v0.5:

1. **`await_run` initial state** — precedes `parse_inputs`. Resolved by an
   operator `Command(resume="run")` from the §5.4 Run button.
2. **Edit-and-re-run loop edge** — from HITL back into
   `classify_data_sensitivity`. Carries Priya's edited context as
   `forwardedProps`. Re-runs only the LLM-driven downstream nodes
   (classify → approvals → prepare_packet → validate_citations → HITL).
   Deterministic tools (budget, vendor, TCV) short-circuit via memoized
   state because their inputs haven't changed.

`validate_citations` and the HITL gate stay unchanged. **No new edge emits
an external message or accepts contract terms** — SPEC §9 enforcement holds
end-to-end.

---

## 10. SPEC §9 Enforcement — UI-Level Checklist

The four hard product lines, mapped to the components that could violate
each one and the design control that prevents it:

| Hard line | Risk component | Control |
|---|---|---|
| Never approve spend | Recommended-action banner + HITL primary button | Both label the *recommendation*, not a system act. The Zod schema's `human_decision` field is `null` until the operator clicks. |
| Never send external messages | Vendor draft textarea + HITL action buttons | Only "Copy vendor draft" — no Send. Draft always carries the *"Draft · not sent"* label. No mailto, no SMTP integration. |
| Never accept contract language | Policy-flag UI + Legal lens | Legal-routed flags surface required language items; the UI never offers an "accept clause" affordance. The agent only flags. |
| Never make final security/privacy decision | Risk badge + Security lens | Risk tier is editable (operator overrides agent); recipient lenses are read-only. The agent labels; Priya decides. |

If a future change introduces a button, banner, or copy that contradicts
the table above, the change is rejected regardless of how convenient it
makes the UX.

---

## 11. Out of Scope (so we don't accidentally drift)

- Multi-tenant theming.
- A real chat feed.
- Recipient operator views (Legal cannot act inside Vendor AI; they act in
  their own systems once Priya routes).
- Vendor self-service portal.
- Email-in / Slack-in case intake — folder drop only for v1.
- Auth / RBAC — productionization concern, not v1.
- Persistent state across cold starts — `MemorySaver` + URL-keyed thread
  is acceptable for the demo; Postgres swap is in `PRODUCTIONIZATION.md`.

---

## 12. Open Design Questions

- **OQ-D1:** Should the ambient pill expose a `/route to <persona>` slash
  command that pre-fills a routing email draft? Pulls work into the
  workbench; risks duplicating what Slack/Workday already do. Defer to v2.
- **OQ-D2:** Audit cards default-collapsed vs first-expanded — first run is
  high-trust-building (Priya wants to see what the agent saw); subsequent
  runs are noise. Compromise: first audit card auto-expands, rest collapsed.
  Validate with first user-test session.
- **OQ-D3:** Citation drawer slide direction — right-to-left feels native on
  desktop but cuts off the recommendation banner during review. Bottom
  sheet keeps the packet in view but feels mobile. Pick desktop slide-from-
  right; revisit if Priya ever runs this on a laptop in landscape narrow.

---

## Change Log

- **v0.6** (2026-05-12) — Brand "Vendor AI"; rail icons removed; case-tab
  pills replace All-Cases lens; explicit Run button; humanized audit cards
  (no JSON, no snake_case in UI); copy-only vendor draft handoff;
  HITL header *"Additional approval required"*; state graph adds
  `await_run` + edit-and-re-run loop.
- **v0.5** (earlier) — Canvas-first pivot; Vercel single-deploy;
  OpenRouter + AIMock + DeepSeek-direct provider switch.
- **v0.4** — Chat-centric single view, AI PM by Design bundle reuse
  (now retired).
