import { ChatOpenAI } from '@langchain/openai';
import { ChatAnthropic } from '@langchain/anthropic';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { Runnable } from '@langchain/core/runnables';
import type {
  BaseLanguageModelInput,
} from '@langchain/core/language_models/base';
import type { z } from 'zod';

/**
 * Provider switch (v0.8):
 *   - mock           → deterministic fixtures by case_id (used when LLM_PROVIDER is unset
 *                      or =mock; no network).
 *   - anthropic      → Anthropic Claude Sonnet 4.6 with extended thinking PRIMARY,
 *                      DeepSeek fallback if DEEPSEEK_API_KEY is set (production demo path).
 *   - anthropic-only → Anthropic only — fail loud, no fallback (used when you want to
 *                      surface Anthropic errors instead of papering them over).
 *   - deepseek-only  → DeepSeek only — cost lane, no fallback. Replaces the v0.7
 *                      'deepseek' / 'deepseek-direct' aliases (both still accepted).
 *   - openrouter     → :free-tier deepseek-chat via OpenRouter (kept as the keyless
 *                      escape hatch; not advertised in README modes).
 *
 * Stale-env-var footgun: leaving LLM_PROVIDER=mock in a deploy env silently fixtures
 * every run. Dev-server boot logs the resolved provider — verify it on first load.
 */
export type LlmProvider =
  | 'mock'
  | 'anthropic'
  | 'anthropic-only'
  | 'deepseek-only'
  | 'openrouter';

export function activeProvider(): LlmProvider {
  const raw = (process.env.LLM_PROVIDER ?? '').toLowerCase().trim();
  if (raw === '' || raw === 'mock') return 'mock';
  if (raw === 'anthropic') return 'anthropic';
  if (raw === 'anthropic-only') return 'anthropic-only';
  if (raw === 'deepseek-only' || raw === 'deepseek' || raw === 'deepseek-direct') {
    return 'deepseek-only';
  }
  if (raw === 'openrouter') return 'openrouter';
  throw new Error(
    `LLM_PROVIDER='${raw}' is not one of: mock | anthropic | anthropic-only | deepseek-only | openrouter`
  );
}

/**
 * Signal from the Anthropic native Structured Outputs path that the
 * grammar-constrained JSON failed Zod refinement. (Grammar guarantees
 * shape — refinement failures are edge cases like a string that's
 * syntactically valid but violates a `.min()` / `.max()` / `.regex()`
 * Zod check.) `composeWithFallback` catches it and tries DeepSeek next.
 */
export class LlmStructuredOutputError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, opts?: { cause?: unknown }) {
    super(message);
    this.name = 'LlmStructuredOutputError';
    if (opts?.cause !== undefined) this.cause = opts.cause;
  }
}

interface LlmOpts {
  temperature?: number;
  jsonMode?: boolean;
}

/* ─── Provider factories ───────────────────────────────────────────────── */

function buildDeepSeek(opts: LlmOpts): BaseChatModel {
  const apiKey = required('DEEPSEEK_API_KEY');
  return new ChatOpenAI({
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    apiKey,
    configuration: { baseURL: 'https://api.deepseek.com' },
    temperature: opts.temperature ?? 0,
    ...(opts.jsonMode ? { modelKwargs: { response_format: { type: 'json_object' } } } : {}),
  });
}

function buildOpenRouter(opts: LlmOpts): BaseChatModel {
  const apiKey = required('OPENROUTER_API_KEY');
  return new ChatOpenAI({
    model: process.env.OPENROUTER_MODEL ?? 'deepseek/deepseek-chat:free',
    apiKey,
    configuration: {
      baseURL: 'https://openrouter.ai/api/v1',
      defaultHeaders: {
        'HTTP-Referer': 'https://github.com/billyscardino/vendor-ai-app',
        'X-Title': 'Vendor AI — Procurement Workbench',
      },
    },
    temperature: opts.temperature ?? 0,
    ...(opts.jsonMode ? { modelKwargs: { response_format: { type: 'json_object' } } } : {}),
  });
}

