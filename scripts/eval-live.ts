#!/usr/bin/env node
/**
 * Live-LLM accuracy eval — runs the 3 fixtures through the live LLM provider
 * chain (Anthropic Sonnet 4.6 + thinking → DeepSeek fallback) and scores
 * each result against the deterministic mock fixtures in
 * `src/lib/agent/mocks.ts`, which are the v0.8 plan's source of truth.
 *
 * Scoring (per case):
 *   - flag count: ABS_DIFF vs mock count, plus ±1 tolerance flag
 *   - recommended_action: EXACT match
 *   - risk_tier: EXACT match
 *   - bonus: presence of expected severity mix (block flag required for case_003)
 *
 * Output: per-case + aggregate scorecard.
 *
 * Pre-reqs:
 *   - `.env.local` populated with ANTHROPIC_API_KEY (+ optional DEEPSEEK_API_KEY,
 *     LANGSMITH_API_KEY, LANGSMITH_PROJECT).
 *   - Run via `pnpm eval:live` (uses tsx + Node native --env-file).
 *
 * Inspect any outlier in LangSmith manually, or shell out to:
 *   poetry run langsmith-fetch traces --last-n-minutes 5 --format raw
 */
import { spawnSync } from 'node:child_process';
import { Command } from '@langchain/langgraph';
import { graph, seedState } from '../src/lib/agent/graph';
import { getProviderInfo } from '../src/lib/agent/llm';
import { MOCK_LLM_OUTPUT } from '../src/lib/agent/mocks';

const CASES = ['case_001', 'case_002', 'case_003'];

// Risk_tier is deterministic from flags+data sensitivity (see computeRiskTier
// in nodes.ts). For each case, the expected risk_tier under the mock fixture is:
const EXPECTED_RISK = {
  case_001: 'medium',
  case_002: 'medium', // warn-severity flag → medium under computeRiskTier
  case_003: 'high',
};

async function runCase(caseId) {
  const t0 = Date.now();
  const config = { configurable: { thread_id: `eval_${caseId}_${Date.now()}` } };
  await graph.updateState(config, seedState(caseId), undefined);
  await graph.invoke(new Command({ resume: 'run' }), config);
  const snap = await graph.getState(config);
  return { packet: snap.values?.decision_packet, ms: Date.now() - t0 };
}

function score(caseId, packet) {
  const target = MOCK_LLM_OUTPUT[caseId];
  const expectedFlagsCount = target.policy_flags.length;
  const expectedAction = target.recommended_action;
  const expectedRisk = EXPECTED_RISK[caseId];
  const actualFlagsCount = packet.policy_flags.length;

  const flagDiff = actualFlagsCount - expectedFlagsCount;
  const flagsExact = flagDiff === 0;
  const flagsWithinPlusMinus1 = Math.abs(flagDiff) <= 1;
  const actionMatch = packet.recommended_action === expectedAction;
  const riskMatch = packet.risk_tier === expectedRisk;
  const hasBlock = packet.policy_flags.some((f) => f.severity === 'block');
  const expectsBlock = caseId === 'case_003';
  const blockOk = expectsBlock ? hasBlock : !hasBlock;

  // 4-point per-case score (max 4):
  //   +1 flags within ±1 of mock
  //   +1 flags exact match
  //   +1 recommended_action exact match
  //   +1 risk_tier exact match
  let points = 0;
  if (flagsWithinPlusMinus1) points += 1;
  if (flagsExact) points += 1;
  if (actionMatch) points += 1;
  if (riskMatch) points += 1;

  return {
    caseId,
    actual: {
      flags: actualFlagsCount,
      action: packet.recommended_action,
      risk: packet.risk_tier,
      hasBlock,
    },
    expected: {
      flags: expectedFlagsCount,
      action: expectedAction,
      risk: expectedRisk,
      hasBlock: expectsBlock,
    },
    checks: {
      flagsWithinPlusMinus1,
      flagsExact,
      actionMatch,
      riskMatch,
      blockOk,
    },
    flagDiff,
    points,
  };
}

function emoji(ok) {
  return ok ? '✓' : '✗';
}

