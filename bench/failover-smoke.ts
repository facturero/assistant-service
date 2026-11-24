/**
 * Prueba real de la conmutación entre servidores del modelo, con la misma fábrica que usa el servicio.
 *
 *   npx tsx bench/failover-smoke.ts <URL-principal> <URL-respaldo> [modelo]
 *   npx tsx bench/failover-smoke.ts http://127.0.0.1:8001/v1 http://192.168.100.229:8000/v1
 *
 * Con el principal apagado, la respuesta tiene que llegar igual (del respaldo) y el log tiene que decir quién atiende.
 */
import { createOpenAiCompatLlm } from '../src/infrastructure/openai/factory';
import { loadConfig, resolveProvider } from '../src/config';

async function main() {
  const [principal, respaldo, modelo = 'crm-assistant'] = process.argv.slice(2);
  if (!principal || !respaldo) throw new Error('Uso: failover-smoke.ts <URL-principal> <URL-respaldo> [modelo]');
  Object.assign(process.env, {
    ASSISTANT_PROVIDER: 'openai-compat',
    ASSISTANT_BASE_URL: principal,
    ASSISTANT_FALLBACK_BASE_URL: respaldo,
    ASSISTANT_MODEL: modelo,
    OPENAI_COMPAT_SERVER: 'vllm',
    ANTHROPIC_MAX_TOKENS: '4000',
    ASSISTANT_LLM_PROBE_INTERVAL_MS: '2000',
  });
  const config = loadConfig();
  const llm = createOpenAiCompatLlm(config, resolveProvider(config));

  for (let i = 1; i <= 3; i++) {
    const t = Date.now();
    const turno = await llm.complete({
      system: 'Responde en una frase corta en español.',
      messages: [{ role: 'user', content: `Prueba ${i}: di "hola desde el respaldo".` }],
      tools: [],
    });
    const texto = turno.content.map((b) => (b.type === 'text' ? b.text : `[${b.type}]`)).join(' ');
    console.log(`petición ${i}: ${Date.now() - t} ms → ${texto}`);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FALLÓ:', e instanceof Error ? e.message : e);
  process.exit(1);
});
