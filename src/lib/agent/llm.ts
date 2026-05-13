import { ChatOpenAI } from '@langchain/openai';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';

/**
 * Three-mode provider switch (per DESIGN §15):
 *   - mock           → deterministic by case_id (used in dev/CI; no network)
 *   - openrouter     → free :free-tier models via OpenRouter (default for demo)
 *   - deepseek-direct → DeepSeek's own Anthropic-compat endpoint (production)
 *
 * Stale-env-var footgun: if LLM_PROVIDER is left as 'mock' in a deploy env,
 * real runs silently get fixture responses. Surface the active provider in
 * logs and refuse to silently fall back.
 */
export type LlmProvider = 'mock' | 'openrouter' | 'deepseek-direct';

export function activeProvider(): LlmProvider {
  const v = (process.env.LLM_PROVIDER ?? 'mock').toLowerCase();
  if (v === 'mock' || v === 'openrouter' || v === 'deepseek-direct') return v;
  throw new Error(
    `LLM_PROVIDER='${v}' is not one of: mock | openrouter | deepseek-direct`
  );
}

export function getLlm(opts: { temperature?: number; jsonMode?: boolean } = {}): BaseChatModel {
  const provider = activeProvider();
  const temperature = opts.temperature ?? 0;

  if (provider === 'openrouter') {
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
      temperature,
      ...(opts.jsonMode ? { modelKwargs: { response_format: { type: 'json_object' } } } : {}),
    });
  }

  if (provider === 'deepseek-direct') {
    const apiKey = required('DEEPSEEK_API_KEY');
    return new ChatOpenAI({
      model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
      apiKey,
      configuration: {
        baseURL: 'https://api.deepseek.com',
      },
      temperature,
      ...(opts.jsonMode ? { modelKwargs: { response_format: { type: 'json_object' } } } : {}),
    });
  }

  // mock provider — caller-side responsibility. The graph nodes that call
  // the LLM check `activeProvider() === 'mock'` and short-circuit to fixtures.
  // Returning the mock client lets the type-system stay simple.
  return new MockChatModel() as unknown as BaseChatModel;
}

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
