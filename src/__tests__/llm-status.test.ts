import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { LlmHealthStatus } from '../application/ports';
import { createApp } from '../interface/http/app';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock } from './helpers';

/** `GET /assistant/status`: solo números, nunca las direcciones de los servidores, y con el contexto del gateway. */
function setup(health?: { status(): LlmHealthStatus }) {
  const repos = createInMemoryRepositories();
  const crm = new FakeCrmApi();
  const agent = new Agent(repos, new ScriptedLlm([{ content: [textBlock('hola')] }]), crm, { maxIterations: 5, monthlyTokenLimit: 0 });
  return createApp({ agent, repos, crm, health, corsOrigin: '' } as never);
}

const headers = { 'X-Organization-Id': ctx.organizationId, 'X-User-Id': ctx.userId, Authorization: `Bearer ${ctx.bearerToken}` };

describe('GET /assistant/status', () => {
  it('devuelve el estado del sondeo', async () => {
    const status = { available: false, servers: 2, healthy: 0, checkedAt: '2026-11-25T10:00:00.000Z' };
    const res = await setup({ status: () => status }).request('/assistant/status', { headers });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(status);
  });

  it('sin puerto de salud se da por disponible, como antes de existir la ruta', async () => {
    const res = await setup().request('/assistant/status', { headers });
    expect(await res.json()).toMatchObject({ available: true });
  });

  it('exige el contexto que pone el gateway', async () => {
    const res = await setup().request('/assistant/status');
    expect(res.status).toBe(400);
  });
});
