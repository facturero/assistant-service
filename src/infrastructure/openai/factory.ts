import { Config, ProviderSettings } from '../../config';
import { LlmHealthPort, LlmPort, StructuredLlmPort } from '../../application/ports';
import { OpenAiCompatibleLlm } from './compatible-llm';
import { FailoverLlm } from './failover-llm';

/**
 * El modelo por el protocolo de OpenAI: un servidor solo, o dos con conmutación si hay `ASSISTANT_FALLBACK_BASE_URL`.
 * Cada servidor lleva su propio `server` y razonamiento: el respaldo puede ser otro programa con otro modelo.
 *
 * Siempre va dentro de `FailoverLlm`, aunque haya un solo servidor: es quien sondea `/models` y sabe decirle al chat si hay
 * alguien respondiendo (`status()`). Con uno solo no hay a quién cambiar, pero el chat igual se cierra a tiempo.
 */
export function createOpenAiCompatLlm(config: Config, provider: ProviderSettings): LlmPort & StructuredLlmPort & LlmHealthPort {
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
  const models = (base: string) => `${base.replace(/\/+$/, '')}/models`;
  const endpoints = [{ name: provider.baseURL!, llm: primary, healthUrl: models(provider.baseURL!) }];
  const probe = { probeIntervalMs: config.ASSISTANT_LLM_PROBE_INTERVAL_MS, probeTimeoutMs: 3000 };
  if (!config.ASSISTANT_FALLBACK_BASE_URL) return new FailoverLlm(endpoints, probe).start();

  const fallback = new OpenAiCompatibleLlm({
    baseURL: config.ASSISTANT_FALLBACK_BASE_URL,
    apiKey,
    model: config.ASSISTANT_FALLBACK_MODEL ?? provider.model,
    maxTokens: config.ANTHROPIC_MAX_TOKENS,
    timeoutMs: config.ASSISTANT_LLM_TIMEOUT_MS,
    server: config.OPENAI_COMPAT_FALLBACK_SERVER ?? config.OPENAI_COMPAT_SERVER,
    chatReasoning: config.OPENAI_COMPAT_FALLBACK_CHAT_REASONING ?? config.OPENAI_COMPAT_CHAT_REASONING,
  });
  return new FailoverLlm(
    [...endpoints, { name: config.ASSISTANT_FALLBACK_BASE_URL, llm: fallback, healthUrl: models(config.ASSISTANT_FALLBACK_BASE_URL) }],
    probe,
  ).start();
}