function langsmithFetchAvailable() {
  const probe = spawnSync('command', ['-v', 'langsmith-fetch'], { shell: '/bin/zsh' });
  return probe.status === 0;
}

async function main() {
  const provider = getProviderInfo();
  console.log(`\n=== vendor-ai live eval (v0.8) ===`);
  console.log(`provider: ${provider.label}`);
  console.log(`mode:     ${provider.mode}`);
  console.log(`thinking: ${provider.thinking ? 'enabled' : 'off'}`);
  console.log(`\nground truth: src/lib/agent/mocks.ts (MOCK_LLM_OUTPUT)\n`);

  const scorecards = [];
  for (const caseId of CASES) {
    process.stdout.write(`${caseId}… `);
    try {
      const { packet, ms } = await runCase(caseId);
      if (!packet) {
        console.log(`FAIL — no decision_packet emitted (${ms}ms)`);
        scorecards.push({ caseId, error: 'no packet', ms, points: 0 });
        continue;
      }
      const card = score(caseId, packet);
      card.ms = ms;
      scorecards.push(card);
      console.log(
        `${ms}ms  flags=${card.actual.flags} (mock ${card.expected.flags}, Δ${card.flagDiff >= 0 ? '+' : ''}${card.flagDiff})  ` +
          `action=${card.actual.action} ${emoji(card.checks.actionMatch)}  ` +
          `risk=${card.actual.risk} ${emoji(card.checks.riskMatch)}  ` +
          `score=${card.points}/4`
      );
    } catch (err) {
      console.log(`THROW — ${err.message}`);
      scorecards.push({ caseId, error: err.message, points: 0 });
    }
  }

  // ── Aggregate scorecard ────────────────────────────────────────────────
  const totalPoints = scorecards.reduce((s, c) => s + (c.points ?? 0), 0);
  const maxPoints = CASES.length * 4;
  console.log(`\n── scorecard ──`);
  console.log(`overall: ${totalPoints}/${maxPoints} (${Math.round((totalPoints / maxPoints) * 100)}%)`);
  const within1 = scorecards.filter((c) => c.checks?.flagsWithinPlusMinus1).length;
  const exact = scorecards.filter((c) => c.checks?.flagsExact).length;
  const actionOk = scorecards.filter((c) => c.checks?.actionMatch).length;
  const riskOk = scorecards.filter((c) => c.checks?.riskMatch).length;
  console.log(`flag count ±1: ${within1}/${CASES.length}`);
  console.log(`flag count exact: ${exact}/${CASES.length}`);
  console.log(`action exact: ${actionOk}/${CASES.length}`);
  console.log(`risk exact: ${riskOk}/${CASES.length}`);

  // ── v0.8 vs v0.7 baseline comparison ───────────────────────────────────
  // Pre-v0.8 numbers (from plan §Context table):
  //   case_001: 2 flags / escalate / High  — silent fallback, NOT an agent run
  //   case_002: 4 flags / approve_with_followup / Low
  //   case_003: 16 flags / block / High
  const V07_BASELINE = {
    case_001: { flags: 2, action: 'escalate' },
    case_002: { flags: 4, action: 'approve_with_followup' },
    case_003: { flags: 16, action: 'block' },
  };
  console.log(`\n── v0.8 delta vs v0.7 live baseline ──`);
  for (const card of scorecards) {
    if (!card.actual) continue;
    const before = V07_BASELINE[card.caseId];
    const flagDelta = card.actual.flags - before.flags;
    const actionFlip = card.actual.action !== before.action ? ` action ${before.action} → ${card.actual.action}` : '';
    console.log(
      `  ${card.caseId}: ${before.flags}→${card.actual.flags} flags (${flagDelta >= 0 ? '+' : ''}${flagDelta})${actionFlip}`
    );
  }

  console.log(`\nLangSmith project: ${process.env.LANGSMITH_PROJECT ?? 'vendor-ai'}`);
  if (langsmithFetchAvailable()) {
    console.log(`Inspect outliers: langsmith-fetch traces --last-n-minutes 5 --format raw`);
  }
  console.log();

  const failed = scorecards.filter((c) => (c.points ?? 0) < 3).length;
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('eval-live crashed:', err);
  process.exitCode = 2;
});
