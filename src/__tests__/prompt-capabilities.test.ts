import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, capabilitiesFor, TOOL_CAPABILITIES } from '../application/prompt';
import { availableTools, TOOLS } from '../domain/tools';
import { Agent } from '../application/agent';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock } from './helpers';

/**
 * «¿Qué puedes hacer?» tiene que contestar con lo que ESTA persona puede, no con el catálogo entero (producción,
 * 2026-11-25: a un rol de solo clientes y productos le ofrecía facturas, invitar empleados e inventario).
 */
describe('lo que puede hacer el asistente en esta sesión', () => {
  it('toda herramienta tiene su frase: si no, una herramienta nueva no aparecería en «qué puedes hacer»', () => {
    for (const t of TOOLS) expect(TOOL_CAPABILITIES[t.name], t.name).toBeTruthy();
  });

  it('un rol de solo clientes y productos ve solo eso', () => {
    const names = availableTools(['customer:read', 'product:read'], null).map((t) => t.name);
    const prompt = buildSystemPrompt(ctx.organization, names);
    expect(prompt).toContain('## Lo que puedes hacer en esta sesión');
    expect(prompt).toContain('consultar clientes; consultar productos y precios; consultar el catálogo de permisos');
    const section = prompt.slice(prompt.indexOf('## Lo que puedes hacer'));
    expect(section).not.toMatch(/factura|invitar|inventario|bitácora/);
  });

  it('las frases no se repiten aunque varias herramientas compartan una', () => {
    expect(capabilitiesFor(['listar_clientes', 'ver_cliente', 'listar_tipos_identificacion'])).toEqual(['consultar clientes']);
  });

  it('sin herramientas lo dice, en vez de dejar la lista vacía', () => {
    expect(buildSystemPrompt(ctx.organization, [])).toContain('no tienes herramientas');
  });

  it('el agente manda al modelo la lista de la persona', async () => {
    const llm = new ScriptedLlm([{ content: [textBlock('hola')] }]);
    await new Agent(createInMemoryRepositories(), llm, new FakeCrmApi(), { maxIterations: 3, monthlyTokenLimit: 0 }).startOrContinue({
      conversationId: null,
      text: '¿Qué puedes hacer?',
      ctx: { ...ctx, permissions: ['customer:read'] },
    });
    expect(llm.calls[0]!.system).toContain('puedes: consultar clientes');
    expect(llm.calls[0]!.system).not.toContain('invitar empleados (con su confirmación)');
  });
});
