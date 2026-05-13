#!/usr/bin/env node
/**
 * Dataset-driven accuracy eval. Reads `eval/dataset.json` (schema v0.9),
 * runs every `status: "materialized"` case through the live graph, scores
 * each result against the case's declared `expected` block using the
 * 5-point rubric in the dataset, and prints a per-case + coverage-tag
 * scorecard.
 *
 * Source of truth lives in JSON so coverage can grow without touching
 * this runner. The original `scripts/eval-live.ts` (3-case, 4-point,
 * scored against `MOCK_LLM_OUTPUT`) stays put as the demo smoke path.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Command } from '@langchain/langgraph';
import { graph, seedState } from '../src/lib/agent/graph';
import { getProviderInfo } from '../src/lib/agent/llm';
import type { DecisionPacket, PolicyFlag } from '../src/lib/agent/schemas';

interface DatasetCase {
  id: string;
  vendor_name: string;
  status: 'materialized' | 'designed';
  fixture_dir: string | null;
  expected: {
    flag_count: { target: number; range: [number, number] };
    recommended_action: DecisionPacket['recommended_action'];
    risk_tier: DecisionPacket['risk_tier'];
    severity_mix: { block: number; warn: number; info: number };
    approvers_routed: string[];
  };
  coverage_tags: string[];
  notes: string;
}

interface Dataset {
  schema_version: string;
  cases: DatasetCase[];
}

interface Scorecard {
  caseId: string;
  vendor: string;
  ms: number;
  actual?: {
    flags: number;
    action: string;
    risk: string;
    hasBlock: boolean;
  };
  expected: DatasetCase['expected'];
  checks?: {
    flag_count_within_range: boolean;
    flag_count_exact: boolean;
    action_match: boolean;
    risk_match: boolean;
    severity_mix_block_match: boolean;
  };
  points: number;
  error?: string;
  coverage_tags: string[];
}

const POINTS_PER_CASE = 5;

function loadDataset(): Dataset {
  const path = resolve(process.cwd(), 'eval/dataset.json');
  return JSON.parse(readFileSync(path, 'utf8')) as Dataset;
}

async function runCase(caseId: string): Promise<{ packet: DecisionPacket | undefined; ms: number }> {
  const t0 = Date.now();
  const config = { configurable: { thread_id: `dataset_${caseId}_${Date.now()}` } };
  await graph.updateState(config, seedState(caseId), undefined);
  await graph.invoke(new Command({ resume: 'run' }), config);
  const snap = await graph.getState(config);
  return { packet: snap.values?.decision_packet, ms: Date.now() - t0 };
}

function score(c: DatasetCase, packet: DecisionPacket): Scorecard {
  const flags = packet.policy_flags as PolicyFlag[];
  const actualFlagCount = flags.length;
  const hasBlock = flags.some((f) => f.severity === 'block');
  const expectsBlock = c.expected.severity_mix.block > 0;

  const flag_count_within_range =
    actualFlagCount >= c.expected.flag_count.range[0] &&
    actualFlagCount <= c.expected.flag_count.range[1];
  const flag_count_exact = actualFlagCount === c.expected.flag_count.target;
  const action_match = packet.recommended_action === c.expected.recommended_action;
  const risk_match = packet.risk_tier === c.expected.risk_tier;
  const severity_mix_block_match = hasBlock === expectsBlock;

  const points =
    (flag_count_within_range ? 1 : 0) +
    (flag_count_exact ? 1 : 0) +
    (action_match ? 1 : 0) +
    (risk_match ? 1 : 0) +
    (severity_mix_block_match ? 1 : 0);

  return {
    caseId: c.id,
    vendor: c.vendor_name,
    ms: 0,
    actual: { flags: actualFlagCount, action: packet.recommended_action, risk: packet.risk_tier, hasBlock },
    expected: c.expected,
    checks: { flag_count_within_range, flag_count_exact, action_match, risk_match, severity_mix_block_match },
    points,
    coverage_tags: c.coverage_tags,
  };
}

function tick(ok: boolean): string {
  return ok ? '✓' : '✗';
}

function coverageBreakdown(cards: Scorecard[]): Map<string, { points: number; max: number; n: number }> {
  const byTag = new Map<string, { points: number; max: number; n: number }>();
  for (const card of cards) {
    for (const tag of card.coverage_tags) {
      const cur = byTag.get(tag) ?? { points: 0, max: 0, n: 0 };
      cur.points += card.points;
      cur.max += POINTS_PER_CASE;
      cur.n += 1;
      byTag.set(tag, cur);
    }
  }
  return byTag;
}

async function main() {
  const dataset = loadDataset();
  const materialized = dataset.cases.filter((c) => c.status === 'materialized');
  const designed = dataset.cases.filter((c) => c.status === 'designed');

  const provider = getProviderInfo();
  console.log(`\n=== vendor-ai dataset eval (schema ${dataset.schema_version}) ===`);
  console.log(`provider: ${provider.label}`);
  console.log(`mode:     ${provider.mode}`);
  console.log(`thinking: ${provider.thinking ? 'enabled' : 'off'}`);
  console.log(
    `cases:    ${materialized.length} materialized · ${designed.length} designed (skipped)\n`
  );

  const scorecards: Scorecard[] = [];
  for (const c of materialized) {
    process.stdout.write(`${c.id} (${c.vendor_name})… `);
    try {
      const { packet, ms } = await runCase(c.id);
      if (!packet) {
        console.log(`FAIL — no decision_packet emitted (${ms}ms)`);
        scorecards.push({
          caseId: c.id,
          vendor: c.vendor_name,
          ms,
          expected: c.expected,
          points: 0,
          error: 'no decision_packet',
          coverage_tags: c.coverage_tags,
        });
        continue;
      }
      const card = score(c, packet);
      card.ms = ms;
      scorecards.push(card);
      const ck = card.checks!;
      console.log(
        `${ms}ms  flags=${card.actual!.flags} (target ${c.expected.flag_count.target}, range ${c.expected.flag_count.range.join('-')}) ${tick(ck.flag_count_within_range)}${tick(ck.flag_count_exact)}  ` +
          `action=${card.actual!.action} ${tick(ck.action_match)}  ` +
          `risk=${card.actual!.risk} ${tick(ck.risk_match)}  ` +
          `block=${card.actual!.hasBlock ? 'yes' : 'no'} ${tick(ck.severity_mix_block_match)}  ` +
          `score=${card.points}/${POINTS_PER_CASE}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`THROW — ${msg}`);
      scorecards.push({
        caseId: c.id,
        vendor: c.vendor_name,
        ms: 0,
        expected: c.expected,
        points: 0,
        error: msg,
        coverage_tags: c.coverage_tags,
      });
    }
  }

  // ── Aggregate ──────────────────────────────────────────────────────────
  const totalPoints = scorecards.reduce((s, c) => s + c.points, 0);
  const maxPoints = materialized.length * POINTS_PER_CASE;
  const pct = maxPoints === 0 ? 0 : Math.round((totalPoints / maxPoints) * 100);
  console.log(`\n── overall ──`);
  console.log(`score: ${totalPoints}/${maxPoints} (${pct}%)`);

  const checkSummary = (key: keyof NonNullable<Scorecard['checks']>) =>
    scorecards.filter((c) => c.checks?.[key]).length;
  console.log(`flag count within range:  ${checkSummary('flag_count_within_range')}/${materialized.length}`);
  console.log(`flag count exact:         ${checkSummary('flag_count_exact')}/${materialized.length}`);
  console.log(`action match:             ${checkSummary('action_match')}/${materialized.length}`);
  console.log(`risk match:               ${checkSummary('risk_match')}/${materialized.length}`);
  console.log(`severity mix block match: ${checkSummary('severity_mix_block_match')}/${materialized.length}`);

  // ── Coverage tag breakdown ────────────────────────────────────────────
  const byTag = coverageBreakdown(scorecards);
  if (byTag.size > 0) {
    console.log(`\n── coverage tag breakdown ──`);
    const rows = [...byTag.entries()].sort(([a], [b]) => a.localeCompare(b));
    for (const [tag, agg] of rows) {
      const tagPct = Math.round((agg.points / agg.max) * 100);
      console.log(`  ${tag.padEnd(28)}  ${agg.points}/${agg.max}  (${tagPct}%)  n=${agg.n}`);
    }
  }

  // ── Designed coverage holes (no fixtures yet) ─────────────────────────
  if (designed.length > 0) {
    console.log(`\n── designed (not scored — no fixtures) ──`);
    for (const d of designed) {
      console.log(`  ${d.id}  ${d.vendor_name.padEnd(28)}  tags: ${d.coverage_tags.join(', ')}`);
    }
  }

  console.log(`\nLangSmith project: ${process.env.LANGSMITH_PROJECT ?? 'vendor-ai'}`);

  const failed = scorecards.filter((c) => c.points < 3).length;
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error('eval-dataset crashed:', err);
  process.exitCode = 2;
});
