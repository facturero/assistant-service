import { describe, expect, it } from 'vitest';
import { Agent } from '../application/agent';
import { buildSystemPrompt } from '../application/prompt';
import { BILLING_PATH_PREFIXES, isBillingWrite, TOOLS } from '../domain/tools';
import { createInMemoryRepositories, ctx, FakeCrmApi, ScriptedLlm, textBlock, toolUseBlock } from './helpers';

const options = { maxIterations: 5, monthlyTokenLimit: 0 };

describe('El asistente no factura', () => {
  it('ninguna herramienta del catálogo escribe en facturación', () => {
    // Si este test falla, alguien le ha dado al asistente una herramienta que
    // emite, anula o modifica facturas. Es una decisión de producto: no.
    const offenders = TOOLS.filter((t) => isBillingWrite(t.method, t.path)).map((t) => t.name);
    expect(offenders).toEqual([]);
  });

  it('consultar facturas sí se puede', () => {
    expect(isBillingWrite('GET', '/invoices')).toBe(false);
    expect(TOOLS.some((t) => t.name === 'listar_facturas' && t.risk === 'read')).toBe(true);
  });

  it('cualquier escritura en las rutas de facturación cuenta como facturar', () => {
    for (const prefix of BILLING_PATH_PREFIXES) {
      for (const method of ['POST', 'PATCH', 'PUT', 'DELETE']) {
        expect(isBillingWrite(method, prefix)).toBe(true);
        expect(isBillingWrite(method, `${prefix}/abc/issue`)).toBe(true);
      }
    }
    // Un prefijo no se confunde con otra ruta que empiece igual.
    expect(isBillingWrite('POST', '/invoices-report')).toBe(false);
  });

  it('el prompt se lo dice al modelo', () => {
    const prompt = buildSystemPrompt(ctx.organization);
    expect(prompt).toMatch(/No facturas/);
    // Y le da el enlace para mandar a la persona a la pantalla que sí factura.
    expect(prompt).toContain('[facturación](/invoices/new)');
  });

  it('si el modelo se inventa una herramienta de facturar, no se llama a nada ni se propone nada', async () => {
    const repos = createInMemoryRepositories();
    const crm = new FakeCrmApi();
    const llm = new ScriptedLlm([
      { content: [toolUseBlock('tu_1', 'crear_factura', { customerId: 'c1', total: 100 })], stopReason: 'tool_use' },
      { content: [textBlock('No puedo emitir facturas; hazlo desde la pantalla de facturación.')] },
    ]);

    const result = await new Agent(repos, llm, crm, options).startOrContinue({
      conversationId: null,
      text: 'factúrale 100 dólares a Acme',
      ctx,
    });

    expect(crm.calls).toHaveLength(0);
    expect(result.pendingActions).toHaveLength(0);
    expect(result.reply).toMatch(/no puedo/i);
  });
});
