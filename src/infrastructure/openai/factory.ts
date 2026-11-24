import { Config, ProviderSettings } from '../../config';
import { LlmPort, StructuredLlmPort } from '../../application/ports';
import { OpenAiCompatibleLlm } from './compatible-llm';
import { FailoverLlm } from './failover-llm';

/**
 * El modelo por el protocolo de OpenAI: un servidor solo, o dos con conmutación si hay `ASSISTANT_FALLBACK_BASE_URL`.
 * Cada servidor lleva su propio `server` y razonamiento: el respaldo puede ser otro programa con otro modelo.
 */
export function createOpenAiCompatLlm(config: Config, provider: ProviderSettings): LlmPort & StructuredLlmPort {
  const apiKey = provider.apiKey || undefined;
  const primary = new OpenAiCompatibleLlm({
    baseURL: provider.baseURL!,
    apiKey,
    model: provider.model,
    maxTokens: config.ANTHROPIC_MAX_TOKENS,
    timeoutMs: config.ASSISTANT_LLM_TIMEOUT_MS,
    server: config.OPENAI_COMPAT_SERVER,
    chatReasoning: config.OPENAI_COMPAT_CHAT_REASONING,
  });
  if (!config.ASSISTANT_FALLBACK_BASE_URL) return primary;

  const fallback = new OpenAiCompatibleLlm({
    baseURL: config.ASSISTANT_FALLBACK_BASE_URL,
    apiKey,
    model: config.ASSISTANT_FALLBACK_MODEL ?? provider.model,
    maxTokens: config.ANTHROPIC_MAX_TOKENS,
    timeoutMs: config.ASSISTANT_LLM_TIMEOUT_MS,
    server: config.OPENAI_COMPAT_FALLBACK_SERVER ?? config.OPENAI_COMPAT_SERVER,
    chatReasoning: config.OPENAI_COMPAT_FALLBACK_CHAT_REASONING ?? config.OPENAI_COMPAT_CHAT_REASONING,
  });
  const models = (base: string) => `${base.replace(/\/+$/, '')}/models`;
  return new FailoverLlm(
    [
      { name: provider.baseURL!, llm: primary, healthUrl: models(provider.baseURL!) },
      { name: config.ASSISTANT_FALLBACK_BASE_URL, llm: fallback, healthUrl: models(config.ASSISTANT_FALLBACK_BASE_URL) },
    ],
    { probeIntervalMs: config.ASSISTANT_LLM_PROBE_INTERVAL_MS, probeTimeoutMs: 3000 },
  ).start();
}
