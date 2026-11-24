/**
 * Corre UN caso del banco y vuelca cada petición y respuesta cruda del modelo. Para entender un fallo raro (respuesta vacía,
 * herramienta mal formada) sin adivinar.
 *
 *   npx tsx bench/debug-case.ts <caso> <URL> <modelo> [vllm|ollama] [razonamiento-chat]
 *   npx tsx bench/debug-case.ts cliente-duplicado http://127.0.0.1:11434/v1 qwen3-5-9b-8k ollama
 */
import { Agent } from '../src/application/agent';
import { OpenAiCompatibleLlm, OpenAiCompatibleServer } from '../src/infrastructure/openai/compatible-llm';
import { createInMemoryRepositories } from '../src/__tests__/helpers';
import { CASES, FixtureCrm, TODAY } from './cases';

async function main() {
  const [caseId, baseURL, model, server = 'ollama', chatReasoning] = process.argv.slice(2);
  const c = CASES.find((x) => x.id === caseId);
  if (!c || c.kind !== 'agent' || !baseURL || !model) throw new Error('Uso: debug-case.ts <caso-de-agente> <URL> <modelo> [vllm|ollama] [razonamiento-chat]');

  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const res = await realFetch(url, init);
    const text = await res.clone().text();
    const req = JSON.parse(String(init.body));
    console.log(`\n── petición: ${req.messages.length} mensajes, último rol ${req.messages.at(-1).role}, extra=${JSON.stringify({ reasoning_effort: req.reasoning_effort, chat_template_kwargs: req.chat_template_kwargs })}`);
    console.log(`── respuesta ${res.status}: ${text.slice(0, 3000)}`);
    return res;
  }) as typeof fetch;

  const llm = new OpenAiCompatibleLlm({
    baseURL,
    model,
    maxTokens: 4000,
    timeoutMs: 180_000,
    server: server as OpenAiCompatibleServer,
    chatReasoning: chatReasoning as never,
  });
  const agent = new Agent(createInMemoryRepositories(), llm, new FixtureCrm(c.routes), { maxIterations: 8, monthlyTokenLimit: 0 });
  const r = await agent.startOrContinue({
    conversationId: null,
    text: c.message,
    ctx: {
      organizationId: 'org-bench',
      userId: 'user-bench',
      bearerToken: 'jwt',
      locale: 'es',
      organization: { organizationName: 'Comercial Quito Cía. Ltda.', countryCode: 'EC', userName: 'Ana', locale: 'es', today: TODAY },
    },
  });
  console.log('\n══ respuesta final:', JSON.stringify(r, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
