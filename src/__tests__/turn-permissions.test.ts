import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { createApp } from '../interface/http/app';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock } from './helpers';

/**
 * Por el socket del gateway no llega `X-Permissions` (2026-11-25): sin respaldo se le ofrecían al modelo todas las
 * herramientas y quien tenía pocos permisos veía tarjetas que el CRM negaba con 403. El respaldo es `/auth/me`, que ya se
 * pide en cada turno y trae los permisos del token.
 */
function setup(mePermissions: unknown) {
  const llm = new ScriptedLlm([{ content: [textBlock('hola')] }]);
  const crm = new FakeCrmApi((path) =>
    path === '/auth/me'
      ? { ok: true, status: 200, body: { fullName: 'Ana', permissions: mePermissions } }
      : { ok: false, status: 404, body: {} },
  );
  const repos = createInMemoryRepositories();
  const agent = new Agent(repos, llm, crm, { maxIterations: 3, monthlyTokenLimit: 0 });
  const app = createApp({ agent, repos, crm, corsOrigin: '' });
  return { app, llm };
}

const base = { 'X-Organization-Id': ctx.organizationId, 'X-User-Id': ctx.userId, Authorization: `Bearer ${ctx.bearerToken}`, 'Content-Type': 'application/json' };

async function offered(mePermissions: unknown, extraHeaders: Record<string, string> = {}): Promise<string[]> {
  const { app, llm } = setup(mePermissions);
  const res = await app.request('/assistant/messages', {
    method: 'POST',
    headers: { ...base, ...extraHeaders },
    body: JSON.stringify({ text: 'hola' }),
  });
  expect(res.status).toBe(200);
  return (llm.calls[0]!.tools ?? []).map((t) => t.name);
}

describe('permisos con los que se filtran las herramientas', () => {
  it('sin X-Permissions (socket) usa los de /auth/me', async () => {
    const names = await offered(['customer:read']);
    expect(names).toContain('listar_clientes');
    expect(names).not.toContain('invitar_empleado');
    expect(names).not.toContain('crear_rol');
  });

  it('con X-Permissions (proxy HTTP) mandan los de la cabecera', async () => {
    const names = await offered(['customer:read'], { 'X-Permissions': 'user:invite' });
    expect(names).toContain('invitar_empleado');
    expect(names).not.toContain('listar_clientes');
  });

  it('si /auth/me no trae una lista, se ofrecen todas, como antes', async () => {
    const todas = await offered(undefined);
    expect(todas).toContain('listar_clientes');
    expect(todas).toContain('invitar_empleado');
  });
});
