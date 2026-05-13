#!/usr/bin/env node
// v0.10.2 Item 20 — browser smoke test for the Decision Packet render
// path. Drives Playwright directly (single Node process, one persistent
// browser + page) so state survives across steps. Runs the three
// materialized cases through the workbench, asserts the packet UI
// surfaces (risk tier, approvers, policy flags) and saves a screenshot
// per case.
//
// NOT in CI — this is a manual gate to run after each bench cycle so
// "the bench passes but the UI is blank" regressions can't ship silent.
//
// Preconditions:
//   - `pnpm dev` running on http://localhost:3000 (start it yourself)
//   - `envchain vendor-ai pnpm dev` so ANTHROPIC_API_KEY is set
//
// Usage:
//   node scripts/qa-packet-render.mjs                 # all 3 cases
//   node scripts/qa-packet-render.mjs case_001        # one case
//   QA_HEADED=1 node scripts/qa-packet-render.mjs     # watch the run
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
// 180s default: case_003 cold-start (3 missing docs + restricted PII +
// AI training, the heaviest case) has been observed >120s on the
// thinking-on structured path. Override with QA_PACKET_TIMEOUT_MS.
const PACKET_TIMEOUT_MS = Number(process.env.QA_PACKET_TIMEOUT_MS ?? 180_000);
const HEADED = process.env.QA_HEADED === '1';

const ALL_CASES = ['case_001', 'case_002', 'case_003'];
const cases = process.argv.slice(2).length ? process.argv.slice(2) : ALL_CASES;

async function pageContains(page, needle) {
  // Use locator count rather than body.innerText — innerText only
  // reflects rendered/visible content within the viewport, which would
  // miss the lower sections of the Decision Packet card below the fold.
  const n = await page.getByText(needle, { exact: false }).count();
  return n > 0;
}

async function runCase(page, caseId) {
  console.log(`\n[qa] === ${caseId} ===`);

  // Workbench stores caseId in React state (default 'case_001') and
  // does NOT read it from the URL — the only way to switch cases is to
  // click the case tab. Selectors target the `.case-tab` button by its
  // `.tab-id` child.
  const tab = page.locator('.case-tab', { hasText: caseId }).first();
  await tab.waitFor({ state: 'visible', timeout: 15_000 });
  await tab.click();

  // Confirm the tab is now active before checking packet state.
  await page
    .locator('.case-tab.active', { hasText: caseId })
    .first()
    .waitFor({ state: 'visible', timeout: 5_000 });

  // Give the per-case useEffect a tick to fetch existing state. If the
  // thread already has a packet (e.g. prior run on this dev server),
  // we skip the click and verify the rendered packet directly.
  await page.waitForTimeout(1500);

  const recommendedTitle = page.locator('.recommended-title').first();
  const alreadyRendered = await recommendedTitle
    .waitFor({ state: 'visible', timeout: 1500 })
    .then(() => true)
    .catch(() => false);

  if (alreadyRendered) {
    console.log(`[qa] ${caseId} — packet already present (cached run), verifying render`);
  } else {
    // Fresh thread — click "Run agent" in RunEmpty and wait for the
    // packet to stream in.
    // Accessible name is "▶ Run agent" (leading arrow glyph), so don't
    // anchor the regex. The "Edit & re-run" button only exists in the
    // ConfirmationCard which renders alongside a packet — and we only
    // reach this branch when no packet is rendered.
    const runBtn = page
      .getByRole('button', { name: /run agent/i })
      .first();
    try {
      await runBtn.waitFor({ state: 'visible', timeout: 15_000 });
    } catch (err) {
      // Capture what's actually on the page so the failure mode is
      // visible without re-running in headed mode.
      await page.screenshot({
        path: path.join(ARTIFACTS, `qa-${caseId}-NO-RUN-BTN.png`),
        fullPage: true,
      });
      throw err;
    }
    await runBtn.click();

    await recommendedTitle.waitFor({
      state: 'visible',
      timeout: PACKET_TIMEOUT_MS,
    });
  }

  // Post-T1.4/T1.5: the packet header renders "Risk: Low/Medium/High" (not
  // "Risk tier:" — that label belonged to the removed inline-edit dropdown).
  const required = ['Risk:', 'Required approvers', 'Policy flags'];
  const missing = [];
  for (const needle of required) {
    if (!(await pageContains(page, needle))) missing.push(needle);
  }
  if (missing.length) {
    console.error(`[qa] ${caseId} FAIL — missing: ${missing.join(', ')}`);
    await page.screenshot({
      path: path.join(ARTIFACTS, `qa-${caseId}-FAIL.png`),
      fullPage: true,
    });
    return false;
  }

  await page.screenshot({
    path: path.join(ARTIFACTS, `qa-${caseId}.png`),
    fullPage: true,
  });
  console.log(`[qa] ${caseId} PASS — screenshot at artifacts/qa-${caseId}.png`);
  return true;
}

const browser = await chromium.launch({ headless: !HEADED });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

try {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page
    .getByText(/Northstar Analytics/i)
    .first()
    .waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => {
      throw new Error(
        '[qa] homepage never rendered "Northstar Analytics" — is `pnpm dev` running?'
      );
    });

  let failures = 0;
  for (const caseId of cases) {
    if (!ALL_CASES.includes(caseId)) {
      console.error(`[qa] unknown case ${caseId} — expected one of ${ALL_CASES.join(', ')}`);
      failures += 1;
      continue;
    }
    try {
      if (!(await runCase(page, caseId))) failures += 1;
    } catch (err) {
      console.error(`[qa] ${caseId} ERROR — ${err.message ?? err}`);
      await page
        .screenshot({ path: path.join(ARTIFACTS, `qa-${caseId}-ERROR.png`), fullPage: true })
        .catch(() => {});
      failures += 1;
    }
  }

  if (failures) {
    console.error(`\n[qa] ${failures}/${cases.length} cases failed`);
    process.exitCode = 1;
  } else {
    console.log(`\n[qa] All ${cases.length} cases passed.`);
  }
} finally {
  await context.close();
  await browser.close();
}