function buildAnthropic(opts: { thinking?: boolean } = {}): ChatAnthropic {
  const apiKey = required('ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
  const enableThinking = opts.thinking ?? true;
  // v0.10: default effort dropped from 'high' to 'medium'. Only consulted when
  // thinking is enabled. Operator can restore v0.9 budget via ANTHROPIC_EFFORT=high.
  const effort = (process.env.ANTHROPIC_EFFORT ?? 'medium') as
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max';
  const fixedBudget = process.env.ANTHROPIC_THINKING_BUDGET
    ? Number(process.env.ANTHROPIC_THINKING_BUDGET)
    : null;
  const thinking = enableThinking
    ? fixedBudget != null
      ? ({ type: 'enabled', budget_tokens: fixedBudget } as const)
      : ({ type: 'adaptive' } as const)
    : ({ type: 'disabled' } as const);
  return new ChatAnthropic({
    apiKey,
    model,
    // temperature: thinking requires 1; without thinking, low temperature
    // produces sharper structured-output adherence.
    temperature: enableThinking ? 1 : 0,
    // v0.10.2: maxTokens 4000 → 16000. With extended thinking ON, max_tokens
    // is the COMBINED budget for thinking blocks AND the final structured
    // output. The v0.10 cut to 4000 assumed thinking was off; under the new
    // native-SO + thinking path, adaptive thinking on Sonnet 4.6 routinely
    // consumes 3-8k tokens before the grammar engine emits JSON, and a
    // sub-budget cap produces an empty response (LangChain then surfaces
    // "Failed to parse. Text: ''"). 16000 = 12k thinking headroom + 4k
    // output headroom; matches the v0.9 known-good ceiling.
    maxTokens: 16000,
    thinking,
    ...(enableThinking ? { outputConfig: { effort } } : {}),
  });
}

/* ─── Legacy free-form LLM getter (kept for any consumer that wants the
 *     raw model — not used by the composition node anymore) ─────────────── */

export function getLlm(opts: LlmOpts = {}): BaseChatModel {
  const provider = activeProvider();
  if (provider === 'mock') return new MockChatModel() as unknown as BaseChatModel;
  if (provider === 'openrouter') return buildOpenRouter(opts);
  if (provider === 'deepseek-only') return buildDeepSeek(opts);
  if (provider === 'anthropic-only') return buildAnthropic() as unknown as BaseChatModel;
  // 'anthropic' default — primary with DeepSeek fallback when both keys exist.
  const primary = buildAnthropic() as unknown as BaseChatModel;
  if (process.env.DEEPSEEK_API_KEY) {
    const fallback = buildDeepSeek(opts);
    return primary.withFallbacks({ fallbacks: [fallback] }) as unknown as BaseChatModel;
  }
  return primary;
}

/* ─── Structured-output runnables (the load-bearing path) ──────────────── */

/**
 * Shape returned by all structured-output factories. We don't reuse
 * `Runnable<BaseLanguageModelInput, T>` because the Anthropic path needs
 * manual extraction (thinking + structured tool-choice='tool' is rejected
 * by the API), so the call site can't go through Runnable.invoke directly.
 */
export interface StructuredRunnable<T> {
  invoke: (input: BaseLanguageModelInput) => Promise<T>;
}

function anthropicStructured<T>(
  schema: z.ZodType<T>,
  opts: LlmOpts & { name?: string } = {}
): StructuredRunnable<T> {
  // v0.10.2: native Anthropic Structured Outputs. Grammar-constrained
  // decoding via `output_config.format: { type: 'json_schema', ... }`
  // applies ONLY to the final response — never to thinking blocks or
  // tool-result blocks — so extended thinking is documented as compatible
  // on Sonnet 4.6.
  //
  // `method: 'jsonSchema'` is REQUIRED. Omitting it makes
  // withStructuredOutput default to function-calling — the legacy
  // forced-tool-use path that 400s under thinking ("Thinking may not be
  // enabled when tool_choice forces tool use"). NOTE: camel-case
  // `jsonSchema` is the TypeScript variant — Python uses snake_case
  // `json_schema`. Pasting the Python form silently downgrades to
  // function-calling.
  //
  // Thinking ENABLED — grammar-constrained decoding applies to the final
  // response only, so adaptive thinking can run before the JSON emit.
  // Budget math: max_tokens=16000 ≈ 12k thinking + 4k JSON output.
  const llm = buildAnthropic({ thinking: true });
  const name = opts.name ?? 'compose';
  const structured = llm.withStructuredOutput(schema, {
    method: 'jsonSchema',
    name,
  });
  // One-shot wire-format probe. Set LLM_DEBUG_BINDING=1, run one case,
  // confirm `output_config.format.type === 'json_schema'` AND
  // `thinking: { type: 'adaptive' }` are both present (and no
  // `tool_choice` / `tools` array), then unset.
  if (process.env.LLM_DEBUG_BINDING === '1') {
    try {
      const dump = JSON.stringify(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (structured as any)?.kwargs ?? (structured as any)?.toJSON?.() ?? {},
        null,
        2
      );
      console.log('[llm] structured output config:', dump);
    } catch {
      /* never break the request on a debug-log failure */
    }
  }
  return {
    invoke: async (input: BaseLanguageModelInput) => {
      const result = (await structured.invoke(input)) as T;
      // Defense-in-depth: validate even though the grammar engine should
      // have already enforced shape. Catches edge cases where grammar
      // emits a syntactically-valid value that fails a Zod refinement
      // (`.min()`, `.max()`, `.regex()`, `.refine()` on a string).
      const parsed = schema.safeParse(result);
      if (parsed.success) return parsed.data;
      throw new LlmStructuredOutputError(
        `Anthropic native SO output failed Zod refinement: ${parsed.error.message}`,
        { cause: parsed.error }
      );
    },
  };
}

function deepseekStructured<T>(
  schema: z.ZodType<T>,
  opts: LlmOpts & { name?: string } = {}
): StructuredRunnable<T> {
  const llm = buildDeepSeek(opts);
  const runnable = llm.withStructuredOutput(schema, {
    name: opts.name ?? 'compose',
    method: 'functionCalling',
  }) as Runnable<BaseLanguageModelInput, T>;
  return { invoke: (input) => runnable.invoke(input) };
}

function openrouterStructured<T>(
  schema: z.ZodType<T>,
  opts: LlmOpts & { name?: string } = {}
): StructuredRunnable<T> {
  const llm = buildOpenRouter(opts);
  const runnable = llm.withStructuredOutput(schema, {
    name: opts.name ?? 'compose',
    method: 'functionCalling',
  }) as Runnable<BaseLanguageModelInput, T>;
  return { invoke: (input) => runnable.invoke(input) };
}

/**
 * Hand-rolled fallback composer. We can't use `Runnable.withFallbacks()`
 * because `StructuredRunnable` isn't a LangChain Runnable — it's a thin
 * `{ invoke }` wrapper around either a Runnable (DeepSeek) or a bind-tools
 * + extraction pipeline (Anthropic).
 *
 * Catches `LlmStructuredOutputError` (our throw on Anthropic parse failure)
 * plus any other Error from primary.invoke(), logs the reason, and tries
 * fallback. If fallback also throws, the upstream catch in
 * `prepareDecisionPacketNode` routes to the always-emit fallback packet.
 */
function composeWithFallback<T>(
  primary: StructuredRunnable<T>,
  fallback: StructuredRunnable<T>
): StructuredRunnable<T> {
  return {
    invoke: async (input) => {
      try {
        return await primary.invoke(input);
      } catch (e) {
        // Structured JSON payload so LangSmith trace ingest / Vercel log
        // aggregation can parse the fallback signal without regex on a string.
        console.warn(
          JSON.stringify({
            event: 'llm.fallback.fired',
            primary: 'anthropic',
            fallback: 'deepseek',
            error_class:
              (e as { constructor?: { name?: string } } | null)?.constructor?.name ?? 'Unknown',
            error_kind: e instanceof LlmStructuredOutputError ? 'parse' : 'transport',
            error_message: e instanceof Error ? e.message : String(e),
            timestamp: new Date().toISOString(),
          })
        );
        return await fallback.invoke(input);
      }
    },
  };
}

/**
 * The composition-node entry point. Returns a StructuredRunnable for the
 * active provider. The default ('anthropic') composes Anthropic primary +
 * DeepSeek fallback when both keys are present.
 */
export function getStructuredCompositionLlm<T>(
  schema: z.ZodType<T>,
  opts: LlmOpts & { name?: string } = {}
): StructuredRunnable<T> {
  const provider = activeProvider();
  if (provider === 'mock') {
    throw new Error(
      'getStructuredCompositionLlm called in mock mode — graph nodes must short-circuit on activeProvider() === "mock".'
    );
  }
  if (provider === 'anthropic-only') return anthropicStructured(schema, opts);
  if (provider === 'deepseek-only') return deepseekStructured(schema, opts);
  if (provider === 'openrouter') return openrouterStructured(schema, opts);

  // 'anthropic' default — Anthropic primary with DeepSeek fallback if the
  // fallback key is configured. Without the fallback key, we still ship
  // Anthropic alone (failures route to the always-emit fallback packet).
  const primary = anthropicStructured(schema, opts);
  if (process.env.DEEPSEEK_API_KEY) {
    return composeWithFallback(primary, deepseekStructured(schema, opts));
  }
  return primary;
}

/**
 * Back-compat shim — kept so anything outside the composition node that
 * imported `getStructuredLlm` still works. Internally now dispatches to
 * `getStructuredCompositionLlm` and adapts to the legacy Runnable signature.
 */
export function getStructuredLlm<T>(
  schema: z.ZodType<T>,
  opts: LlmOpts & { name?: string } = {}
): Runnable<BaseLanguageModelInput, T> {
  const wrapped = getStructuredCompositionLlm(schema, opts);
  // Cast through a minimal shape — callers in nodes.ts only use .invoke().
  return { invoke: wrapped.invoke } as unknown as Runnable<BaseLanguageModelInput, T>;
}

/* ─── Item 10: N-of-K self-consistency on borderline cases ────────────── */

/**
 * Sample the composer K times in parallel and pick the "median" sample by a
 * caller-supplied scalar (typically the flag-count of the LLM output, so the
 * picked answer is an ACTUAL sample, not a phantom majority-merged set).
 * Triggered ONLY on borderline cases (LLM-emitted risk_tier disagrees with
 * the deterministic computeRiskTier) — happy-path stays single-shot.
 *
 * `Promise.allSettled` means we tolerate up to K-1 individual sample failures
 * and still ship the best surviving answer. If ALL K fail, we throw so the
 * upstream fallback chain (composeWithFallback) sees the error and the always-
 * emit fallback packet path takes over.
 */
export async function composeWithSelfConsistency<T>(
  composer: () => Promise<T>,
  keyFn: (sample: T) => number,
  k = 3
): Promise<T> {
  const settled = await Promise.allSettled(
    Array.from({ length: k }, () => composer())
  );
  const fulfilled = settled
    .filter(
      (s): s is PromiseFulfilledResult<Awaited<T>> => s.status === 'fulfilled'
    )
    .map((s) => s.value);
  if (fulfilled.length === 0) {
    const first = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    const reason = first?.reason instanceof Error ? first.reason.message : String(first?.reason);
    throw new Error(`composeWithSelfConsistency: all ${k} samples failed (e.g. ${reason})`);
  }
  // Sort by scalar key; pick the median index — that's the actual sample whose
  // flag count is closest to the K-sample average. Avoids synthesizing a phantom
  // merged answer that doesn't correspond to any individual model run.
  const ranked = [...fulfilled].sort((a, b) => keyFn(a) - keyFn(b));
  const median = ranked[Math.floor(ranked.length / 2)];
  if (process.env.LLM_DEBUG_SELF_CONSISTENCY === '1') {
    console.log(
      `[self-consistency] picked median from ${fulfilled.length}/${k} samples; keys=${ranked
        .map((s) => keyFn(s))
        .join(',')}`
    );
  }
  return median;
}

/* ─── Item 12: pipeline-mode scaffold (default off) ────────────────────── */

export type PipelineMode = 'single' | '3step';

/**
 * Default `single`. Opt-in `3step` is dormant scaffolding for the next
 * iteration — the 3-step nodes (extract_policy_flags, classify_severities,
 * emit_packet) reuse this contract so the eval runner + UI work unchanged.
 * Flipping to `3step` today logs a one-time warning and falls back to
 * single-shot — the orchestrator nodes haven't been wired yet.
 */
export function pipelineMode(): PipelineMode {
  const raw = (process.env.LLM_PIPELINE_MODE ?? '').toLowerCase().trim();
  if (raw === '3step') return '3step';
  return 'single';
}

let warned3StepDormant = false;
export function noteThreeStepDormantIfActive(): void {
  if (pipelineMode() === '3step' && !warned3StepDormant) {
    warned3StepDormant = true;
    console.warn(
      '[llm] LLM_PIPELINE_MODE=3step is set but the 3-step orchestrator is not yet wired; ' +
        'falling back to single-shot composition. (v0.10 scaffold only — flip to default when ' +
        'the next iteration A/Bs the decomposition.)'
    );
  }
}

/* ─── Provider info accessor (exposed to FE via /api/run/[case] GET) ───── */

export interface ProviderInfo {
  label: string;
  thinking: boolean;
  mode: string;
}

export function getProviderInfo(): ProviderInfo {
  const provider = activeProvider();
  if (provider === 'mock') {
    return { label: 'Mocks (fixtures)', thinking: false, mode: 'mock' };
  }
  if (provider === 'anthropic-only') {
    return { label: 'Anthropic Sonnet · thinking', thinking: true, mode: 'anthropic-only' };
  }
  if (provider === 'deepseek-only') {
    return { label: 'DeepSeek', thinking: false, mode: 'deepseek-only' };
  }
  if (provider === 'openrouter') {
    return { label: 'OpenRouter', thinking: false, mode: 'openrouter' };
  }
  // 'anthropic' default
  const hasFallback = !!process.env.DEEPSEEK_API_KEY;
  return {
    label: hasFallback
      ? 'Anthropic Sonnet · thinking · DeepSeek fallback'
      : 'Anthropic Sonnet · thinking',
    thinking: true,
    mode: hasFallback ? 'anthropic+deepseek' : 'anthropic',
  };
}

/* ─── Helpers ──────────────────────────────────────────────────────────── */

function required(envVar: string): string {
  const v = process.env[envVar];
  if (!v) {
    throw new Error(
      `Missing required env var: ${envVar}. Set in Vercel project settings or .env.local. ` +
        `Active provider is '${activeProvider()}'; switch LLM_PROVIDER to 'mock' for keyless dev.`
    );
  }
  return v;
}

/**
 * Minimal mock — real graph nodes branch on activeProvider() and call mock
 * fixture builders directly. This class exists so getLlm()'s return type
 * stays consistent for callers that want to inject the LLM uniformly.
 */
class MockChatModel {
  _modelType() {
    return 'mock';
  }
  async invoke() {
    throw new Error(
      'MockChatModel.invoke called — graph nodes must short-circuit when activeProvider() === "mock". ' +
        'See nodes.ts for the fixture path.'
    );
  }
}
