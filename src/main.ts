import 'dotenv/config';
import { serve } from '@hono/node-server';
import { Sequelize } from 'sequelize';
import { loadConfig, resolveProvider } from './config.js';
import { Agent } from './application/agent.js';
import { ClaudeLlm } from './infrastructure/anthropic/claude-llm.js';
import { OpenAiCompatibleLlm } from './infrastructure/openai/compatible-llm.js';
import { CrmApi } from './infrastructure/http/crm-api.js';
import { initModels } from './infrastructure/persistence/models.js';
import { createRepositories } from './infrastructure/persistence/repositories.js';
import { createApp } from './interface/http/app.js';

async function main(): Promise<void> {
  const config = loadConfig();

  const sequelize = new Sequelize(config.DB_NAME, config.DB_USER, config.DB_PASSWORD, {
    host: config.DB_HOST,
    port: config.DB_PORT,
    dialect: 'mysql',
    logging: false,
    define: { underscored: true, charset: 'utf8mb4' },
  });
  initModels(sequelize);
  await sequelize.authenticate();

  const repos = createRepositories(sequelize);
  const crm = new CrmApi(config.GATEWAY_URL, config.CRM_API_TIMEOUT_MS);
  const provider = resolveProvider(config);
  // Dos protocolos, no dos clientes por capricho: 'anthropic' y 'opencode'
  // hablan la Messages API y comparten adaptador; 'openai-compat' habla el
  // formato de OpenAI y necesita traducción. El agente no nota la diferencia.
  const llm =
    provider.name === 'openai-compat'
      ? new OpenAiCompatibleLlm({
          baseURL: provider.baseURL!,
          apiKey: provider.apiKey || undefined,
          model: provider.model,
          maxTokens: config.ANTHROPIC_MAX_TOKENS,
          timeoutMs: config.ASSISTANT_LLM_TIMEOUT_MS,
        })
      : new ClaudeLlm({
          apiKey: provider.apiKey,
          baseURL: provider.baseURL,
          model: provider.model,
          effort: config.ANTHROPIC_EFFORT,
          maxTokens: config.ANTHROPIC_MAX_TOKENS,
        });

  const agent = new Agent(repos, llm, crm, {
    maxIterations: config.AGENT_MAX_ITERATIONS,
    monthlyTokenLimit: config.ASSISTANT_MONTHLY_TOKEN_LIMIT,
  });

  const app = createApp({ agent, repos, crm, corsOrigin: config.CORS_ORIGIN });
  serve({ fetch: app.fetch, port: config.PORT });

  // Decir por dónde sale el modelo evita la tarde entera depurando por qué la
  // factura crece en la cuenta equivocada.
  console.log(
    `[assistant-service] escuchando en :${config.PORT} con ${provider.model} ` +
      `vía ${provider.name}${provider.baseURL ? ` (${provider.baseURL})` : ''}`,
  );

  const shutdown = async () => {
    console.log('[assistant-service] cerrando...');
    await sequelize.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[assistant-service] no pudo arrancar:', err);
  process.exit(1);
});
