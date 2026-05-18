#!/usr/bin/env node
// Manual streaming-UX smoke for PR #7. Drives Playwright directly so state
// survives across steps. Exercises the two unchecked test-plan items:
//
//   1. case_001 → countdown (or rehydrate) → cards stream → packet renders
//      → HITL gate → Approve → verdict banner
//   2. switch tabs to case_002 (fresh countdown) and back to case_001
//      (instant rehydrate, no countdown)
//
// NOT in CI — manual gate to verify the SSE/AG-UI wiring in a real DOM
// that the headless vitest suite can't see.
//
// Preconditions:
//   - `LLM_PROVIDER=mock pnpm dev` running on http://localhost:3000
//
// Usage:
//   node scripts/qa-streaming-smoke.mjs
//   QA_HEADED=1 node scripts/qa-streaming-smoke.mjs   # watch the run
//
// Exit codes: 0 on full pass, 1 on any assertion miss or timeout.

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARTIFACTS = path.join(ROOT, 'artifacts');
mkdirSync(ARTIFACTS, { recursive: true });

const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3000';
const HEADED = process.env.QA_HEADED === '1';
const PACKET_TIMEOUT_MS = Number(process.env.QA_PACKET_TIMEOUT_MS ?? 120_000);

function shot(page, name) {
  return page.screenshot({ path: path.join(ARTIFACTS, `smoke-${name}.png`), fullPage: true });
}

async function caseStatus(page, caseId) {
  return page.evaluate(async (id) => {
    const r = await fetch(`/api/run/${id}`);
    return r.json();
  }, caseId);
}

async function clickCaseTab(page, caseId) {
  const tab = page.locator('.case-tab', { hasText: caseId }).first();
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  await tab.click();
  await page
    .locator('.case-tab.active', { hasText: caseId })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });
}

async function waitForPacket(page, label) {
  const recommendedTitle = page.locator('.recommended-title').first();
  await recommendedTitle.waitFor({ state: 'visible', timeout: PACKET_TIMEOUT_MS });
  console.log(`[smoke] ${label} — Decision Packet rendered`);
}

async function assertContains(page, needle, label) {
  const n = await page.getByText(needle, { exact: false }).count();
  if (n === 0) throw new Error(`[smoke] ${label} — expected "${needle}" on page, found 0`);
  console.log(`[smoke] ${label} — "${needle}" present (${n})`);
}

async function step1Case001(page) {
  console.log('\n[smoke] === STEP 1: case_001 happy path ===');
  const status = await caseStatus(page, 'case_001');
  console.log(
    `[smoke] GET /api/run/case_001 → has_run=${status.has_run} interrupted=${status.interrupted}`
  );

  await clickCaseTab(page, 'case_001');

  if (!status.has_run) {
    // Cold thread — countdown should arm, then stream should start.
    const countdownText = page.getByText(/Auto-running triage for/i).first();
    const armed = await countdownText
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (armed) {
      console.log('[smoke] case_001 — countdown card armed');
      await shot(page, '01-case001-countdown');
    } else {
      console.log('[smoke] case_001 — no countdown observed (may have auto-started already)');
    }
  } else if (status.interrupted) {
    console.log('[smoke] case_001 — already paused at HITL; packet should rehydrate');
  } else {
    console.log('[smoke] case_001 — already finished; rehydrate path');
  }

  await waitForPacket(page, 'case_001');
  await assertContains(page, 'Risk:', 'case_001');
  await assertContains(page, 'Required approvers', 'case_001');
  await assertContains(page, 'Policy flags', 'case_001');
  await shot(page, '02-case001-packet');

  const refreshed = await caseStatus(page, 'case_001');
  if (refreshed.interrupted) {
    console.log('[smoke] case_001 — at HITL gate, clicking Approve');
    const approveBtn = page
      .getByRole('button', { name: /^Approve$/i })
      .first();
    await approveBtn.waitFor({ state: 'visible', timeout: 10_000 });
    await approveBtn.click();

    const banner = page.getByText(/Approved/i).first();
    await banner.waitFor({ state: 'visible', timeout: 30_000 });
    console.log('[smoke] case_001 — verdict banner showed "Approved"');
    await shot(page, '03-case001-approved');
  } else {
    console.log('[smoke] case_001 — already past HITL (likely prior Approved); skipping Approve');
    await shot(page, '03-case001-already-final');
  }
}

async function step2CaseSwitch(page) {
  console.log('\n[smoke] === STEP 2: tab switch case_002 → back to case_001 ===');

  const status002 = await caseStatus(page, 'case_002');
  console.log(
    `[smoke] GET /api/run/case_002 → has_run=${status002.has_run} interrupted=${status002.interrupted}`
  );

  await clickCaseTab(page, 'case_002');

  if (!status002.has_run) {
    // Verify the countdown card appears. Switch away BEFORE it expires so we
    // don't spend an actual LLM call when the dev server is on a real
    // provider — the multi-tab/case-switch safety in useStreamingRun cancels
    // the timer on cleanup.
    const countdownText = page.getByText(/Auto-running triage for/i).first();
    const armed = await countdownText
      .waitFor({ state: 'visible', timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    if (!armed) throw new Error('[smoke] case_002 — expected countdown card on first-visit, none found');
    console.log('[smoke] case_002 — fresh countdown card armed (first-visit)');
    await shot(page, '04-case002-countdown');
  } else {
    console.log('[smoke] case_002 — already has state on dev server; skipping countdown assertion');
    await shot(page, '04-case002-arrival');
  }

  // Switch back to case_001 BEFORE the case_002 countdown expires. Should be
  // instant rehydrate, NO countdown, packet present.
  await clickCaseTab(page, 'case_001');
  // Wait briefly and verify the countdown card is NOT armed on case_001.
  await page.waitForTimeout(2000);
  const countdownStillArmed = await page
    .getByText(/Auto-running triage for/i)
    .first()
    .isVisible()
    .catch(() => false);
  if (countdownStillArmed) {
    throw new Error('[smoke] case_001 rehydrate — countdown re-armed, expected instant rehydrate');
  }
  console.log('[smoke] case_001 rehydrate — no countdown (instant rehydrate confirmed)');

  // Packet should be visible immediately on the rehydrated view.
  const recommendedTitle = page.locator('.recommended-title').first();
  const rehydratedVisible = await recommendedTitle
    .waitFor({ state: 'visible', timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  if (!rehydratedVisible) {
    throw new Error('[smoke] case_001 rehydrate — packet not rendered after tab switch back');
  }
  console.log('[smoke] case_001 rehydrate — Decision Packet present');
  await shot(page, '05-case001-rehydrate');
}

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

let failures = 0;

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page
    .getByText(/Northstar Analytics/i)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 });

  try {
    await step1Case001(page);
  } catch (err) {
    console.error(`[smoke] STEP 1 FAIL — ${err.message ?? err}`);
    await shot(page, 'STEP1-ERROR').catch(() => {});
    failures += 1;
  }

  try {
    await step2CaseSwitch(page);
  } catch (err) {
    console.error(`[smoke] STEP 2 FAIL — ${err.message ?? err}`);
    await shot(page, 'STEP2-ERROR').catch(() => {});
    failures += 1;
  }

  if (failures) {
    console.error(`\n[smoke] ${failures} step(s) failed — see artifacts/`);
    process.exitCode = 1;
  } else {
    console.log('\n[smoke] all steps passed — artifacts/smoke-*.png saved');
  }
} finally {
  await context.close();
  await browser.close();
}
